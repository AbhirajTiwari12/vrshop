import fs from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from '../config.js';
import { isAccessory, matchCategory } from '../catalog.js';
import { MATERIAL_FAMILY, extractAttributes } from './attributes.js';
import type { BrowseResult, Dims, Facet, Filters, Product } from '../types.js';

// The pulled catalog: thousands of real listings fetched once (npm run catalog:pull) and filtered locally for free.
// Voice / typed / manual filters query this; live store searches only top it up when it has too few matches, and
// whatever they return is added here, so the same question never costs twice.

const FILE = path.join(DATA_DIR, 'inventory.json');

interface InventoryFile {
  version: 1;
  pulledAt: number | null;
  products: Record<string, Product>;
  queries: Record<string, { at: number; count: number; source: 'pull' | 'live' }>;
}

let inv: InventoryFile | null = null;
let loadedMtime = -1;
let lastCheck = 0;
let searchText = new Map<string, string>(); // id -> normalized searchable text

function empty(): InventoryFile {
  return { version: 1, pulledAt: null, products: {}, queries: {} };
}

/** Load lazily; pick up a pull written by the CLI while the server is running. */
function db(): InventoryFile {
  const now = Date.now();
  if (inv && now - lastCheck < 2000) return inv;
  lastCheck = now;
  let mtime = 0;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { /* no file yet */ }
  if (!inv || mtime !== loadedMtime) {
    try { inv = { ...empty(), ...(JSON.parse(fs.readFileSync(FILE, 'utf8')) as InventoryFile) }; } catch { inv = empty(); }
    loadedMtime = mtime;
    searchText = new Map();
  }
  return inv;
}

let saveTimer: NodeJS.Timeout | null = null;
export function saveInventory(immediate = false) {
  const write = () => {
    saveTimer = null;
    if (!inv) return;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(inv));
    fs.renameSync(tmp, FILE);
    loadedMtime = fs.statSync(FILE).mtimeMs;
  };
  if (immediate) { if (saveTimer) clearTimeout(saveTimer); write(); return; }
  if (!saveTimer) saveTimer = setTimeout(write, 500);
}

export const norm = (s: string) => ` ${s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;

function textOf(p: Product): string {
  let t = searchText.get(p.id);
  if (!t) { t = norm(`${p.title} ${p.brand ?? ''} ${p.description ?? ''}`); searchText.set(p.id, t); }
  return t;
}

// ------------------------------------------------------------------------------------------ admission

/**
 * Classify a raw listing into one of our categories and drop parts/accessories. IKEA's product type name
 * ("Sofa with chaise", "Cover for loveseat") is the most reliable signal; for other stores the title wins and
 * the category we searched for is the fallback.
 */
const UPHOLSTERED = new Set(['sofa', 'armchair', 'ottoman', 'bed', 'dining_chair', 'bench']);
const TEXTILES = new Set(['leather', 'faux leather', 'velvet', 'boucle', 'linen', 'cotton', 'wool', 'chenille', 'microfiber', 'fabric', 'rattan', 'plastic', 'metal', 'wood']);
const GENERIC_TYPE = /^(chair|table|stool|chair with (cushion|armrests)|folding chair|extendable table|drop-leaf table|gateleg table|folding table)$/i;

export function admit(p: Product, hintCategory?: string): Product | null {
  if (!p.title || !p.imageUrl) return null;
  const [typeName = '', path = ''] = p.source === 'ikea' ? (p.description ?? '').split(' | ') : [];
  const category = p.source === 'ikea'
    // "Chair" / "Table" alone need IKEA's category path ("Tables & chairs > Dining chairs") to be placed.
    ? matchCategory(typeName) ?? (GENERIC_TYPE.test(typeName.split(',')[0].trim()) ? matchCategory(path) : null)
    : matchCategory(p.title) ?? (hintCategory && matchCategory(hintCategory)) ?? null;
  if (!category) return null;
  if (isAccessory(p.title, category) || (typeName && isAccessory(typeName, category))) return null;
  const attrs = p.attrs ?? extractAttributes(`${p.title} ${p.description ?? ''}`);
  // IKEA upholstery names its fabric by range name only ("Knisa dark gray"): everything that isn't leather is fabric.
  if (p.source === 'ikea' && UPHOLSTERED.has(category) && !attrs.materials.some((m) => TEXTILES.has(m))) attrs.materials = [...attrs.materials, 'fabric'];
  const { why: _w, fitScore: _f, ...rest } = p;
  return { ...rest, category, attrs, model: { status: 'none' } };
}

export function addProducts(products: Product[], hintCategory: string | undefined): { added: number; kept: Product[] } {
  const d = db();
  let added = 0;
  const kept: Product[] = [];
  for (const raw of products) {
    const p = admit(raw, hintCategory);
    if (!p) continue;
    const prev = d.products[p.id];
    if (!prev) added++;
    // Keep colors we already guessed from the photo when the listing text still names none.
    if (prev?.attrs?.colorFromImage && !p.attrs?.colors.length) p.attrs = { ...p.attrs!, colors: prev.attrs.colors, colorFromImage: true };
    if (prev?.dims && !p.dims) { p.dims = prev.dims; p.dimsSource = prev.dimsSource; }
    d.products[p.id] = p;
    searchText.delete(p.id);
    kept.push(p);
  }
  saveInventory();
  return { added, kept };
}

/** Re-file a catalog product under another furniture type (a mini race-car lamp is a table lamp, not a floor lamp). */
export function setInventoryCategory(id: string, category: string) {
  const p = db().products[id];
  if (!p || p.category === category) return;
  p.category = category;
  saveInventory();
}

/** Store measured dimensions (e.g. from the IKEA product page) so they're never fetched twice. */
export function setListingDims(id: string, dims: Dims) {
  const p = db().products[id];
  if (!p || p.dims) return;
  p.dims = dims;
  p.dimsSource = 'listing';
  saveInventory();
}

export function setOfficialModel(id: string, has: boolean) {
  const p = db().products[id];
  if (!p || p.officialModel === has) return;
  p.officialModel = has;
  saveInventory();
}

export function setImageColors(id: string, colors: string[]) {
  const p = db().products[id];
  if (!p || !colors.length) return;
  p.attrs = { ...(p.attrs ?? { colors: [], materials: [], styles: [] }), colors, colorFromImage: true };
  saveInventory();
}

export const queryKey = (source: string, q: string) => `${source}:${norm(q).trim()}`;
export function recordQuery(key: string, count: number, source: 'pull' | 'live') {
  db().queries[key] = { at: Date.now(), count, source };
  saveInventory();
}
export const hasQuery = (key: string, maxAgeMs = 14 * 86400e3) => {
  const q = db().queries[key];
  return !!q && Date.now() - q.at < maxAgeMs;
};
export function markPulled() { db().pulledAt = Date.now(); saveInventory(true); }

export const inventoryProduct = (id: string): Product | undefined => db().products[id];
export const allInventory = (): Product[] => Object.values(db().products);

export function inventoryStats() {
  const d = db();
  const ps = Object.values(d.products);
  const count = (key: (p: Product) => string) => {
    const m = new Map<string, number>();
    for (const p of ps) m.set(key(p), (m.get(key(p)) ?? 0) + 1);
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  };
  return { total: ps.length, pulledAt: d.pulledAt, byCategory: count((p) => p.category), bySource: count((p) => p.source), stores: new Set(ps.map((p) => p.store)).size, queries: Object.keys(d.queries).length };
}

// ------------------------------------------------------------------------------------------ query

type Dim = 'category' | 'colors' | 'materials' | 'stores' | 'other';

function materialMatch(p: Product, wanted: string[]) {
  const have = p.attrs?.materials ?? [];
  return wanted.some((w) => (MATERIAL_FAMILY[w] ?? [w]).some((m) => have.includes(m)));
}

/** Does the listing show the theme (any one of its terms in the title / description)? */
export const matchesTheme = (p: Product, theme: string[]) => { const t = textOf(p); return theme.some((k) => keywordMatch(t, k)); };

export function keywordMatch(text: string, kw: string) {
  const k = norm(kw).trim();
  if (!k) return true;
  const stem = k.replace(/(es|s)$/, '');
  return text.includes(` ${k} `) || text.includes(` ${stem} `) || text.includes(` ${stem}s `) || text.includes(` ${stem}es `);
}

/** Which filter dimensions does this product fail? Stops after two (facets only need 0 or 1). */
function failures(p: Product, f: Filters): Dim[] {
  const out: Dim[] = [];
  const fail = (d: Dim) => { out.push(d); return out.length >= 2; };
  if (f.category && p.category !== f.category && fail('category')) return out;
  if (f.colors?.length && !f.colors.some((c) => p.attrs?.colors.includes(c)) && fail('colors')) return out;
  if (f.materials?.length && !materialMatch(p, f.materials) && fail('materials')) return out;
  if (f.stores?.length && !f.stores.some((s) => p.store.toLowerCase().includes(s.toLowerCase())) && fail('stores')) return out;
  let other = false;
  if ((f.minPrice || f.maxPrice) && (p.price == null || (f.minPrice && p.price < f.minPrice) || (f.maxPrice && p.price > f.maxPrice))) other = true;
  else if (f.minRating && (p.rating == null || p.rating < f.minRating)) other = true;
  // Demo mode is 3D-only, except themed requests: those products come from stores and won't have official models.
  else if ((f.only3d || (config.demo3dOnly && !f.theme?.length)) && p.officialModel !== true) other = true;
  else if (f.theme?.length && !matchesTheme(p, f.theme)) other = true;
  else if (p.dims && ((f.maxWidthM && p.dims.w > f.maxWidthM * 1.02) || (f.maxDepthM && p.dims.d > f.maxDepthM * 1.02) || (f.maxHeightM && p.dims.h > f.maxHeightM * 1.02))) other = true;
  else if (f.keywords?.length) { const t = textOf(p); if (!f.keywords.every((k) => keywordMatch(t, k))) other = true; }
  if (other) fail('other');
  return out;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'set', 'of', 'in', 'to', 'a', 'an']);

function relevance(p: Product, f: Filters, boost: string[]): number {
  let s = 0;
  if (p.rating && (p.reviews ?? 0) >= 3) s += (p.rating - 3.8) * 0.35;
  if (p.reviews) s += Math.min(0.3, Math.log10(p.reviews + 1) * 0.08);
  if (p.price != null) s += 0.1;
  if (p.source === 'ikea') s += 0.08; // official 3D models look the most real in the headset
  if (f.colors?.length && !p.attrs?.colorFromImage) s += 0.25; // color named in the listing, not guessed from the photo
  if (f.materials?.includes('leather') && p.attrs?.materials.includes('leather')) s += 0.15;
  for (const st of f.styles ?? []) if (p.attrs?.styles.includes(st)) s += 0.35;
  if (f.keywords?.length) { const t = norm(p.title); s += f.keywords.filter((k) => keywordMatch(t, k)).length * 0.15; }
  if (boost.length) { const t = norm(p.title); s += boost.filter((w) => t.includes(` ${w} `)).length * 0.12; }
  return s;
}

/** Product family: IKEA range name ("FINNALA"), otherwise the store. Variants of one family shouldn't fill the page. */
const family = (p: Product) => (p.source === 'ikea' ? `ikea:${p.title.split(' ')[0]}` : `store:${p.store}`);

/** Relevance order with a light penalty for repeating a store or product family, so results stay varied. */
function diversify(scored: { p: Product; s: number }[]): Product[] {
  const out: Product[] = [];
  const stores = new Map<string, number>();
  const families = new Map<string, number>();
  const pool = [...scored].sort((a, b) => b.s - a.s);
  while (pool.length && out.length < 200) {
    let bi = 0, bs = -Infinity;
    for (let i = 0; i < Math.min(pool.length, 30); i++) {
      const p = pool[i].p;
      const v = pool[i].s - 0.12 * (stores.get(p.store) ?? 0) - (p.source === 'ikea' ? 0.3 * (families.get(family(p)) ?? 0) : 0);
      if (v > bs) { bs = v; bi = i; }
    }
    const [pick] = pool.splice(bi, 1);
    out.push(pick.p);
    stores.set(pick.p.store, (stores.get(pick.p.store) ?? 0) + 1);
    families.set(family(pick.p), (families.get(family(pick.p)) ?? 0) + 1);
  }
  return [...out, ...pool.map((x) => x.p)];
}

export interface QueryResult { products: Product[]; total: number; priceRange: BrowseResult['priceRange']; facets: BrowseResult['facets'] }

export function queryInventory(f: Filters, opts: { limit?: number; boostText?: string } = {}): QueryResult {
  const all = Object.values(db().products);
  const boost = opts.boostText ? norm(opts.boostText).trim().split(' ').filter((w) => w.length > 2 && !STOP.has(w)) : [];
  const facetCounts = { category: new Map<string, number>(), colors: new Map<string, number>(), materials: new Map<string, number>(), stores: new Map<string, number>() };
  const bump = (m: Map<string, number>, vals: string[]) => { for (const v of new Set(vals)) m.set(v, (m.get(v) ?? 0) + 1); };
  const matched: Product[] = [];

  for (const p of all) {
    const fails = failures(p, f);
    if (fails.length > 1) continue;
    const only = fails[0];
    // Facet counts ignore the facet's own filter ("black (12)" stays visible after picking "brown").
    if (!only || only === 'category') bump(facetCounts.category, [p.category]);
    if (!only || only === 'colors') bump(facetCounts.colors, p.attrs?.colors ?? []);
    if (!only || only === 'materials') bump(facetCounts.materials, p.attrs?.materials ?? []);
    if (!only || only === 'stores') bump(facetCounts.stores, [p.store]);
    if (!only) matched.push(p);
  }

  const sort = f.sort ?? 'relevance';
  let ordered: Product[];
  if (sort === 'price_asc' || sort === 'price_desc') {
    const dir = sort === 'price_asc' ? 1 : -1;
    ordered = [...matched].sort((a, b) => (a.price == null ? 1 : b.price == null ? -1 : (a.price - b.price) * dir));
  } else if (sort === 'rating') {
    ordered = [...matched].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.reviews ?? 0) - (a.reviews ?? 0));
  } else {
    ordered = diversify(matched.map((p) => ({ p, s: relevance(p, f, boost) })));
  }

  const prices = matched.map((p) => p.price).filter((v): v is number => v != null).sort((a, b) => a - b);
  const toFacets = (m: Map<string, number>): Facet[] => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  return {
    products: ordered.slice(0, opts.limit ?? 48),
    total: matched.length,
    priceRange: prices.length ? { min: prices[0], max: prices[prices.length - 1], median: prices[Math.floor(prices.length / 2)] } : null,
    facets: { categories: toFacets(facetCounts.category), colors: toFacets(facetCounts.colors), materials: toFacets(facetCounts.materials), stores: toFacets(facetCounts.stores).slice(0, 12) },
  };
}

/** All matches (not just the first page), for answering "what's the average price" style questions. */
export function allMatches(f: Filters): Product[] {
  return Object.values(db().products).filter((p) => failures(p, f).length === 0);
}
