import { CATEGORIES, categoryDef } from './catalog.js';
import { config } from './config.js';
import { inventoryProduct, queryInventory, setListingDims } from './inventory/inventory.js';
import { ensureModel } from './models/pipeline.js';
import { fetchIkeaDims } from './search/ikea.js';
import { getProduct, getSession, saveSession, updateProduct, upsertProduct } from './store.js';
import { mapLimit } from './util/http.js';
import { errMsg, log } from './util/log.js';
import { categoryChoices, categoryForBox, isOpening, labelName, primaryLabel, sizeError } from './realPose.js';
import type { Filters, Product, RealPiece, RoomGeometry, RoomObject, Session } from './types.js';

// The user's real furniture (Space Setup boxes) as first-class pieces they can keep or replace. The headset owns the
// geometry (and the user's box adjustments); the session owns the decisions, so voice, the phone and "Design my room"
// all see the same state.

/** Rebuild the piece list from newly uploaded geometry, keeping the user's decisions for pieces that still exist. */
export function syncPieces(prev: Record<string, RealPiece> | undefined, geo: RoomGeometry): Record<string, RealPiece> {
  const out: Record<string, RealPiece> = {};
  for (const o of geo.objects ?? []) {
    if (!o.id || isOpening(o.label)) continue;
    const old = prev?.[o.id];
    const auto = categoryForBox(o.label, o.size);
    const category = old?.categorySource === 'user' ? old.category : auto;
    out[o.id] = {
      id: o.id,
      label: primaryLabel(o.label),
      category,
      categorySource: old?.categorySource ?? 'auto',
      choices: categoryChoices(o.label, category),
      state: old?.state ?? 'keep',
      ...(old?.replacementId ? { replacementId: old.replacementId } : {}),
      updatedAt: old?.updatedAt ?? Date.now(),
    };
  }
  return out;
}

export const pieceBox = (s: Session, pieceId: string): RoomObject | undefined => s.geometry?.objects.find((o) => o.id === pieceId);

export interface PiecePatch { state?: 'keep' | 'replace'; category?: string; replacementId?: string | null }

/** Apply the user's decision for one piece (keep / replace, its type, the product standing in for it). */
export function setPiece(sessionId: string, pieceId: string, patch: PiecePatch): Session {
  const s = getSession(sessionId);
  if (!s) throw Object.assign(new Error('Session not found'), { status: 404 });
  const cur = s.realFurniture?.[pieceId];
  if (!cur) throw Object.assign(new Error('Unknown piece: upload the room geometry first'), { status: 404 });
  const next: RealPiece = { ...cur, updatedAt: Date.now() };
  if (patch.state !== undefined) {
    if (patch.state !== 'keep' && patch.state !== 'replace') throw Object.assign(new Error('state must be keep or replace'), { status: 400 });
    next.state = patch.state;
  }
  if (patch.category !== undefined) {
    if (!CATEGORIES.some((c) => c.key === patch.category)) throw Object.assign(new Error(`Unknown category ${patch.category}`), { status: 400 });
    next.category = patch.category;
    next.categorySource = 'user';
    next.choices = categoryChoices(cur.label, patch.category).concat(cur.choices).filter((c, i, a) => a.indexOf(c) === i);
  }
  if (patch.replacementId === null) delete next.replacementId;
  else if (typeof patch.replacementId === 'string' && patch.replacementId) next.replacementId = patch.replacementId;
  if (next.state === 'keep') delete next.replacementId;
  return saveSession({ ...s, realFurniture: { ...(s.realFurniture ?? {}), [pieceId]: next } });
}

// ------------------------------------------------------------------------------------------ replacement candidates

const dimsJobs = new Map<string, Promise<void>>();

/** Most catalog items have no size until their model is built; IKEA's product page has exact measurements (free). */
async function ensureListingDims(p: Product): Promise<void> {
  if (p.dims || p.source !== 'ikea' || !p.productUrl) return;
  const known = inventoryProduct(p.id)?.dims;
  if (known) { p.dims = known; return; }
  let job = dimsJobs.get(p.id);
  if (!job) {
    job = fetchIkeaDims(p.productUrl)
      .then((d) => {
        if (!d) return;
        setListingDims(p.id, d);
        const stored = getProduct(p.id);
        if (stored && !stored.dims) updateProduct(p.id, { dims: d, dimsSource: 'listing' });
      })
      .catch((e) => log.warn('real', `dims for ${p.id}: ${errMsg(e)}`))
      .finally(() => dimsJobs.delete(p.id));
    dimsJobs.set(p.id, job);
  }
  await job;
  p.dims = inventoryProduct(p.id)?.dims ?? p.dims;
}

function candidatePool(s: Session, category: string, extra: Filters, limit: number): Product[] {
  const boost = [...(s.room?.styleTags ?? []), ...(extra.keywords ?? [])].join(' ');
  const f: Filters = { ...extra, category, ...(config.demo3dOnly ? { only3d: true } : {}) };
  delete f.maxWidthM; delete f.maxDepthM; delete f.maxHeightM; // size comes from the real piece instead
  return queryInventory(f, { limit, boostText: boost }).products;
}

/**
 * Products that could stand in for a real piece: same type (or the one the user asked for), sized like the piece
 * (within 25%, then 40%, then closest), ranked for the room's style. The first few get their 3D models warmed up so
 * cycling through them in the headset is instant.
 */
export async function replacementCandidates(s: Session, piece: RealPiece, extra: Filters = {}, limit = 12): Promise<{ category: string | null; products: Product[] }> {
  const category = extra.category ?? piece.category;
  const box = pieceBox(s, piece.id);
  if (!category || !box) return { category: category ?? null, products: [] };
  const pool = candidatePool(s, category, extra, 48);
  await mapLimit(pool.slice(0, 30), 4, ensureListingDims);
  const scored = pool.map((p, rank) => {
    const e = sizeError(p.dims, box);
    return { p, rank, e: e ?? 1, tier: e == null ? 2 : e <= 0.25 ? 0 : e <= 0.4 ? 1 : 2 };
  });
  scored.sort((a, b) => a.tier - b.tier || a.rank * 0.02 + a.e - (b.rank * 0.02 + b.e));
  // upsertProduct keeps model state we already have and fills in sizes fetched just now.
  const products = scored.slice(0, limit).map((x) => upsertProduct({ ...x.p }));
  for (const p of products.slice(0, 5)) ensureModel(p.id, { allowGenerate: false });
  log.info('real', `${s.id} ${piece.label} -> ${category}: ${products.length} candidates (${scored.filter((x) => x.tier === 0).length} within 25% of its size)`);
  return { category, products };
}

/** After a room upload: fetch sizes for each piece's likely replacements in the background, so Replace is instant. */
export function warmCandidates(s: Session) {
  const cats = [...new Set(Object.values(s.realFurniture ?? {}).map((p) => p.category).filter((c): c is string => !!c))];
  void mapLimit(cats, 1, async (c) => { await mapLimit(candidatePool(s, c, {}, 30), 3, ensureListingDims); })
    .catch((e) => log.warn('real', `warm: ${errMsg(e)}`));
}

// ------------------------------------------------------------------------------------------ voice

const HINTS: [RegExp, (p: RealPiece) => boolean][] = [
  [/\b(couch|sofa|sectional|loveseat|settee)\b/, (p) => p.label === 'COUCH' || p.category === 'sofa'],
  [/\b(arm ?chair|chair)\b/, (p) => p.category === 'armchair' || p.label === 'COUCH'],
  [/\bbed\b/, (p) => p.label === 'BED'],
  [/\bcoffee table\b/, (p) => p.category === 'coffee_table'],
  [/\b(dining table|kitchen table)\b/, (p) => p.category === 'dining_table'],
  [/\bside table|end table\b/, (p) => p.category === 'side_table'],
  [/\bdesk\b/, (p) => p.category === 'desk' || p.label === 'DESK'],
  [/\btable\b/, (p) => p.label === 'TABLE' || p.label === 'DESK'],
  [/\b(dresser|cabinet|shel(f|ves)|book ?case|bookshelf|storage|drawers|sideboard|tv stand|media console|nightstand)\b/, (p) => p.label === 'STORAGE' || p.label === 'SHELF'],
  [/\blamp\b/, (p) => p.label === 'LAMP'],
  [/\bplant\b/, (p) => p.label === 'PLANT'],
  [/\b(tv|screen|television)\b/, (p) => p.label === 'SCREEN'],
];

/** Which real piece "replace my couch" / "swap this table" means: the pointed one, else by name, else the only one. */
export function findPiece(s: Session, hint: string, pointedId?: string): RealPiece | undefined {
  const pieces = Object.values(s.realFurniture ?? {});
  if (pointedId && s.realFurniture?.[pointedId]) return s.realFurniture[pointedId];
  const t = ` ${hint.toLowerCase()} `;
  const user = s.geometry?.user?.position;
  const nearest = (ps: RealPiece[]) => {
    if (!user || ps.length < 2) return ps[0];
    const d = (p: RealPiece) => { const b = pieceBox(s, p.id); return b ? Math.hypot(b.center.x - user.x, b.center.z - user.z) : 99; };
    return [...ps].sort((a, b) => d(a) - d(b))[0];
  };
  for (const [re, ok] of HINTS) {
    if (!re.test(t)) continue;
    const m = pieces.filter(ok);
    if (m.length) return nearest(m);
  }
  return pieces.length === 1 ? pieces[0] : undefined;
}

/** "couch (sofa)" lines for the assistant prompt, so it knows what the user can refer to. */
export const describePieces = (s: Session) =>
  Object.values(s.realFurniture ?? {}).map((p) => `${labelName(p.label)}${p.category ? ` (${categoryDef(p.category).label.toLowerCase()})` : ''}${p.state === 'replace' ? ', being replaced' : ''}`);
