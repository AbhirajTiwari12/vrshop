import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { baseUrl, capabilities, config, PUBLIC_DIR } from './config.js';
import { dirs, getProduct, getSession, hash, listSessions, saveSession, updateProduct, upsertProduct } from './store.js';
import { createSession, expandSession, sessionAsk, sessionSearch, setBrowse, setCartQty } from './session.js';
import { inventoryProduct, inventoryStats, setInventoryCategory } from './inventory/inventory.js';
import { pullCatalog, pullStatus, planShoppingQueries, type PullTier } from './inventory/pull.js';
import { liveSearchBudgetLeft, shoppingCallsThisMonth } from './inventory/usage.js';
import { COLORS, MATERIALS, STYLES } from './inventory/attributes.js';
import { CATEGORIES, normalizeCategory } from './catalog.js';
import { retailerRouter } from './pay/retailer.js';
import { splitWithRoommate, startCheckout, tamperDemo, TAMPER_MODES, voidOrder, type TamperMode } from './pay/agent.js';
import { findMandate, vicInstruction } from './pay/mandate.js';
import { buildQuote } from './pay/quote.js';
import { keyDirectory } from './pay/tap.js';
import { visaStatus } from './pay/visa.js';
import { ensureModel, modelFile } from './models/pipeline.js';
import { solveLayout, defaultGeometry, type FixedPlacement, type LayoutItem } from './layout.js';
import { replacementCandidates, setPiece, syncPieces, warmCandidates } from './realFurniture.js';
import { labelName, replacementPose } from './realPose.js';
import { designRoom, designStyles, type PlacedPiece } from './design.js';
import { categoryDef } from './catalog.js';
import { transcribe, hasOpenAI } from './ai/openai.js';
import { speechAudio, speechUrl } from './ai/speech.js';
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

// Voice: transcribe, then one assistant turn (filter the catalog, answer price questions, add to cart, ...).
app.post('/api/sessions/:id/voice', audioUpload.single('audio'), async (req, res) => {
  need(getSession(String(req.params.id)), 'Session');
  const file = req.file;
  let transcript = String(req.body?.text ?? '').trim();
  if (!transcript) {
    if (!file) return void res.status(400).json({ error: 'audio file (field "audio") or text required' });
    if (!hasOpenAI()) return void res.status(400).json({ error: 'Voice needs OPENAI_API_KEY on the server (typing still works)' });
    transcript = await transcribe(file.buffer, file.originalname || 'speech.wav');
  }
  if (!transcript) return void res.json({ transcript: '', reply: "Sorry, I didn't catch that." });
  const focus = String(req.body?.focusProductId ?? '') || undefined;
  const pieceId = String(req.body?.pieceId ?? '') || undefined; // the real piece the user pointed at while talking
  const r = await sessionAsk(String(req.params.id), transcript, { via: 'voice', focusProductId: focus, pieceId });
  res.json({ ...r, speechUrl: speechUrl(r.reply), session: expandSession(getSession(String(req.params.id))!) });
});

// Typed version of the same conversation.
app.post('/api/sessions/:id/ask', async (req, res) => {
  need(getSession(String(req.params.id)), 'Session');
  const text = String(req.body?.text ?? '').trim().slice(0, 500);
  if (!text) return void res.status(400).json({ error: 'text required' });
  const focus = String(req.body?.focusProductId ?? '') || undefined;
  const pieceId = String(req.body?.pieceId ?? '') || undefined;
  const r = await sessionAsk(String(req.params.id), text, { via: 'text', focusProductId: focus, pieceId });
  res.json({ ...r, speechUrl: req.body?.speak ? speechUrl(r.reply) : undefined, session: expandSession(getSession(String(req.params.id))!) });
});

// The designer's voice: register a line (greetings, "I arranged your room"), then fetch its WAV. Lines are
// synthesized once with OpenAI text to speech and cached on disk.
app.post('/api/speech', (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return void res.status(400).json({ error: 'text required' });
  const url = speechUrl(text);
  if (!url) return void res.status(400).json({ error: 'Spoken replies need OPENAI_API_KEY on the server' });
  res.json({ url });
});

app.get('/api/speech/:file', async (req, res) => {
  const id = String(req.params.file).replace(/\.wav$/, '');
  if (!/^[a-f0-9]{8,40}$/.test(id)) return void res.status(404).end();
  const wav = await speechAudio(id);
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(wav);
});

// Manual filters (chips, sliders). Never triggers a paid search by itself...
app.put('/api/sessions/:id/browse', async (req, res) => {
  need(getSession(String(req.params.id)), 'Session');
  await setBrowse(String(req.params.id), req.body?.filters ?? {}, { live: false });
  res.json(expandSession(getSession(String(req.params.id))!));
});

// ...only this explicit "Search stores for more" does (IKEA free + one Google Shopping call, cached, monthly cap).
app.post('/api/sessions/:id/browse/more', async (req, res) => {
  const s = need(getSession(String(req.params.id)), 'Session');
  const before = s.browse?.total ?? 0;
  const b = await setBrowse(s.id, req.body?.filters ?? s.browse?.filters ?? {}, { live: true });
  res.json({ added: b.total - before, liveSearched: b.liveSearched ?? null, session: expandSession(getSession(s.id)!) });
});

app.post('/api/sessions/:id/geometry', (req, res) => {
  const s = need(getSession(String(req.params.id)), 'Session');
  const g = req.body as RoomGeometry;
  if (!Array.isArray(g?.floorPolygon)) return void res.status(400).json({ error: 'floorPolygon required' });
  const realFurniture = syncPieces(s.realFurniture, g);
  saveSession({ ...s, geometry: g, realFurniture });
  warmCandidates(getSession(s.id)!);
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
      return { productId: p.id, category: p.category, dims: p.dims ?? categoryDef(p.category).dims, anchor: cat?.placement.anchor, near: cat?.placement.near, isSet: /\bchairs?\b/i.test(p.title) && p.category === 'dining_table' };
    });
  // Replacements stand in their real piece's spot (the headset sends where they are now); the rest arranges around them.
  const replaced = Object.values(s.realFurniture ?? {}).filter((p) => p.state === 'replace');
  const fixed: FixedPlacement[] = (Array.isArray(req.body?.fixed) ? req.body.fixed : [])
    .filter((f: any) => typeof f?.productId === 'string' && ids.includes(f.productId) && Number.isFinite(f?.position?.x) && Number.isFinite(f?.position?.z) && Number.isFinite(f?.yawDeg));
  const floor = geo.floorPolygon.length ? geo.floorPolygon : [{ x: 0, z: 0 }];
  const centroid = { x: floor.reduce((a, p) => a + p.x, 0) / floor.length, z: floor.reduce((a, p) => a + p.z, 0) / floor.length };
  for (const piece of replaced) {
    const box = geo.objects.find((o) => o.id === piece.id);
    const p = piece.replacementId ? getProduct(piece.replacementId) : undefined;
    if (!box || !p || !ids.includes(p.id) || fixed.some((f) => f.productId === p.id)) continue;
    const pose = replacementPose(box, p.dims ?? categoryDef(p.category).dims, geo.walls, geo.floorY, centroid);
    fixed.push({ productId: p.id, position: pose.position, yawDeg: pose.yawDeg, reason: `in place of your ${labelName(piece.label)}` });
  }
  const placements = solveLayout(geo, items, { fixed, skipObjectIds: replaced.map((p) => p.id) });
  saveSession({ ...s, placements });
  res.json({ placements, usedDefaultRoom: !s.geometry });
});

// "Design my room": a styled room (mode "style", with a style key) or the bag arranged (mode "bag"). Planned pieces
// replace pieces of the same kind already in the room: real furniture is set to "replace" with the design's pick (the
// headset paints it out and stands the pick in its spot), virtual pieces placed earlier are superseded.
app.get('/api/design/styles', (_req, res) => res.json({ styles: designStyles() }));

app.post('/api/sessions/:id/design', async (req, res) => {
  const id = String(req.params.id);
  need(getSession(id), 'Session');
  const placed: PlacedPiece[] = Array.isArray(req.body?.placed) ? req.body.placed : [];
  const r = await designRoom(id, { mode: req.body?.mode === 'bag' ? 'bag' : 'style', style: req.body?.style ? String(req.body.style) : null, placed, user: req.body?.user });
  res.json({ ...r, session: expandSession(getSession(id)!) });
});

app.put('/api/sessions/:id/placements', (req, res) => {
  const s = need(getSession(String(req.params.id)), 'Session');
  const placements: Placement[] = Array.isArray(req.body?.placements) ? req.body.placements : [];
  saveSession({ ...s, placements });
  res.json({ ok: true });
});

// The user's real furniture: keep (solid; new pieces never overlap it) or replace (painted out, a product in its spot).
app.put('/api/sessions/:id/real/:pieceId', (req, res) => {
  const b = req.body ?? {};
  const s = setPiece(String(req.params.id), String(req.params.pieceId), {
    state: b.state,
    category: typeof b.category === 'string' && b.category ? normalizeCategory(b.category) : undefined,
    replacementId: b.replacementId === null || b.clearReplacement === true ? null : typeof b.replacementId === 'string' ? b.replacementId : undefined,
  });
  res.json(expandSession(s));
});

// Products that could stand in for a real piece: same type (or ?category=), sized like it, style-ranked, 3D warmed up.
app.get('/api/sessions/:id/real/:pieceId/candidates', async (req, res) => {
  const s = need(getSession(String(req.params.id)), 'Session');
  const piece = need(s.realFurniture?.[String(req.params.pieceId)], 'Piece');
  const category = typeof req.query.category === 'string' && req.query.category ? normalizeCategory(req.query.category) : undefined;
  const limit = Math.max(1, Math.min(24, Number(req.query.limit) || 12));
  const r = await replacementCandidates(s, piece, category ? { category } : {}, limit);
  res.json({ pieceId: piece.id, category: r.category, products: r.products });
});

app.post('/api/sessions/:id/cart', (req, res) => {
  const s = setCartQty(String(req.params.id), String(req.body?.productId ?? ''), Number(req.body?.qty ?? 1));
  res.json(expandSession(s));
});

// ---------------------------------------------------------------------------- Visa: agentic checkout ("buy the room")
app.get('/api/visa/status', (_req, res) => res.json(visaStatus()));

app.get('/api/sessions/:id/checkout/quote', (req, res) => {
  res.json(buildQuote(need(getSession(String(req.params.id)), 'Session')));
});

// The shopper's single approval (headset trigger / phone button) creates the mandate and starts the agent.
app.post('/api/sessions/:id/checkout', (req, res) => {
  const via = ['headset', 'phone', 'voice'].includes(req.body?.via) ? req.body.via : 'phone';
  startCheckout(String(req.params.id), { via, allowOverBudget: req.body?.allowOverBudget === true });
  res.json(expandSession(getSession(String(req.params.id))!));
});

app.post('/api/sessions/:id/checkout/orders/:orderId/void', async (req, res) => {
  await voidOrder(String(req.params.id), String(req.params.orderId));
  res.json(expandSession(getSession(String(req.params.id))!));
});

// The approval as a Visa Intelligent Commerce payment instruction.
app.get('/api/sessions/:id/checkout/instruction', (req, res) => {
  const m = need(getSession(String(req.params.id)), 'Session').checkout?.mandate;
  res.json(vicInstruction(need(m ? findMandate(m.id) ?? m : undefined, 'Mandate')));
});

// Split the room: Visa Pay by Link for a roommate's share.
app.post('/api/sessions/:id/split', async (req, res) => {
  await splitWithRoommate(String(req.params.id), String(req.body?.to ?? '').slice(0, 40), Number(req.body?.share ?? 0.5));
  res.json(expandSession(getSession(String(req.params.id))!));
});

// Landing page for simulated payment links (real ones are hosted by Visa Acceptance).
app.get('/pay/sim/:id', (req, res) => {
  const amount = Number(req.query.amount) || 0;
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pay your share</title><body style="font:16px system-ui;max-width:420px;margin:40px auto;padding:0 16px;color-scheme:light dark"><h1 style="font-size:22px">Pay your share of the room</h1><p style="font-size:34px;font-weight:700;margin:8px 0">$${amount.toFixed(2)}</p><p>This is a <b>simulated</b> Visa Pay by Link page. With Visa Acceptance sandbox keys (Pay by Link enabled), this is a real hosted Visa checkout.</p><p style="opacity:.6;font-size:13px">Link ${String(req.params.id).replace(/[^\w-]/g, '')}</p></body>`);
});

// Budget coach: swap a cart item for a cheaper look-alike.
app.post('/api/sessions/:id/cart/swap', (req, res) => {
  const id = String(req.params.id);
  const s = need(getSession(id), 'Session');
  const from = String(req.body?.from ?? ''), to = String(req.body?.to ?? '');
  const qty = s.cart.find((c) => c.productId === from)?.qty ?? 1;
  need(getProduct(to) ?? inventoryProduct(to), 'Product');
  if (!getProduct(to)) upsertProduct({ ...inventoryProduct(to)! });
  setCartQty(id, from, 0);
  setCartQty(id, to, qty);
  res.json(expandSession(getSession(id)!));
});

// Trusted Agent Protocol: the agent's public key directory (merchants resolve keyids here) and the tamper demo.
app.get(['/.well-known/jwks', '/.well-known/jwks.json'], (_req, res) => res.json(keyDirectory()));
app.post('/api/visa/tamper', async (req, res) => {
  const mode = String(req.body?.mode ?? 'valid') as TamperMode;
  if (!TAMPER_MODES.includes(mode)) return void res.status(400).json({ error: `mode must be one of ${TAMPER_MODES.join(', ')}` });
  res.json(await tamperDemo(mode));
});

// Simulated retailers that accept trusted agents (TAP verify -> mandate check -> Visa authorization).
app.use('/retailer', retailerRouter);

// ---------------------------------------------------------------------------- catalog (bulk-pulled listings)
app.get('/api/catalog', (_req, res) => {
  res.json({
    ...inventoryStats(),
    pull: pullStatus,
    shopping: { provider: config.shopping.provider, callsThisMonth: shoppingCallsThisMonth(), monthlyLimit: config.shopping.monthlyLiveLimit, liveLeft: liveSearchBudgetLeft(), liveMode: config.shopping.liveMode },
    vocab: { categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label })), colors: COLORS, materials: MATERIALS, styles: STYLES },
  });
});

// Start a bulk pull in the background (the CLI `npm run catalog:pull` does the same with a cost prompt).
app.post('/api/catalog/pull', (req, res) => {
  if (pullStatus.running) return void res.status(409).json({ error: 'A pull is already running', pull: pullStatus });
  const shopping: PullTier = ['none', 'light', 'full'].includes(req.body?.shopping) ? req.body.shopping : 'light';
  const categories: string[] | undefined = Array.isArray(req.body?.categories) ? req.body.categories.map(String) : undefined;
  void pullCatalog({ shopping, categories, force: !!req.body?.force }).catch((e) => log.error('catalog', errMsg(e)));
  res.json({ started: true, plannedShoppingCalls: planShoppingQueries({ shopping, categories }).length, pull: pullStatus });
});

// ---------------------------------------------------------------------------- products & models
app.get('/api/products/:id', (req, res) => {
  res.json(need(getProduct(String(req.params.id)), 'Product'));
});

// Build one product's 3D model on purpose, from curated photos and real dimensions (the way to use paid generation in
// 3D-only demo mode). Body: { images?: string[] (clean product shots, best first, up to 5), dims?: {w,d,h} (m),
// model?: 'rodin' | 'trellis2' | 'hunyuan', productUrl?, force?, photoOnly? }. photoOnly: free — rugs and wall art
// become flat pieces wearing the (curated) photo at true size, no generation.
app.post('/api/products/:id/model/build', (req, res) => {
  // Catalog products no room has shown yet are fine too.
  const id = String(req.params.id);
  const fromCatalog = inventoryProduct(id);
  const p = need(getProduct(id) ?? (fromCatalog ? upsertProduct({ ...fromCatalog }) : undefined), 'Product');
  const b = req.body ?? {};
  if (!b.photoOnly && config.gen.provider === 'none') return void res.status(400).json({ error: 'No image-to-3D provider: set FAL_KEY (or MESHY_API_KEY / TRIPO_API_KEY)' });
  const patch: Record<string, unknown> = {};
  const images = Array.isArray(b.images) ? b.images.filter((u: unknown) => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 5) : [];
  if (images.length) patch.genImages = images;
  const d = b.dims;
  // Thin things are real too (a rug is ~1 cm, a poster ~3 cm deep), so only guard against nonsense.
  if (d && [d.w, d.d, d.h].every((x: unknown) => typeof x === 'number' && x >= 0.003 && x < 6)) { patch.dims = { w: d.w, d: d.d, h: d.h }; patch.dimsSource = 'listing'; }
  if (typeof b.model === 'string' && ['rodin', 'trellis2', 'hunyuan'].includes(b.model)) patch.genModel = b.model;
  if (typeof b.category === 'string' && CATEGORIES.some((c) => c.key === b.category)) { patch.category = b.category; setInventoryCategory(p.id, b.category); }
  if (typeof b.productUrl === 'string' && /^https?:\/\//.test(b.productUrl)) { patch.productUrl = b.productUrl; patch.storeLinkResolved = true; }
  if (Object.keys(patch).length) updateProduct(p.id, patch);
  const model = b.photoOnly
    ? ensureModel(p.id, { allowGenerate: false, rebuild: true })
    : ensureModel(p.id, { allowGenerate: true, explicit: true, force: b.force === true });
  log.info('model', `${p.id}: build requested (${images.length || 'listing'} photo(s), ${patch.genModel ?? config.gen.falModel})`);
  res.json({ ...getProduct(p.id), model });
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
  console.log(`  AI: ${caps.openai ? `OpenAI (${config.openai.visionModel} / ${config.openai.model})` : 'heuristic (set OPENAI_API_KEY)'}  |  shopping: IKEA${caps.serpapi ? ` + Google Shopping (${caps.shopping})` : ' only (set SERPER_API_KEY or SERPAPI_KEY)'}  |  image→3D: ${caps.generator}\n`);
});
