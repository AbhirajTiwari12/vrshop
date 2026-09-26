import { config } from '../../config.js';
import { fetchBuffer, fetchJson, sleep } from '../../util/http.js';
import type { GenContext, Progress } from './index.js';

// Meshy image-to-3D: POST /openapi/v1/image-to-3d -> {result: taskId}; GET /openapi/v1/image-to-3d/{id}
// status PENDING|IN_PROGRESS|SUCCEEDED|FAILED|CANCELED, progress 0..100, GLB at model_urls.glb (signed URL).

const BASE = 'https://api.meshy.ai/openapi/v1/image-to-3d';
const auth = () => ({ Authorization: `Bearer ${config.gen.meshyKey}`, 'Content-Type': 'application/json' });

export async function generateMeshy(imageUrl: string, _ctx: GenContext, onProgress: Progress): Promise<Buffer> {
  const body = {
    image_url: imageUrl,
    ai_model: 'latest',
    should_texture: true,
    enable_pbr: true,
    should_remesh: true,
    topology: 'triangle',
    target_polycount: 40000,
    target_formats: ['glb'],
  };
  const created = await fetchJson<{ result: string }>(BASE, { method: 'POST', headers: auth(), body: JSON.stringify(body), timeoutMs: 30000 });
  const id = created.result;
  const started = Date.now();
  for (;;) {
    await sleep(3000);
    const t = await fetchJson<any>(`${BASE}/${id}`, { headers: auth(), timeoutMs: 20000, retries: 2 });
    if (t.status === 'SUCCEEDED') {
      const url = t.model_urls?.glb;
      if (!url) throw new Error('meshy: no GLB url');
      return fetchBuffer(url, { timeoutMs: 120000, retries: 1 });
    }
    if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(`meshy: ${t.task_error?.message ?? t.status}`);
    onProgress((t.progress ?? 0) / 100, t.status === 'PENDING' ? 'In queue' : 'Generating 3D');
    if (Date.now() - started > 900_000) throw new Error('meshy: timed out');
  }
}
