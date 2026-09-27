import { categoryDef, normalizeCategory } from './catalog.js';
import { config } from './config.js';
import { analyzeRoom, rankProducts, voiceIntent, type VoiceIntent } from './ai/designer.js';
import { answer, interpret, short, superlative, type Action } from './ai/assistant.js';
import { searchIkea, ikeaHasModel } from './search/ikea.js';
import { immersiveDetails, searchShopping } from './search/serp.js';
import { addProducts, allMatches, hasQuery, queryInventory, queryKey, recordQuery } from './inventory/inventory.js';
import { describeFilters, isEmpty, normalizeFilters } from './inventory/filters.js';
import { liveSearchBudgetLeft } from './inventory/usage.js';
import { buildQuote } from './pay/quote.js';
import { ensureModel } from './models/pipeline.js';
import { getProduct, getSession, newId, saveSession, updateProduct, upsertProduct } from './store.js';
import { mapLimit } from './util/http.js';
import { log, errMsg } from './util/log.js';
import type { BrowseResult, CategoryResult, ChatTurn, Filters, Product, Recommendation, RoomAnalysis, Session } from './types.js';

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

  // The pulled catalog first (free). Only search live stores when it has too little for this category.
  const local = queryInventory(
    { category, maxPrice: priceCap ? priceCap * 1.25 : undefined, maxWidthM: rec.maxDims ? Math.max(rec.maxDims.w, rec.maxDims.d) * 1.15 : undefined, maxHeightM: rec.maxDims ? rec.maxDims.h * 1.2 : undefined },
    { limit: 22, boostText: `${rec.query} ${room.styleTags.join(' ')}` },
  ).products.map((p) => ({ ...p }));
  let ikeaFiltered: Product[];
  let pool: Product[];
  if (local.length >= 10) {
    ikeaFiltered = local.filter((p) => p.source === 'ikea');
    pool = local;
    log.info('session', `${category}: ${local.length} candidates from the catalog (no live search)`);
  } else {
    const [ikea, shopping] = await Promise.all([
      searchIkea(rec.ikeaQuery || categoryDef(category).label, 16),
      searchShopping(rec.query, { maxPrice: priceCap, limit: 16 }),
    ]);
    // Admission drops parts/accessories (covers, legs, bulbs) and wrong categories; results grow the catalog.
    ikeaFiltered = addProducts(ikea, category).kept.filter((p) => p.category === category).map((p) => ({ ...p }));
    const shop = addProducts(shopping, category).kept.filter((p) => p.category === category).map((p) => ({ ...p }));
    pool = [...ikeaFiltered.slice(0, 10), ...shop.slice(0, 12)];
  }
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
  const ids = new Set<string>([...s.categories.flatMap((c) => c.productIds), ...(s.browse?.productIds ?? []), ...s.cart.map((c) => c.productId), ...s.placements.map((p) => p.productId), ...(s.checkout?.orders.flatMap((o) => o.items.map((i) => i.productId)) ?? [])]);
  const products: Record<string, Product> = {};
  for (const pid of ids) {
    const p = getProduct(pid);
    if (p) products[pid] = p;
  }
  const cartTotal = s.cart.reduce((sum, c) => sum + (products[c.productId]?.price ?? 0) * c.qty, 0);
  return { ...s, products, cartTotal: Math.round(cartTotal * 100) / 100 };
}

// ---------------------------------------------------------------------------------------------- cart

export function setCartQty(id: string, productId: string, qty: number): Session {
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('Session not found'), { status: 404 });
  const p = getProduct(productId);
  if (!p) throw Object.assign(new Error('Product not found'), { status: 404 });
  qty = Math.max(0, Math.min(20, Math.round(qty)));
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
  return getSession(id)!;
}

// ---------------------------------------------------------------------------------------------- browse

/** Query text for a live store search built from the filters: "black leather sofa". */
function liveQuery(f: Filters): { shopping: string; ikea: string } | null {
  if (!f.category && !f.keywords?.length) return null; // too vague to be worth a paid search
  const noun = f.category ? categoryDef(f.category).label.toLowerCase().replace(/ \/.*$/, '') : '';
  const words = [f.colors?.[0], f.materials?.[0], f.styles?.[0], ...(f.keywords ?? []), noun].filter(Boolean);
  return { shopping: words.join(' '), ikea: [f.colors?.[0], ...(f.keywords ?? []).slice(0, 1), noun].filter(Boolean).join(' ') };
}

/** Search IKEA (free) + Google Shopping (paid, capped per month) for the filters and add results to the catalog. */
async function liveTopUp(f: Filters): Promise<string | undefined> {
  const q = liveQuery(f);
  if (!q) return undefined;
  const shopKey = queryKey(config.shopping.provider, q.shopping);
  const ikeaKey = queryKey('ikea', q.ikea);
  const doShop = !hasQuery(shopKey, 3 * 86400e3) && liveSearchBudgetLeft() > 0;
  const doIkea = !hasQuery(ikeaKey, 3 * 86400e3);
  if (!doShop && !doIkea) return undefined;
  const [ikea, shop] = await Promise.all([
    doIkea ? searchIkea(q.ikea, 100) : Promise.resolve([]),
    doShop ? searchShopping(q.shopping, { maxPrice: f.maxPrice ? f.maxPrice * 1.1 : undefined, limit: 60 }) : Promise.resolve([]),
  ]);
  if (doIkea) recordQuery(ikeaKey, addProducts(ikea, f.category).kept.length, 'live');
  if (doShop) recordQuery(shopKey, addProducts(shop, f.category).kept.length, 'live');
  log.info('browse', `live top-up "${q.shopping}": IKEA ${ikea.length}, shopping ${shop.length}${doShop ? '' : ' (skipped: cached or monthly limit)'}`);
  return q.shopping;
}

/** Filter the catalog for a session (manual filters, voice, or typed). `live` allows a store search when results are thin. */
export async function setBrowse(id: string, raw: unknown, opts: { live?: boolean } = {}): Promise<BrowseResult> {
  if (!getSession(id)) throw Object.assign(new Error('Session not found'), { status: 404 });
  const filters = normalizeFilters(raw);
  let r = queryInventory(filters, { limit: 48 });
  let liveSearched: string | undefined;
  if (opts.live && config.shopping.liveMode !== 'off' && r.total < config.shopping.liveMinResults) {
    liveSearched = await liveTopUp(filters);
    if (liveSearched) r = queryInventory(filters, { limit: 48 });
  }
  // Products shown to a client must live in the session store (model pipeline, cart, placements use it).
  for (const p of r.products) if (!getProduct(p.id)) upsertProduct({ ...p });
  const browse: BrowseResult = { filters, productIds: r.products.map((p) => p.id), total: r.total, priceRange: r.priceRange, facets: r.facets, liveSearched, updatedAt: Date.now() };
  saveSession({ ...getSession(id)!, browse });
  return browse;
}

export interface AskResult {
  transcript: string;
  reply: string;
  action: Action;
  productId?: string;
  atPointer: boolean;
  browse: BrowseResult | undefined;
}

/** One conversational turn: interpret -> filter the catalog (live top-up if thin) -> answer with real numbers -> act. */
export async function sessionAsk(id: string, text: string, opts: { via?: 'voice' | 'text'; focusProductId?: string } = {}): Promise<AskResult> {
  const s = getSession(id);
  if (!s) throw Object.assign(new Error('Session not found'), { status: 404 });
  const prev = s.browse;
  const visible = (prev?.productIds ?? []).slice(0, 8).map((pid) => getProduct(pid)).filter((p): p is Product => !!p);
  const cartTotal = s.cart.reduce((sum, c) => sum + (getProduct(c.productId)?.price ?? 0) * c.qty, 0);
  const it = await interpret(text, {
    filters: prev?.filters ?? {},
    visible,
    focused: opts.focusProductId ? getProduct(opts.focusProductId) : undefined,
    total: prev?.total ?? 0,
    priceRange: prev?.priceRange ?? null,
    room: s.room,
    budget: s.budget,
    cartTotal,
    chat: s.chat ?? [],
    stores: queryInventory({}, { limit: 0 }).facets.stores.map((x) => x.value),
  });

  const f = { ...it.filters };
  if (!f.sort) f.sort = it.question === 'cheapest' ? 'price_asc' : it.question === 'most_expensive' ? 'price_desc' : it.question === 'best_rated' ? 'rating' : undefined;
  const changed = !prev || JSON.stringify(normalizeFilters(f)) !== JSON.stringify(prev.filters);
  const browse = changed ? await setBrowse(id, f, { live: true }) : prev;

  const parts: string[] = [];
  // Only announce results when what's being shown really changed (not just the sort order behind an action).
  const { sort: _a, ...before } = prev?.filters ?? {};
  const { sort: _b, ...after } = browse?.filters ?? {};
  const announce = changed && (it.action === 'none' || JSON.stringify(before) !== JSON.stringify(after));
  if (announce && browse) {
    const what = describeFilters(browse.filters, browse.total);
    if (browse.total === 0) parts.push(`I couldn't find any ${what}${browse.liveSearched ? ', even after checking stores' : ''}. Try a higher price or fewer filters.`);
    else if (isEmpty(browse.filters)) parts.push(`Showing everything: ${browse.total} pieces.`);
    else parts.push(`${browse.liveSearched ? 'I checked stores too. ' : ''}Found ${browse.total} ${what}.`);
  }
  const matches = browse ? allMatches(browse.filters) : [];
  // "Add the cheapest one": the target comes from the real results, not a list position.
  const pick = it.action !== 'none' && it.action !== 'checkout' ? superlative(it.question, matches) : undefined;
  const facts = pick ? '' : answer(it.question, matches, { budget: s.budget, cartTotal });
  if (facts) parts.push(facts);

  let target = it.target ?? pick;
  if (target && !getProduct(target.id)) upsertProduct({ ...target });
  target = target ? getProduct(target.id) ?? target : undefined;
  if ((it.action === 'add_to_cart' || it.action === 'remove_from_cart') && target) {
    setCartQty(id, target.id, it.action === 'add_to_cart' ? 1 : 0);
    parts.push(it.action === 'add_to_cart' ? `Added ${short(target)} to your cart.` : `Removed ${short(target)} from your cart.`);
  } else if (it.action === 'checkout') {
    const q = buildQuote(getSession(id)!);
    parts.push(!q.groups.length ? 'Your cart is empty. Add a few pieces first.'
      : `That’s $${q.total.toLocaleString('en-US', { maximumFractionDigits: 2 })} from ${q.groups.length} store${q.groups.length === 1 ? '' : 's'}${q.budget ? ` against your $${q.budget.toLocaleString('en-US')} budget` : ''}.${q.overBy > 0 ? ` You’re $${Math.round(q.overBy).toLocaleString('en-US')} over; I found cheaper swaps.` : ''} Approve it with Visa and I’ll check out at every store.`);
  } else if (it.action !== 'none' && !target) {
    parts.push('Which one? Say “the second one”, or open it first.');
  } else if (target && it.action === 'open') {
    parts.push(`Here’s ${short(target)}, ${target.priceText || 'no price listed'} at ${target.store}.`);
  } else if (target && it.action === 'place') {
    parts.push(`Placing ${short(target)} in your room.`);
  }
  // The server already said what it did for actions; the model's own sentence would repeat it.
  if (it.reply && it.action === 'none' && !(changed && /\b\d+\b.*\b(results|options|items|found)\b/i.test(it.reply))) parts.push(it.reply);
  const reply = parts.join(' ').replace(/\s+/g, ' ').trim() || 'Okay.';

  const cur = getSession(id)!;
  const turns: ChatTurn[] = [{ role: 'user', text, at: Date.now(), via: opts.via ?? 'text' }, { role: 'assistant', text: reply, at: Date.now() }];
  saveSession({ ...cur, chat: [...(cur.chat ?? []), ...turns].slice(-20), voice: opts.via === 'voice' ? [...cur.voice, { at: Date.now(), transcript: text, query: browse ? describeFilters(browse.filters) : '' }].slice(-20) : cur.voice });
  // Warm up the free 3D model (IKEA official / stand-in) as soon as the user singles an item out.
  if (target && (it.action === 'place' || it.action === 'open')) ensureModel(target.id, { allowGenerate: false });
  log.info('assistant', `${id} "${text}" -> ${JSON.stringify(browse?.filters ?? {})} q=${it.question} a=${it.action} (${it.source})`);
  return { transcript: text, reply, action: it.action, productId: target?.id, atPointer: it.atPointer, browse };
}
