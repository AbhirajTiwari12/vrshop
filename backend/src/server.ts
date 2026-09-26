import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { baseUrl, capabilities, config, PUBLIC_DIR } from './config.js';
import { dirs, getProduct, getSession, hash, listSessions, saveSession, updateProduct } from './store.js';
import { createSession, expandSession, sessionSearch } from './session.js';
import { ensureModel, modelFile } from './models/pipeline.js';
import { solveLayout, defaultGeometry, type LayoutItem } from './layout.js';
import { categoryDef } from './catalog.js';
import { transcribe, hasOpenAI } from './ai/openai.js';
import { voiceIntent } from './ai/designer.js';
import { immersiveDetails } from './search/serp.js';
import { BROWSER_UA, fetchBuffer } from './util/http.js';
import { log, errMsg } from './util/log.js';
import type { Placement, RoomGeometry } from './types.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  if (req.path.startsWith('/api/') && !(req.method === 'GET' && (req.path.startsWith('/api/img') || req.path.startsWith('/api/products/')))) log.info('http', `${req.method} ${req.path}`);
  next();
});

const upload = multer({
  storage: multer.diskStorage({
    destination: dirs.uploads,
    filename: (_req, file, cb) => cb(null, `${Date.now().toString(36)}-${hash(file.originalname + Math.random(), 6)}${path.extname(file.originalname || '.jpg').toLowerCase() || '.jpg'}`),
  }),
  limits: { files: 12, fileSize: 25 * 1024 * 1024 },
});
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const need = <T>(v: T | undefined | null, what: string): T => {
  if (v == null) throw Object.assign(new Error(`${what} not found`), { status: 404 });
  return v;
};

// ---------------------------------------------------------------------------- health / config
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, baseUrl: baseUrl(), capabilities: capabilities(), models: { vision: config.openai.visionModel, fast: config.openai.model } });
});

// ---------------------------------------------------------------------------- sessions
app.post('/api/sessions', upload.array('photos', 12), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  // Normalize phone photos (HEIC-free JPEGs from Safari, EXIF rotation) to modest JPEGs.
  const photoFiles: string[] = [];
  for (const f of files) {
    const out = f.path.replace(/\.[^.]+$/, '') + '.web.jpg';
    try {
      await sharp(f.path).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(out);
      photoFiles.push(out);
    } catch (e) {
      log.warn('upload', `could not read ${f.originalname}: ${errMsg(e)}`);
    }
  }
  const budget = Number(req.body?.budget) > 0 ? Number(req.body.budget) : null;
  const s = createSession({ prompt: String(req.body?.prompt ?? '').slice(0, 600), budget, photoFiles, photoUrls: photoFiles.map((p) => `/uploads/${path.basename(p)}`) });
  res.json(expandSession(s));
});

app.post('/api/sessions/demo', (req, res) => {
  const prompt = String(req.body?.prompt ?? 'Cozy Scandinavian living room with warm wood, soft textiles and plants');
  const budget = Number(req.body?.budget) > 0 ? Number(req.body.budget) : 1500;
  res.json(expandSession(createSession({ prompt, budget, photoFiles: [], photoUrls: [] })));
});

app.get('/api/sessions', (_req, res) => {
  res.json(listSessions().slice(0, 20).map((s) => ({ id: s.id, createdAt: s.createdAt, status: s.status, prompt: s.prompt, roomType: s.room?.roomType ?? null, photos: s.photos.slice(0, 1) })));
});

app.get('/api/sessions/latest', (_req, res) => {
  const s = listSessions().find((x) => x.status !== 'error') ?? listSessions()[0];
  if (!s) return void res.status(404).json({ error: 'No sessions yet. Create one from the phone app or POST /api/sessions/demo.' });
  res.json(expandSession(s));
});

app.get('/api/sessions/:id', (req, res) => {
  const s = need(getSession(String(req.params.id)), 'Session');
  const since = Number(req.query.since);
  if (since && since >= s.updatedAt) return void res.json({ unchanged: true, updatedAt: s.updatedAt });
  res.json(expandSession(s));
});

app.post('/api/sessions/:id/search', async (req, res) => {
  need(getSession(String(req.params.id)), 'Session');
  const text = String(req.body?.text ?? '').trim();
  if (!text) return void res.status(400).json({ error: 'text required' });
  const { intent, result } = await sessionSearch(String(req.params.id), text);
  res.json({ intent, result, session: expandSession(getSession(String(req.params.id))!) });
});

app.post('/api/sessions/:id/voice', audioUpload.single('audio'), async (req, res) => {
  need(getSession(String(req.params.id)), 'Session');
  const file = req.file;
  let transcript = String(req.body?.text ?? '').trim();
  if (!transcript) {
    if (!file) return void res.status(400).json({ error: 'audio file (field "audio") or text required' });
    if (!hasOpenAI()) return void res.status(400).json({ error: 'Voice needs OPENAI_API_KEY on the server' });
    transcript = await transcribe(file.buffer, file.originalname || 'speech.wav');
  }
  if (!transcript) return void res.json({ transcript: '', reply: "Sorry, I didn't catch that." });
  const s = getSession(String(req.params.id))!;
  const intent = await voiceIntent(transcript, s.room);
  const { result } = await sessionSearch(String(req.params.id), transcript, intent, 'voice');
  const cur = getSession(String(req.params.id))!;
  saveSession({ ...cur, voice: [...cur.voice, { at: Date.now(), transcript, query: intent.query }].slice(-20) });
  res.json({ transcript, reply: intent.reply, atPointer: intent.atPointer, result, session: expandSession(getSession(String(req.params.id))!) });
});

app.post('/api/sessions/:id/geometry', (req, res) => {
  const s = need(getSession(String(req.params.id)), 'Session');
  const g = req.body as RoomGeometry;
  if (!Array.isArray(g?.floorPolygon)) return void res.status(400).json({ error: 'floorPolygon required' });
  saveSession({ ...s, geometry: g });
  const xs = g.floorPolygon.map((p) => p.x), zs = g.floorPolygon.map((p) => p.z);
  log.info('geometry', `${s.id}: ${g.walls?.length ?? 0} walls, ${g.objects?.length ?? 0} objects, ~${(Math.max(...xs) - Math.min(...xs)).toFixed(1)} x ${(Math.max(...zs) - Math.min(...zs)).toFixed(1)} m`);
  res.json({ ok: true });
});

app.post('/api/sessions/:id/layout', (req, res) => {
  const s = need(getSession(String(req.params.id)), 'Session');
  const ids: string[] = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
  const geo: RoomGeometry = s.geometry ?? defaultGeometry(req.body?.user);
  if (req.body?.user) geo.user = req.body.user;
  const items: LayoutItem[] = ids
    .map((id) => getProduct(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => {
      const cat = s.categories.find((c) => c.productIds.includes(p.id));
      return { productId: p.id, category: p.category, dims: p.dims ?? categoryDef(p.category).dims, anchor: cat?.placement.anchor, near: cat?.placement.near };
    });
  const placements = solveLayout(geo, items);
  saveSession({ ...s, placements });
  res.json({ placements, usedDefaultRoom: !s.geometry });
});

app.put('/api/sessions/:id/placements', (req, res) => {
  const s = need(getSession(String(req.params.id)), 'Session');
  const placements: Placement[] = Array.isArray(req.body?.placements) ? req.body.placements : [];
  saveSession({ ...s, placements });
  res.json({ ok: true });
});

app.post('/api/sessions/:id/cart', (req, res) => {
  const s = need(getSession(String(req.params.id)), 'Session');
  const productId = String(req.body?.productId ?? '');
  const p = need(getProduct(productId), 'Product');
  const qty = Math.max(0, Math.min(20, Number(req.body?.qty ?? 1)));
  const existing = s.cart.find((c) => c.productId === productId);
  const cart = qty === 0
    ? s.cart.filter((c) => c.productId !== productId)
    : existing
      ? s.cart.map((c) => (c.productId === productId ? { ...c, qty } : c))
      : [...s.cart, { productId, qty, addedAt: Date.now() }];
  saveSession({ ...s, cart });
  // Resolve the direct store link in the background (Google Shopping links point to Google first).
  if (qty > 0 && !p.storeLinkResolved && p.serpImmersiveToken) {
    void immersiveDetails(p.serpImmersiveToken).then((d) => {
      if (d?.storeUrl) updateProduct(p.id, { productUrl: d.storeUrl, storeLinkResolved: true, store: d.store ?? p.store });
    });
  }
  res.json(expandSession(getSession(s.id)!));
});

// ---------------------------------------------------------------------------- products & models
app.get('/api/products/:id', (req, res) => {
  res.json(need(getProduct(String(req.params.id)), 'Product'));
});

app.post('/api/products/:id/model', (req, res) => {
  need(getProduct(String(req.params.id)), 'Product');
  const model = ensureModel(String(req.params.id), { allowGenerate: req.body?.generate !== false });
  res.json({ ...getProduct(String(req.params.id))!, model });
});

app.get('/models/:file', (req, res) => {
  const id = String(req.params.file).replace(/\.glb$/, '');
  const f = modelFile(id);
  if (!/^[\w-]+$/.test(id) || !fs.existsSync(f)) return void res.status(404).end();
  res.setHeader('Content-Type', 'model/gltf-binary');
  res.setHeader('Cache-Control', 'public, max-age=300');
  fs.createReadStream(f).pipe(res);
});

// Image proxy: Unity can only decode JPEG/PNG, many store thumbnails are WebP/AVIF, and some CDNs block non-browser clients.
app.get('/api/img', async (req, res) => {
  const u = String(req.query.u ?? '');
  const w = Math.max(64, Math.min(1024, Number(req.query.w) || 384));
  if (!/^https?:\/\//.test(u) && !u.startsWith('/uploads/')) return void res.status(400).end();
  const cached = path.join(dirs.img, `${hash(u, 16)}-${w}.jpg`);
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  if (fs.existsSync(cached)) return void fs.createReadStream(cached).pipe(res);
  try {
    const src = u.startsWith('/uploads/') ? fs.readFileSync(path.join(dirs.uploads, path.basename(u))) : await fetchBuffer(u, { headers: { 'User-Agent': BROWSER_UA, Accept: 'image/avif,image/webp,image/*' }, timeoutMs: 15000 });
    const jpg = await sharp(src).resize(w, w, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
    fs.writeFileSync(cached, jpg);
    res.end(jpg);
  } catch (e) {
    log.warn('img', `${u.slice(0, 80)}: ${errMsg(e)}`);
    res.status(502).end();
  }
});

// ---------------------------------------------------------------------------- static
app.use('/uploads', express.static(dirs.uploads, { maxAge: '1d' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err?.status ?? 500;
  if (status >= 500) log.error('http', errMsg(err));
  res.status(status).json({ error: errMsg(err) });
});

app.listen(config.port, '0.0.0.0', () => {
  const caps = capabilities();
  console.log(`\n  VRShop backend  →  ${baseUrl()}   (local: http://localhost:${config.port})`);
  console.log(`  phone app       →  ${baseUrl()}/`);
  console.log(`  AI: ${caps.openai ? `OpenAI (${config.openai.visionModel} / ${config.openai.model})` : 'heuristic (set OPENAI_API_KEY)'}  |  shopping: IKEA${caps.serpapi ? ' + Google Shopping' : ' only (set SERPAPI_KEY)'}  |  image→3D: ${caps.generator}\n`);
});
