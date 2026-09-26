import { config } from '../../config.js';
import { fetchBuffer, fetchJson, sleep } from '../../util/http.js';
import type { GenContext, Progress } from './index.js';

// fal.ai queue API: POST https://queue.fal.run/{model} -> {status_url, response_url}; poll status; GET result.
// One key gives access to TRELLIS.2 (fast, MIT), Hunyuan3D 3.1 Pro (sharp PBR) and Rodin (best fabric, honors bbox).

const auth = () => ({ Authorization: `Key ${config.gen.falKey}`, 'Content-Type': 'application/json' });

interface FalModel { id: string; input: (img: string, ctx: GenContext) => object; glb: (out: any) => string | undefined; expectSec: number }

const MODELS: Record<string, FalModel> = {
  trellis2: {
    id: 'fal-ai/trellis-2',
    input: (image_url) => ({ image_url, resolution: 1024, texture_size: 2048, decimation_target: 60000, remesh: true }),
    glb: (o) => o?.model_glb?.url,
    expectSec: 45,
  },
  hunyuan: {
    id: 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d',
    input: (input_image_url) => ({ input_image_url, generate_type: 'Normal', enable_pbr: true, face_count: 60000 }),
    glb: (o) => o?.model_glb?.url ?? o?.model_urls?.glb?.url ?? o?.model_urls?.glb,
    expectSec: 90,
  },
  rodin: {
    id: 'fal-ai/hyper3d/rodin/v2',
    input: (img, ctx) => ({
      input_image_urls: [img],
      geometry_file_format: 'glb',
      material: 'PBR',
      quality_mesh_option: '20K Triangle',
      // Rodin can lock proportions to the real product box: [width, height, length] in cm.
      bbox_condition: [Math.round(ctx.dims.w * 100), Math.round(ctx.dims.h * 100), Math.round(ctx.dims.d * 100)],
    }),
    glb: (o) => o?.model_mesh?.url,
    expectSec: 120,
  },
};

export async function generateFal(imageUrl: string, ctx: GenContext, onProgress: Progress): Promise<Buffer> {
  const m = MODELS[config.gen.falModel] ?? MODELS.trellis2;
  const sub = await fetchJson<any>(`https://queue.fal.run/${m.id}`, { method: 'POST', headers: auth(), body: JSON.stringify(m.input(imageUrl, ctx)), timeoutMs: 30000 });
  const statusUrl: string = sub.status_url ?? `https://queue.fal.run/${m.id}/requests/${sub.request_id}/status`;
  const responseUrl: string = sub.response_url ?? `https://queue.fal.run/${m.id}/requests/${sub.request_id}`;
  const started = Date.now();
  for (;;) {
    await sleep(2500);
    const st = await fetchJson<any>(statusUrl, { headers: auth(), timeoutMs: 20000, retries: 2 });
    if (st.error) throw new Error(`fal: ${st.error}`);
    if (st.status === 'COMPLETED') break;
    const elapsed = (Date.now() - started) / 1000;
    onProgress(Math.min(0.95, elapsed / m.expectSec), st.status === 'IN_QUEUE' ? `In queue (#${st.queue_position ?? '?'})` : 'Generating 3D');
    if (elapsed > 600) throw new Error('fal: timed out after 10 min');
  }
  const out = await fetchJson<any>(responseUrl, { headers: auth(), timeoutMs: 30000, retries: 2 });
  if (out?.error || out?.detail) throw new Error(`fal: ${JSON.stringify(out.error ?? out.detail).slice(0, 200)}`);
  const url = m.glb(out);
  if (!url) throw new Error(`fal: no GLB in result: ${JSON.stringify(out).slice(0, 200)}`);
  return fetchBuffer(url, { timeoutMs: 120000, retries: 1 });
}
