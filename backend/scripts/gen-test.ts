// Image -> 3D check through the real model pipeline (generation, normalization, true-size scaling), without
// needing SerpAPI: npm run gen-test [-- --image <url> --category sofa --dims 1.234,0.788,0.766]
//
// Defaults to the photo of IKEA's GLOSTAD loveseat, whose official model measures 1.234 x 0.788 x 0.766 m,
// so the generated model can be compared with the real thing. Uses its own data dir (data-gentest/) so it
// never touches the running server's db.json. Costs one paid generation (~$0.25-0.40).
process.env.DATA_DIR ??= 'data-gentest';

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const image = arg('image', 'https://www.ikea.com/us/en/images/products/glostad-loveseat-knisa-dark-gray__1577178_pe1033002_s5.jpg');
const category = arg('category', 'sofa');
const [w, d, h] = arg('dims', '1.234,0.788,0.766').split(',').map(Number);

const { config } = await import('../src/config.js');
const { ensureModel, modelFile } = await import('../src/models/pipeline.js');
const { getProduct, upsertProduct, hash } = await import('../src/store.js');
const { getIO } = await import('../src/models/normalize.js');
const { getBounds } = await import('@gltf-transform/functions');

if (config.gen.provider === 'none') {
  console.error('No image-to-3D provider: set FAL_KEY (or MESHY_API_KEY / TRIPO_API_KEY) in backend/.env');
  process.exit(1);
}
const model = config.gen.provider === 'fal' ? `fal/${config.gen.falModel}` : config.gen.provider;
console.log(`provider ${model}\nimage    ${image}\ntarget   ${category} ${w} x ${d} x ${h} m (w x d x h)`);

// A non-IKEA product (no ikeaItemNo), so the pipeline goes straight to image -> 3D.
const id = `gentest-${hash(`${model}|${image}|${w},${d},${h}`)}`;
upsertProduct({
  id, source: 'google_shopping', store: 'Test', title: `gen-test ${category}`, category,
  price: null, currency: 'USD', priceText: '', imageUrl: image, images: [image], productUrl: image,
  dims: { w, d, h }, dimsSource: 'listing', model: { status: 'none' },
});

const t0 = Date.now();
ensureModel(id, { allowGenerate: true });
let last = '';
for (;;) {
  await new Promise((r) => setTimeout(r, 1000));
  const m = getProduct(id)!.model;
  const line = `${m.status} ${Math.round((m.progress ?? 0) * 100)}% ${m.message ?? ''}`;
  if (line !== last) { process.stdout.write(`\r  ${line.padEnd(60)}`); last = line; }
  if (m.status === 'ready' || m.status === 'failed') break;
}
const p = getProduct(id)!;
console.log(`\n\nresult   ${p.model.kind} in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${((p.model.bytes ?? 0) / 1024).toFixed(0)} KB, ${p.model.triangles ?? '?'} tris`);
if (p.model.message) console.log(`notes    ${p.model.message}`);

// Measure what Unity will load: the normalized GLB.
const doc = await (await getIO()).read(modelFile(id));
const b = getBounds(doc.getRoot().listScenes()[0]);
const size = [b.max[0] - b.min[0], b.max[2] - b.min[2], b.max[1] - b.min[1]];
const pivot = [(b.max[0] + b.min[0]) / 2, b.min[1], (b.max[2] + b.min[2]) / 2];
const err = size.map((s, i) => Math.abs(s - [w, d, h][i]) / [w, d, h][i]);
console.log(`measured ${size.map((s) => s.toFixed(3)).join(' x ')} m  (off by ${err.map((e) => `${(e * 100).toFixed(1)}%`).join(' / ')})`);
console.log(`pivot    x=${pivot[0].toFixed(3)} y=${pivot[1].toFixed(3)} z=${pivot[2].toFixed(3)} (want 0, 0, 0: floor-center)`);
console.log(`file     ${modelFile(id)}`);

const ok = p.model.kind === 'generated' && err.every((e) => e < 0.05) && pivot.every((v) => Math.abs(v) < 0.01);
console.log(ok ? '\nOK: generated model is true-size and floor-centered' : `\nFAIL: ${p.model.kind !== 'generated' ? 'generation failed and fell back to a stand-in (see the warning above)' : 'size or pivot is off'}`);
process.exit(ok ? 0 : 1);
