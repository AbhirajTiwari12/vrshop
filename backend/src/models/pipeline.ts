import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { categoryDef } from '../catalog.js';
import { dirs, getProduct, updateProduct } from '../store.js';
import { BROWSER_UA, fetchBuffer } from '../util/http.js';
import { log, errMsg } from '../util/log.js';
import { ikeaHasModel, ikeaModelUrl, fetchIkeaDims } from '../search/ikea.js';
import { estimateDims } from '../ai/dims.js';
import { normalizeGlb } from './normalize.js';
import { buildStandin, dominantColor } from './standin.js';
import { generateModel } from './generators/index.js';
import type { Dims, ModelInfo, Product } from '../types.js';

// Resolves a Quest-ready GLB for any product, best source first:
//   1. IKEA official model (true geometry + PBR, true scale)
//   2. Image-to-3D generation from the listing photo (fal / Meshy / Tripo), scaled to listing dims
//   3. Procedural stand-in of the right size and color (always succeeds)

// Items with no meaningful front: orient the long side left-right so layouts read naturally.
const SYMMETRIC = new Set(['coffee_table', 'dining_table', 'rug', 'side_table', 'ottoman']);

const running = new Map<string, Promise<void>>();
const queue: { id: string; heavy: boolean }[] = [];
let activeLight = 0;
let activeHeavy = 0;
const MAX_LIGHT = 4; // downloads + normalize
const MAX_HEAVY = 2; // paid generation jobs

export const modelFile = (productId: string) => path.join(dirs.models, `${productId}.glb`);

function setModel(id: string, patch: Partial<ModelInfo>) {
  const p = getProduct(id);
  if (!p) return;
  updateProduct(id, { model: { ...p.model, ...patch } });
}

/** Kick off (or report) model preparation. `allowGenerate` = false only uses free sources. */
export function ensureModel(productId: string, opts: { allowGenerate?: boolean } = {}): ModelInfo {
  const p = getProduct(productId);
  if (!p) throw new Error(`Unknown product ${productId}`);
  const allowGenerate = opts.allowGenerate ?? true;
  const canGenerate = allowGenerate && config.gen.provider !== 'none';
  // A stand-in is only a placeholder: upgrade it when generation is requested and available.
  const upgrade = p.model.kind === 'standin' && canGenerate;
  if (p.model.status === 'ready' && fs.existsSync(modelFile(productId)) && !upgrade) return p.model;
  if (running.has(productId) || queue.some((q) => q.id === productId)) return p.model;
  const heavy = canGenerate;
  setModel(productId, { status: 'queued', progress: 0, message: 'Queued' });
  queue.push({ id: productId, heavy });
  pump();
  return getProduct(productId)!.model;
}

function pump() {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    if (job.heavy ? activeHeavy >= MAX_HEAVY : activeLight >= MAX_LIGHT) continue;
    queue.splice(i--, 1);
    job.heavy ? activeHeavy++ : activeLight++;
    const pr = prepare(job.id, job.heavy)
      .catch((e) => log.error('model', `${job.id}: ${errMsg(e)}`))
      .finally(() => {
        job.heavy ? activeHeavy-- : activeLight--;
        running.delete(job.id);
        pump();
      });
    running.set(job.id, pr);
  }
}

async function prepare(id: string, allowGenerate: boolean) {
  const p = getProduct(id)!;
  const t0 = Date.now();
  setModel(id, { status: 'processing', progress: 0.05, message: 'Starting' });

  // 1) IKEA official
  if (p.ikeaItemNo) {
    try {
      if (await ikeaHasModel(p.ikeaItemNo)) {
        setModel(id, { progress: 0.2, message: 'Downloading IKEA 3D model' });
        const raw = await fetchBuffer(ikeaModelUrl(p.ikeaItemNo), { headers: { 'User-Agent': BROWSER_UA }, retries: 1 });
        fs.writeFileSync(path.join(dirs.raw, `${id}.glb`), raw);
        setModel(id, { progress: 0.6, message: 'Optimizing for Quest' });
        const out = await normalizeGlb(raw, { maxTriangles: 80000, textureSize: 1024, longSideAlongX: SYMMETRIC.has(p.category) });
        return finish(id, out.glb, 'official', out.dims, 'model', out.triangles, t0, out.notes);
      }
    } catch (e) {
      log.warn('model', `${id} IKEA model failed: ${errMsg(e)}`);
    }
  }

  // Dimensions for everything else: listing -> IKEA page -> AI estimate -> category default (no paid searches)
  const dims = await resolveDims(p);

  // 2) Image -> 3D
  if (allowGenerate && config.gen.provider !== 'none') {
    try {
      const imageUrl = await bestImage(p);
      setModel(id, { progress: 0.1, message: `Generating 3D (${config.gen.provider})` });
      const raw = await generateModel(imageUrl, { dims, category: p.category, title: p.title }, (f, msg) =>
        setModel(id, { progress: 0.1 + f * 0.75, message: msg ?? 'Generating 3D' }),
      );
      fs.writeFileSync(path.join(dirs.raw, `${id}.glb`), raw);
      setModel(id, { progress: 0.9, message: 'Scaling to real size' });
      const out = await normalizeGlb(raw, { targetDims: dims, fixOrientation: true, longSideAlongX: SYMMETRIC.has(p.category), maxTriangles: 60000, textureSize: 1024 });
      return finish(id, out.glb, 'generated', dims, getProduct(id)!.dimsSource ?? 'estimated', out.triangles, t0, out.notes);
    } catch (e) {
      log.warn('model', `${id} generation failed, using stand-in: ${errMsg(e)}`);
    }
  }

  // 3) Stand-in
  setModel(id, { progress: 0.5, message: 'Building stand-in' });
  let img: Buffer | null = null;
  try { img = await fetchBuffer(p.imageUrl, { headers: { 'User-Agent': BROWSER_UA }, timeoutMs: 15000 }); } catch { /* tint fallback */ }
  const glb = await buildStandin({ category: p.category, dims, imageBuffer: img, color: (await dominantColor(img)) ?? undefined });
  return finish(id, glb, 'standin', dims, getProduct(id)!.dimsSource ?? 'estimated', undefined, t0, []);
}

function finish(id: string, glb: Buffer, kind: ModelInfo['kind'], dims: Dims, dimsSource: Product['dimsSource'], triangles: number | undefined, t0: number, notes: string[]) {
  fs.writeFileSync(modelFile(id), glb);
  const p = getProduct(id)!;
  // Official models are measured truth; otherwise keep listing dims if we had them.
  const patch: Partial<Product> = kind === 'official' || !p.dims ? { dims, dimsSource } : {};
  updateProduct(id, {
    ...patch,
    model: { status: 'ready', kind, url: `/models/${id}.glb?v=${Date.now().toString(36)}`, progress: 1, message: notes.join('; ') || undefined, triangles, bytes: glb.length },
  });
  log.info('model', `${id} ready (${kind}, ${(glb.length / 1024).toFixed(0)} KB, ${triangles ?? '?'} tris, ${Date.now() - t0} ms)`);
}

async function resolveDims(p: Product): Promise<Dims> {
  if (p.dims) return p.dims;
  let dims: Dims | null = null;
  let source: Product['dimsSource'] = 'listing';
  if (p.ikeaItemNo) dims = await fetchIkeaDims(p.productUrl);
  if (!dims) {
    dims = await estimateDims(p.title, p.category);
    source = 'estimated';
  }
  if (!dims) {
    dims = categoryDef(p.category).dims;
    source = 'estimated';
  }
  updateProduct(p.id, { dims, dimsSource: source });
  return dims;
}

async function bestImage(p: Product): Promise<string> {
  // Prefer a larger studio shot when the immersive API gave us extra images.
  const fresh = getProduct(p.id) ?? p;
  const candidates = [...fresh.images, fresh.imageUrl].filter(Boolean);
  // IKEA: the MAIN image is the clean studio shot; its URL has a size suffix we can bump.
  const main = candidates[0];
  return main.includes('ikea.com') ? main.replace(/_s\d(\.\w+)$/, '_s5$1') : main;
}
