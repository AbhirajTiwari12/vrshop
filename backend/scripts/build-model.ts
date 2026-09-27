// Build one product's 3D model on purpose (paid image-to-3D), from curated photos and its real size. The only way
// generation runs in 3D-only demo mode. Needs the backend running.
//   npm run model:build -- <productId> [--images url1,url2] [--dims w,d,h] [--model rodin|trellis2|hunyuan]
//                          [--url https://store/page] [--category table_lamp] [--force] [--photo-only] [--server http://localhost:8787]
// --photo-only: free, for rugs and wall art (a flat piece wearing the first photo at true size).
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const id = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--force', '--photo-only'].includes(args[i - 1])));
if (!id) { console.error('usage: npm run model:build -- <productId> [--images a,b] [--dims w,d,h] [--model rodin] [--url ...] [--force]'); process.exit(1); }
const base = (opt('--server') ?? 'http://localhost:8787').replace(/\/$/, '');
const dims = opt('--dims')?.split(',').map(Number);
const body = {
  images: opt('--images')?.split(',').map((s) => s.trim()).filter(Boolean),
  dims: dims && dims.length === 3 ? { w: dims[0], d: dims[1], h: dims[2] } : undefined,
  model: opt('--model'),
  category: opt('--category'),
  productUrl: opt('--url'),
  force: args.includes('--force'),
  photoOnly: args.includes('--photo-only'),
};
const j = async (path: string, init?: RequestInit) => {
  const r = await fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
const t0 = Date.now();
let p = await j(`/api/products/${id}/model/build`, { method: 'POST', body: JSON.stringify(body) });
console.log(`${p.title}\n  ${p.dims ? `${Math.round(p.dims.w * 100)} x ${Math.round(p.dims.d * 100)} x ${Math.round(p.dims.h * 100)} cm` : 'size: estimated'} | photos: ${(p.genImages ?? [p.imageUrl]).length}`);
let last = '';
while (p.model.status !== 'ready' && p.model.status !== 'failed') {
  await new Promise((r) => setTimeout(r, 3000));
  p = await j(`/api/products/${id}`);
  const line = `  ${p.model.status} ${Math.round((p.model.progress ?? 0) * 100)}% ${p.model.message ?? ''}`;
  if (line !== last) { console.log(line); last = line; }
  if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('timed out after 15 min');
}
console.log(`\n${p.model.status === 'ready' ? 'Done' : 'Failed'} in ${Math.round((Date.now() - t0) / 1000)} s: ${p.model.kind} model, ${p.model.triangles ?? '?'} triangles, ${Math.round((p.model.bytes ?? 0) / 1024)} KB${p.model.message ? ` (${p.model.message})` : ''}`);
console.log(`  ${base}${p.model.url ?? ''}`);
process.exit(p.model.status === 'ready' && (p.model.kind === 'generated' || body.photoOnly) ? 0 : 1);
