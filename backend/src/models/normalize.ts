import { Document, Logger, NodeIO, type Material, type Texture } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { center, dedup, dequantize, getBounds, metalRough, normals, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import type { Dims } from '../types.js';
import { round3 } from '../catalog.js';

// Turns any furniture GLB (IKEA official, AI-generated, ...) into a Quest-friendly, Unity glTFast-friendly GLB:
//  - one root node "Product", pivot at floor-center (bbox bottom at y=0, centered in x/z), meters, front = +Z
//  - optionally scaled to the listing's real W x D x H
//  - no Draco / meshopt / WebP / AVIF / quantization (glTFast would need extra packages or can't decode WebP)
//  - exotic material extensions stripped so the build only needs a small, known set of shader variants
//  - textures resized (default 1024) and re-encoded as JPEG (PNG only where alpha matters)
//  - triangle budget enforced with meshopt simplification

let ioPromise: Promise<NodeIO> | null = null;
export function getIO(): Promise<NodeIO> {
  ioPromise ??= (async () =>
    new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'meshopt.decoder': MeshoptDecoder,
      }))();
  return ioPromise;
}

const STRIP_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_mesh_quantization',
  'EXT_texture_webp',
  'EXT_texture_avif',
  'KHR_materials_clearcoat',
  'KHR_materials_sheen',
  'KHR_materials_transmission',
  'KHR_materials_diffuse_transmission',
  'KHR_materials_volume',
  'KHR_materials_ior',
  'KHR_materials_specular',
  'KHR_materials_iridescence',
  'KHR_materials_anisotropy',
  'KHR_materials_dispersion',
  'KHR_materials_emissive_strength',
  'KHR_materials_variants',
  'KHR_lights_punctual',
  'KHR_xmp_json_ld',
  'EXT_mesh_gpu_instancing',
]);

export interface NormalizeOpts {
  /** Scale the model so its bounding box matches these dims (generated models). */
  targetDims?: Dims;
  /** Try to rotate 90° if the footprint is swapped relative to targetDims. */
  fixOrientation?: boolean;
  /** For items without a real front (tables, rugs, poufs): turn the long side to run left-right (X). */
  longSideAlongX?: boolean;
  maxTriangles?: number;
  textureSize?: number;
}

export interface NormalizeResult {
  glb: Buffer;
  dims: Dims;
  triangles: number;
  notes: string[];
}

export async function normalizeGlb(input: Uint8Array, opts: NormalizeOpts = {}): Promise<NormalizeResult> {
  const io = await getIO();
  const doc = await io.readBinary(input);
  doc.setLogger(new Logger(Logger.Verbosity.WARN));
  const notes: string[] = [];
  const root = doc.getRoot();

  // Spec/gloss -> metal/rough before stripping extensions.
  if (root.listExtensionsUsed().some((e) => e.extensionName === 'KHR_materials_pbrSpecularGlossiness')) {
    await doc.transform(metalRough());
    notes.push('converted spec/gloss');
  }
  await doc.transform(dequantize());

  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error('GLB has no scene');
  for (const s of root.listScenes()) if (s !== scene) s.dispose();

  // Wrap everything under one node so a single transform scales/rotates the whole product.
  const product = doc.createNode('Product');
  for (const n of scene.listChildren()) {
    scene.removeChild(n);
    product.addChild(n);
  }
  scene.addChild(product);
  root.listCameras().forEach((c) => c.dispose());
  root.listAnimations().forEach((a) => a.dispose());
  root.listSkins().forEach((s) => s.dispose());

  let b = getBounds(scene);
  let size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  if (size.some((v) => !Number.isFinite(v))) throw new Error('GLB has no geometry');

  const t = opts.targetDims;
  if (opts.longSideAlongX && size[2] > size[0] * 1.1) {
    product.setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    b = getBounds(scene);
    size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    notes.push('turned long side left-right');
  } else if (t && opts.fixOrientation) {
    // If the model's footprint looks swapped (e.g. a sofa generated sideways), rotate 90° around Y.
    const wantWide = t.w / Math.max(t.d, 1e-3);
    const isWide = size[0] / Math.max(size[2], 1e-3);
    if ((wantWide > 1.25 && isWide < 0.8) || (wantWide < 0.8 && isWide > 1.25)) {
      product.setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
      b = getBounds(scene);
      size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
      notes.push('rotated 90° to match listing footprint');
    }
  }

  if (t) {
    const target = [t.w, t.h, t.d];
    const ratios = size.map((s, i) => target[i] / Math.max(s, 1e-4));
    const flat = t.h < 0.05; // rugs, wall art depth: height isn't a reliable anchor
    const anchor = flat ? ratios[0] : ratios[1];
    const perAxisOk = ratios.every((r) => Math.abs(r / anchor - 1) < 0.2);
    const s = perAxisOk ? ratios : [anchor, anchor, anchor];
    if (flat) s[1] = anchor; // keep a flat item's thickness proportional
    const cur = product.getScale();
    product.setScale([cur[0] * s[0], cur[1] * s[1], cur[2] * s[2]]);
    notes.push(perAxisOk ? 'scaled per-axis to listing' : 'scaled uniformly by height');
  }

  // Pivot at floor-center.
  await doc.transform(center({ pivot: 'below' }));

  // Strip extensions we don't want the headset to deal with. Mesh data is already decoded at this point.
  for (const ext of root.listExtensionsUsed()) {
    if (STRIP_EXTENSIONS.has(ext.extensionName)) ext.dispose();
  }

  // Geometry cleanup + triangle budget.
  await doc.transform(dedup(), weld(), normals({ overwrite: false }));
  const tris = countTriangles(doc);
  const budget = opts.maxTriangles ?? 60000;
  if (tris > budget) {
    await MeshoptSimplifier.ready;
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: Math.max(0.05, budget / tris), error: 0.002, lockBorder: false }));
    notes.push(`simplified ${tris} -> ${countTriangles(doc)} tris`);
  }

  for (const m of root.listMaterials()) cleanMaterial(m);
  await reencodeTextures(doc, opts.textureSize ?? 1024);
  await doc.transform(prune());

  const out = await io.writeBinary(doc);
  const fb = getBounds(root.getDefaultScene() ?? root.listScenes()[0]);
  return {
    glb: Buffer.from(out),
    dims: { w: round3(fb.max[0] - fb.min[0]), d: round3(fb.max[2] - fb.min[2]), h: round3(fb.max[1] - fb.min[1]) },
    triangles: countTriangles(doc),
    notes,
  };
}

function cleanMaterial(m: Material) {
  // Very dark/zero emissive is the norm for furniture; drop accidental emissive to keep variants small.
  const e = m.getEmissiveFactor();
  if (!m.getEmissiveTexture() && e.every((v) => v < 0.02)) m.setEmissiveFactor([0, 0, 0]);
  // Generated models sometimes ship BLEND for fully opaque textures; opaque renders faster and sorts correctly.
  if (m.getAlphaMode() === 'BLEND' && m.getBaseColorFactor()[3] > 0.98 && !m.getBaseColorTexture()) m.setAlphaMode('OPAQUE');
}

async function reencodeTextures(doc: Document, maxSize: number) {
  const root = doc.getRoot();
  const alphaUse = new Set<Texture>();
  for (const m of root.listMaterials()) {
    const bc = m.getBaseColorTexture();
    if (bc && m.getAlphaMode() !== 'OPAQUE') alphaUse.add(bc);
  }
  for (const tex of root.listTextures()) {
    const img = tex.getImage();
    if (!img) { tex.dispose(); continue; }
    try {
      let pipeline = sharp(Buffer.from(img), { failOn: 'none' }).resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true });
      if (alphaUse.has(tex)) {
        const buf = await pipeline.png({ compressionLevel: 9 }).toBuffer();
        tex.setImage(new Uint8Array(buf)).setMimeType('image/png').setURI(`${tex.getName() || 'tex'}.png`);
      } else {
        const buf = await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
        tex.setImage(new Uint8Array(buf)).setMimeType('image/jpeg').setURI(`${tex.getName() || 'tex'}.jpg`);
      }
    } catch (e) {
      // Undecodable (e.g. KTX2/basis) texture: drop it rather than ship something the headset can't read.
      tex.dispose();
    }
  }
}

export function countTriangles(doc: Document): number {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      if (p.getMode() !== 4) continue; // TRIANGLES
      const idx = p.getIndices();
      n += idx ? idx.getCount() / 3 : (p.getAttribute('POSITION')?.getCount() ?? 0) / 3;
    }
  }
  return Math.round(n);
}
