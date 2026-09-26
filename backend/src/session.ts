import { categoryDef, normalizeCategory } from './catalog.js';
import { analyzeRoom, rankProducts, voiceIntent, type VoiceIntent } from './ai/designer.js';
import { searchIkea, ikeaHasModel } from './search/ikea.js';
import { searchShopping } from './search/serp.js';
import { ensureModel } from './models/pipeline.js';
import { getProduct, getSession, newId, saveSession, upsertProduct } from './store.js';
import { mapLimit } from './util/http.js';
import { log, errMsg } from './util/log.js';
import type { CategoryResult, Product, Recommendation, RoomAnalysis, Session } from './types.js';

export function createSession(input: { prompt: string; budget: number | null; photoFiles: string[]; photoUrls: string[] }): Session {
  const s: Session = {
    id: newId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'analyzing',
    stage: input.photoFiles.length ? 'Looking at your room…' : 'Planning your room…',
    prompt: input.prompt,
    budget: input.budget,
    photos: input.photoUrls,
    room: null,
    geometry: null,
    categories: [],
    cart: [],
    placements: [],
    voice: [],
  };
  saveSession(s);
  void runPipeline(s.id, input.photoFiles).catch((e) => {
    const cur = getSession(s.id);
    if (cur) saveSession({ ...cur, status: 'error', error: errMsg(e), stage: 'Something went wrong' });
    log.error('session', `${s.id}: ${errMsg(e)}`);
  });
  return s;
}

async function runPipeline(id: string, photoFiles: string[]) {
  const t0 = Date.now();
  const s = getSession(id)!;
  const room = await analyzeRoom(photoFiles, s.prompt, s.budget);
  saveSession({ ...getSession(id)!, room, status: 'searching', stage: `Finding ${room.recommendations.length} kinds of furniture…` });
  log.info('session', `${id} analysis (${room.source}) ${Date.now() - t0} ms: ${room.recommendations.map((r) => r.category).join(', ')}`);

  let done = 0;
  await mapLimit(room.recommendations, 3, async (rec) => {
    const cat = await searchCategory(room, rec, 'analysis');
    const cur = getSession(id)!;
    // Keep categories in recommendation priority order as results stream in.
    const cats = [...cur.categories.filter((c) => c.category !== cat.category), cat].sort(
      (a, b) => (room.recommendations.findIndex((r) => r.category === a.category) + 1 || 99) - (room.recommendations.findIndex((r) => r.category === b.category) + 1 || 99),
    );
    done++;
    saveSession({ ...cur, categories: cats, stage: `Found ${done}/${room.recommendations.length} categories…` });
  });

  saveSession({ ...getSession(id)!, status: 'ready', stage: 'Ready' });
  log.info('session', `${id} ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  prefetchModels(id);
}

/** Search IKEA + Google Shopping for one recommendation, rank for the room, store products. */
export async function searchCategory(room: RoomAnalysis, rec: Recommendation, origin: CategoryResult['origin'], maxPrice?: number | null): Promise<CategoryResult> {
  const category = normalizeCategory(rec.category);
  const priceCap = maxPrice ?? (rec.budget ? rec.budget * 1.6 : undefined);
  const [ikea, shopping] = await Promise.all([
    searchIkea(rec.ikeaQuery || categoryDef(category).label, 16),
    searchShopping(rec.query, { maxPrice: priceCap, limit: 16 }),
  ]);

  // IKEA search is keyword-based and returns accessories too (covers, cushions, bulbs); drop obvious mismatches.
  const ikeaFiltered = ikea.filter((p) => !/(cover|cushion|bulb|shade only|leg|legs|pad|replacement|hardware|pillow case)\b/i.test(p.title) || category === 'rug');
  let pool = [...ikeaFiltered.slice(0, 10), ...shopping.slice(0, 12)];
  if (priceCap) pool = pool.filter((p) => p.price == null || p.price <= priceCap * 1.25);
  if (rec.maxDims) {
    const m = rec.maxDims;
    pool = pool.filter((p) => !p.dims || (Math.max(p.dims.w, p.dims.d) <= Math.max(m.w, m.d) * 1.15 && p.dims.h <= m.h * 1.2));
  }
  for (const p of pool) p.category = category;

  let ranked = await rankProducts(room, rec, pool, 8);

  // Always surface a couple of IKEA items that have official 3D models: they look the most real in VR.
  const withModel = await Promise.all(ikeaFiltered.slice(0, 6).map(async (p) => ((await ikeaHasModel(p.ikeaItemNo!)) ? p : null)));
  const official = withModel.filter(Boolean) as Product[];
  for (const p of official.slice(0, 2)) {
    if (!ranked.some((r) => r.id === p.id)) {
      p.category = category;
      p.why ??= 'IKEA official 3D model: exact geometry in your room';
      ranked = [...ranked.slice(0, 7), p];
    }
  }
  const stored = ranked.map((p) => upsertProduct({ ...p, category }));
  return {
    category,
    label: rec.label || categoryDef(category).label,
    query: rec.query,
    why: rec.why,
    placement: rec.placement ?? { anchor: categoryDef(category).anchor },
    productIds: stored.map((p) => p.id),
    origin,
  };
}

/** Prepare free models (IKEA official + stand-ins) for the top picks so "Place" is instant. */
function prefetchModels(id: string) {
  const s = getSession(id);
  if (!s) return;
  for (const c of s.categories) {
    for (const pid of c.productIds.slice(0, 3)) {
      const p = getProduct(pid);
      if (p?.source === 'ikea') ensureModel(pid, { allowGenerate: false });
    }
  }
}

/** Free-text / voice search inside a session. Adds (or replaces) a category row at the top. */
export async function sessionSearch(id: string, text: string, intent?: VoiceIntent, origin: CategoryResult['origin'] = 'search'): Promise<{ intent: VoiceIntent; result: CategoryResult }> {
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('Session not found'), { status: 404 });
  const it = intent ?? (await voiceIntent(text, s.room));
  const room = s.room ?? (await analyzeRoom([], s.prompt, s.budget));
  const rec: Recommendation = {
    category: it.category,
    label: it.label,
    query: it.query,
    ikeaQuery: it.ikeaQuery,
    why: origin === 'voice' ? `You said: “${text}”` : `You asked: “${text}”`,
    priority: 0,
    placement: { anchor: categoryDef(it.category).anchor },
  };
  const result = await searchCategory(room, rec, origin, it.maxPrice);
  const cur = getSession(id)!;
  saveSession({ ...cur, room: cur.room ?? room, categories: [result, ...cur.categories.filter((c) => !(c.category === result.category && c.origin !== 'analysis'))] });
  prefetchModels(id);
  return { intent: it, result };
}

/** Session plus every referenced product, in one payload (what the headset and phone render). */
export function expandSession(s: Session) {
  const ids = new Set<string>([...s.categories.flatMap((c) => c.productIds), ...s.cart.map((c) => c.productId), ...s.placements.map((p) => p.productId)]);
  const products: Record<string, Product> = {};
  for (const pid of ids) {
    const p = getProduct(pid);
    if (p) products[pid] = p;
  }
  const cartTotal = s.cart.reduce((sum, c) => sum + (products[c.productId]?.price ?? 0) * c.qty, 0);
  return { ...s, products, cartTotal: Math.round(cartTotal * 100) / 100 };
}
