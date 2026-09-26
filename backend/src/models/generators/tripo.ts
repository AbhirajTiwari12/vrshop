import { config } from '../../config.js';
import { fetchBuffer, fetchJson, sleep } from '../../util/http.js';
import type { GenContext, Progress } from './index.js';

// Tripo (v2 OpenAPI, still documented alongside v3): POST /v2/openapi/task {type:image_to_model, file:{url}}
// -> data.task_id; GET /v2/openapi/task/{id} -> data.status queued|running|success|failed|banned|expired|cancelled
// output GLB at data.output.pbr_model ?? model ?? base_model (URLs expire after ~5 min: download immediately).

const BASE = 'https://api.tripo3d.ai/v2/openapi/task';
const auth = () => ({ Authorization: `Bearer ${config.gen.tripoKey}`, 'Content-Type': 'application/json' });

export async function generateTripo(imageUrl: string, _ctx: GenContext, onProgress: Progress): Promise<Buffer> {
  const type = /\.png(\?|$)/i.test(imageUrl) ? 'png' : 'jpg';
  const body = {
    type: 'image_to_model',
    model_version: process.env.TRIPO_MODEL_VERSION || 'v3.1-20260211',
    file: { type, url: imageUrl },
    texture: true,
    pbr: true,
    face_limit: 40000,
    // 'align_image' would copy the photo's 3/4 camera angle into the model; keep the canonical pose.
    orientation: 'default',
  };
  const created = await fetchJson<any>(BASE, { method: 'POST', headers: auth(), body: JSON.stringify(body), timeoutMs: 30000 });
  if (created.code !== 0) throw new Error(`tripo: ${created.message ?? JSON.stringify(created).slice(0, 200)}`);
  const id = created.data.task_id;
  const started = Date.now();
  for (;;) {
    await sleep(2000);
    const t = await fetchJson<any>(`${BASE}/${id}`, { headers: auth(), timeoutMs: 20000, retries: 2 });
    const d = t.data ?? {};
    if (d.status === 'success') {
      const url = d.output?.pbr_model ?? d.output?.model ?? d.output?.base_model;
      if (!url) throw new Error('tripo: no model url');
      return fetchBuffer(url, { timeoutMs: 120000, retries: 1 });
    }
    if (['failed', 'banned', 'expired', 'cancelled', 'unknown'].includes(d.status)) throw new Error(`tripo: ${d.status} ${d.error_message ?? ''}`);
    onProgress((d.progress ?? 0) / 100, d.status === 'queued' ? 'In queue' : 'Generating 3D');
    if (Date.now() - started > 900_000) throw new Error('tripo: timed out');
  }
}
