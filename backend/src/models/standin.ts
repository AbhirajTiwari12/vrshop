import { Document, type Material } from '@gltf-transform/core';
import sharp from 'sharp';
import { categoryDef } from '../catalog.js';
import type { Dims } from '../types.js';
import { getIO } from './normalize.js';

// Procedural, true-to-size stand-in models. Used when a product has no official 3D model and
// image-to-3D is unavailable or failed. Shapes are simple but proportioned per category, tinted with
// the product photo's dominant color; rugs and wall art carry the product photo as their texture.

type V3 = [number, number, number];

class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  private quad(a: V3, b: V3, c: V3, d: V3, n: V3, uvs: [number, number][] = [[0, 1], [1, 1], [1, 0], [0, 0]]) {
    const base = this.pos.length / 3;
    for (const [i, p] of [a, b, c, d].entries()) {
      this.pos.push(...p);
      this.nor.push(...n);
      this.uv.push(...uvs[i]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Axis-aligned box from bottom-center point (x, y, z) with size (w, h, d). */
  box(x: number, y: number, z: number, w: number, h: number, d: number) {
    const x0 = x - w / 2, x1 = x + w / 2, y0 = y, y1 = y + h, z0 = z - d / 2, z1 = z + d / 2;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]); // front (+Z)
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]); // back
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]); // left
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]); // right
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]); // top
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]); // bottom
  }

  /** Top face only, UV-mapped 0..1 across the rectangle (for rugs). */
  topFace(w: number, d: number, y: number) {
    this.quad([-w / 2, y, d / 2], [w / 2, y, d / 2], [w / 2, y, -d / 2], [-w / 2, y, -d / 2], [0, 1, 0]);
  }

  /** Front face only (for wall art / mirror). */
  frontFace(w: number, h: number, y: number, z: number) {
    this.quad([-w / 2, y, z], [w / 2, y, z], [w / 2, y + h, z], [-w / 2, y + h, z], [0, 0, 1], [[0, 1], [1, 1], [1, 0], [0, 0]]);
  }

  /** Cylinder (or cone if r1 != r0) standing on (x, y, z). */
  cylinder(x: number, y: number, z: number, r0: number, r1: number, h: number, seg = 20, caps = true) {
    const base = this.pos.length / 3;
    const slope = (r0 - r1) / h;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const cx = Math.sin(a), cz = Math.cos(a);
      const len = Math.hypot(1, slope);
      for (const [r, yy] of [[r0, y], [r1, y + h]] as const) {
        this.pos.push(x + cx * r, yy, z + cz * r);
        this.nor.push(cx / len, slope / len, cz / len);
        this.uv.push(i / seg, yy === y ? 1 : 0);
      }
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    if (caps) {
      for (const [r, yy, ny] of [[r1, y + h, 1], [r0, y, -1]] as const) {
        if (r <= 0) continue;
        const c = this.pos.length / 3;
        this.pos.push(x, yy, z); this.nor.push(0, ny, 0); this.uv.push(0.5, 0.5);
        for (let i = 0; i <= seg; i++) {
          const a = (i / seg) * Math.PI * 2;
          this.pos.push(x + Math.sin(a) * r, yy, z + Math.cos(a) * r); this.nor.push(0, ny, 0); this.uv.push(0.5 + Math.sin(a) / 2, 0.5 + Math.cos(a) / 2);
        }
        for (let i = 0; i < seg; i++) ny > 0 ? this.idx.push(c, c + 1 + i, c + 2 + i) : this.idx.push(c, c + 2 + i, c + 1 + i);
      }
    }
  }

  sphere(x: number, y: number, z: number, r: number, seg = 14, rings = 10) {
    const base = this.pos.length / 3;
    for (let j = 0; j <= rings; j++) {
      const v = j / rings, phi = v * Math.PI;
      for (let i = 0; i <= seg; i++) {
        const u = i / seg, th = u * Math.PI * 2;
        const nx = Math.sin(phi) * Math.sin(th), ny = Math.cos(phi), nz = Math.sin(phi) * Math.cos(th);
        this.pos.push(x + nx * r, y + ny * r, z + nz * r);
        this.nor.push(nx, ny, nz);
        this.uv.push(u, v);
      }
    }
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < seg; i++) {
        const a = base + j * (seg + 1) + i, b = a + seg + 1;
        this.idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  get empty() { return this.idx.length === 0; }
}

export interface StandinInput { category: string; dims: Dims; imageUrl?: string; imageBuffer?: Buffer | null; color?: [number, number, number] }

export async function buildStandin(input: StandinInput): Promise<Buffer> {
  const { w, d, h } = input.dims;
  const def = categoryDef(input.category);
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  const root = doc.createNode('Product');
  scene.addChild(root);
  doc.getRoot().setDefaultScene(scene);

  const main = input.color ?? (await dominantColor(input.imageBuffer)) ?? [0.62, 0.58, 0.54];
  const mat = (name: string, c: number[], rough = 0.8, metal = 0) =>
    doc.createMaterial(name).setBaseColorFactor([c[0], c[1], c[2], 1]).setRoughnessFactor(rough).setMetallicFactor(metal);
  const body = mat('Body', main);
  const accent = mat('Accent', main.map((v) => v * 0.35), 0.6);
  const light = mat('Light', [1, 0.93, 0.8], 0.9);
  const green = mat('Leaves', [0.22, 0.42, 0.2], 0.9);
  const white = mat('Linen', [0.93, 0.92, 0.9], 0.95);

  const parts = new Map<Material, MeshBuilder>();
  const mb = (m: Material) => { if (!parts.has(m)) parts.set(m, new MeshBuilder()); return parts.get(m)!; };
  const leg = Math.min(0.05, w * 0.06);

  switch (def.shape) {
    case 'sofa': {
      const arm = Math.min(0.2, w * 0.1), seatH = h * 0.48, backD = Math.min(0.22, d * 0.25);
      mb(accent).box(-w / 2 + arm, 0, -d / 2 + 0.06, 0.04, 0.1, 0.04); mb(accent).box(w / 2 - arm, 0, -d / 2 + 0.06, 0.04, 0.1, 0.04);
      mb(accent).box(-w / 2 + arm, 0, d / 2 - 0.06, 0.04, 0.1, 0.04); mb(accent).box(w / 2 - arm, 0, d / 2 - 0.06, 0.04, 0.1, 0.04);
      mb(body).box(0, 0.1, 0, w, seatH - 0.1, d);                                   // base + seat
      mb(body).box(0, seatH, -d / 2 + backD / 2, w - 2 * arm, h - seatH, backD);     // back
      mb(body).box(-w / 2 + arm / 2, seatH, 0, arm, h * 0.2, d);                     // arms
      mb(body).box(w / 2 - arm / 2, seatH, 0, arm, h * 0.2, d);
      const n = w > 1.6 ? 3 : 2, cw = (w - 2 * arm) / n;                             // cushions
      for (let i = 0; i < n; i++) mb(body).box(-w / 2 + arm + cw * (i + 0.5), seatH, backD / 2, cw - 0.02, 0.06, d - backD - 0.02);
      break;
    }
    case 'chair': {
      const seatH = Math.min(0.47, h * 0.5);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) mb(accent).box(sx * (w / 2 - leg), 0, sz * (d / 2 - leg), leg, seatH, leg);
      mb(body).box(0, seatH, 0, w, 0.08, d);
      mb(body).box(0, seatH + 0.08, -d / 2 + 0.05, w, h - seatH - 0.08, 0.1);
      break;
    }
    case 'table': {
      const top = Math.min(0.04, h * 0.1);
      mb(body).box(0, h - top, 0, w, top, d);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) mb(accent).box(sx * (w / 2 - leg * 1.5), 0, sz * (d / 2 - leg * 1.5), leg, h - top, leg);
      break;
    }
    case 'lamp': {
      const r = Math.min(w, d) / 2;
      mb(accent).cylinder(0, 0, 0, r * 0.6, r * 0.6, 0.03);
      mb(accent).cylinder(0, 0.03, 0, 0.012, 0.012, h * 0.78, 10, false);
      mb(light).cylinder(0, h * 0.78, 0, r, r * 0.75, h * 0.22, 24);
      break;
    }
    case 'rug':
      mb(body).topFace(w, d, Math.max(0.005, h));
      mb(body).box(0, 0, 0, w, Math.max(0.004, h) - 0.001, d);
      break;
    case 'shelf': {
      const t = 0.02, shelves = Math.max(3, Math.round(h / 0.38));
      mb(body).box(-w / 2 + t / 2, 0, 0, t, h, d); mb(body).box(w / 2 - t / 2, 0, 0, t, h, d);
      mb(body).box(0, 0, -d / 2 + t / 2, w, h, t);
      for (let i = 0; i <= shelves; i++) mb(body).box(0, Math.min(h - t, (h / shelves) * i), 0, w - 2 * t, t, d);
      break;
    }
    case 'bed': {
      const baseH = Math.min(0.35, h * 0.35);
      mb(body).box(0, 0, 0.04, w, baseH, d - 0.08);
      mb(white).box(0, baseH, 0.05, w - 0.06, 0.22, d - 0.14);
      mb(body).box(0, 0, -d / 2 + 0.04, w, h, 0.08);
      mb(white).box(-w / 4, baseH + 0.22, -d / 2 + 0.3, w * 0.4, 0.12, 0.35); mb(white).box(w / 4, baseH + 0.22, -d / 2 + 0.3, w * 0.4, 0.12, 0.35);
      break;
    }
    case 'plant': {
      const r = Math.min(w, d) / 2, potH = Math.min(0.35, h * 0.3);
      mb(accent).cylinder(0, 0, 0, r * 0.5, r * 0.65, potH, 20);
      const fr = r * 0.9;
      mb(green).sphere(0, potH + (h - potH) * 0.55, 0, fr);
      mb(green).sphere(fr * 0.4, potH + (h - potH) * 0.35, fr * 0.2, fr * 0.7);
      mb(green).sphere(-fr * 0.35, potH + (h - potH) * 0.75, -fr * 0.15, fr * 0.65);
      break;
    }
    case 'panel':
      mb(accent).box(0, 0, -Math.max(0.02, d) / 2, w, h, Math.max(0.02, d));
      mb(body).frontFace(w * 0.94, h * 0.94, h * 0.03, 0.001);
      break;
    case 'cylinder':
      mb(body).cylinder(0, 0, 0, Math.min(w, d) / 2, Math.min(w, d) / 2, h, 28);
      break;
    default: {
      mb(body).box(0, 0.06, 0, w, h - 0.06, d);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) mb(accent).box(sx * (w / 2 - leg), 0, sz * (d / 2 - leg), leg, 0.06, leg);
      const rows = Math.max(1, Math.round(h / 0.3));
      for (let i = 1; i < rows; i++) mb(accent).box(0, 0.06 + ((h - 0.06) / rows) * i, d / 2, w * 0.98, 0.006, 0.004); // drawer lines
    }
  }

  // Photo texture on rugs and wall art (the listing photo usually IS the design).
  if ((def.shape === 'rug' || (def.shape === 'panel' && def.key !== 'mirror')) && input.imageBuffer) {
    try {
      const jpg = await sharp(input.imageBuffer).resize(1024, 1024, { fit: 'inside' }).flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();
      const tex = doc.createTexture('Photo').setImage(new Uint8Array(jpg)).setMimeType('image/jpeg');
      body.setBaseColorTexture(tex).setBaseColorFactor([1, 1, 1, 1]);
    } catch { /* keep tint */ }
  }
  if (def.key === 'mirror') body.setBaseColorFactor([0.85, 0.87, 0.9, 1]).setMetallicFactor(1).setRoughnessFactor(0.05);

  for (const [material, b] of parts) {
    if (b.empty) continue;
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(b.pos)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(b.nor)).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(b.uv)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(b.idx)).setBuffer(buffer))
      .setMaterial(material);
    root.addChild(doc.createNode(material.getName()).setMesh(doc.createMesh(material.getName()).addPrimitive(prim)));
  }
  const io = await getIO();
  return Buffer.from(await io.writeBinary(doc));
}

/** Average color of the product photo, ignoring the near-white studio background. Linear 0..1. */
export async function dominantColor(img?: Buffer | null): Promise<[number, number, number] | null> {
  if (!img) return null;
  try {
    const { data, info } = await sharp(img).resize(48, 48, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const R = data[i], G = data[i + 1], B = data[i + 2];
      if (R > 232 && G > 232 && B > 232) continue; // background
      r += R; g += G; b += B; n++;
    }
    if (n < 30) return null;
    const lin = (v: number) => Math.pow(v / n / 255, 2.2);
    return [lin(r), lin(g), lin(b)];
  } catch {
    return null;
  }
}
