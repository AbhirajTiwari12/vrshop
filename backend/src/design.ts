import { CATEGORIES, categoryDef } from './catalog.js';
import { config } from './config.js';
import { chatJson, hasOpenAI } from './ai/openai.js';
import { STYLE_PROFILES, matchStyle, styleProfile, styleScore, type StyleProfile } from './ai/styles.js';
import { allInventory } from './inventory/inventory.js';
import { hasOfficialModel } from './inventory/official3d.js';
import { defaultGeometry, roomModel, solveRoom, type KeptPiece, type LayoutItem, type LayoutResult, type RoomModel } from './layout.js';
import { ensureModel, waitForModels } from './models/pipeline.js';
import { setPiece } from './realFurniture.js';
import { labelName, replacementPose, sizeError } from './realPose.js';
import { getProduct, getSession, saveSession, upsertProduct } from './store.js';
import { mapLimit } from './util/http.js';
import { errMsg, log } from './util/log.js';
import type { CategoryResult, Dims, Product, RealPiece, RoomGeometry, RoomObject, Session, Vec3 } from './types.js';

// "Design my room" end to end:
//   1. what the room is (bedroom? how big? what real furniture is in it?) -> a plan of pieces that suits it
//   2. real catalog products for each piece that fit the chosen style AND each other (heuristic shortlist, then
//      the designer model picks one coherent set), preferring IKEA pieces with official 3D models
//   3. replacement, never overlap: a planned piece whose kind is already in the room takes that piece's spot. For the
//      user's real furniture that's the same keep / replace state as the piece's card (realFurniture.ts): the piece is
//      set to "replace" with the design's pick, and the headset paints it out and stands the pick in its spot. Virtual
//      pieces placed earlier that the design supersedes are removed.
//   4. the layout solver arranges it all around what stays (layout.ts)

/** A piece currently standing in the headset scene. */
export interface PlacedPiece { instanceId: string; productId: string; category: string; position: Vec3; yawDeg: number; dims?: Dims; replacesPieceId?: string }

/** Where a designed piece goes. With replacesPieceId, the headset's real-furniture sync stands it in that piece's spot. */
export interface DesignPlacement { productId: string; position: Vec3; yawDeg: number; reason?: string; instanceId?: string; replacesPieceId?: string }

export interface DesignRequest {
  mode: 'style' | 'bag';
  style?: string | null;           // style key; empty = match the room's own style
  placed: PlacedPiece[];
  user?: RoomGeometry['user'];
}

export interface DesignResult {
  mode: 'style' | 'bag';
  style: string | null;
  styleLabel: string;
  roomType: string;
  concept: string;                 // what the designer says
  placements: DesignPlacement[];
  remove: string[];                // headset instances to delete: superseded by the new pieces
  replacedPieces: string[];        // real pieces (Space Setup ids) the new pieces stand in for (now state "replace")
  replacedLabels: string[];
  skipped: { productId: string; label: string; reason: string }[];
  total: number;
  usedDefaultRoom: boolean;
}

type RoomKind = 'living room' | 'bedroom' | 'home office' | 'dining room';

// ------------------------------------------------------------------------------------------ the room

function roomKind(s: Session, geo: RoomGeometry): RoomKind {
  if (geo.objects.some((o) => /\bBED\b/.test(o.label))) return 'bedroom';
  const t = (s.room?.roomType ?? s.prompt ?? '').toLowerCase();
  if (/bed/.test(t)) return 'bedroom';
  if (/office|study|work/.test(t)) return 'home office';
  if (/dining|kitchen/.test(t)) return 'dining room';
  return 'living room';
}

/** Which pieces a well-furnished room of this kind and size gets (category, how many). */
export function roomPlan(kind: RoomKind, area: number, geo: RoomGeometry): [string, number][] {
  const hasScreen = geo.objects.some((o) => /SCREEN/.test(o.label));
  switch (kind) {
    case 'bedroom':
      return [
        ['bed', 1], ['nightstand', area < 9 ? 1 : 2], ['table_lamp', area < 9 ? 1 : 2], ['rug', 1],
        ...(area >= 10 ? [['dresser', 1] as [string, number]] : []), ['wall_art', 1], ['plant', 1],
        ...(area >= 13 ? [['mirror', 1] as [string, number]] : []), ...(area >= 16 ? [['armchair', 1] as [string, number]] : []),
      ];
    case 'home office':
      return [
        ['desk', 1], ['office_chair', 1], ['bookshelf', 1], ['floor_lamp', 1], ['rug', 1], ['plant', 1], ['wall_art', 1],
        ...(area >= 11 ? [['armchair', 1] as [string, number]] : []), ...(area >= 14 ? [['side_table', 1] as [string, number]] : []),
      ];
    case 'dining room':
      return [
        ['dining_table', 1], ['dining_chair', area >= 11 ? 4 : 2], ['rug', 1], ...(area >= 10 ? [['dresser', 1] as [string, number]] : []),
        ['wall_art', 1], ['plant', 1], ['floor_lamp', 1],
      ];
    default:
      if (area < 9) return [['sofa', 1], ['coffee_table', 1], ['rug', 1], ['floor_lamp', 1], ['plant', 1], ['wall_art', 1]];
      return [
        ['sofa', 1], ['coffee_table', 1], ['rug', 1], ['armchair', area >= 17 ? 2 : 1], ['floor_lamp', 1], ['side_table', 1],
        ...(area >= 12 || hasScreen ? [['tv_stand', 1] as [string, number]] : []), ['plant', 1], ['wall_art', 1],
        ...(area >= 18 ? [['bookshelf', 1] as [string, number]] : []), ...(area >= 15 ? [['table_lamp', 1] as [string, number]] : []),
      ];
  }
}

// A real piece can be replaced by a planned piece of the same family (a small "couch" by an accent chair).
const FAMILY: Record<string, string[]> = {
  sofa: ['sofa', 'armchair'], armchair: ['armchair', 'sofa'],
  coffee_table: ['coffee_table', 'side_table', 'ottoman'], side_table: ['side_table', 'nightstand', 'coffee_table'], nightstand: ['nightstand', 'side_table'],
  tv_stand: ['tv_stand', 'dresser', 'cabinet'], dresser: ['dresser', 'cabinet', 'tv_stand'], bookshelf: ['bookshelf', 'cabinet'],
  desk: ['desk', 'dining_table'], dining_table: ['dining_table', 'desk'],
};

// ------------------------------------------------------------------------------------------ products

// Rough share of the budget per piece, so a $1,500 room doesn't spend $1,400 on the sofa.
const BUDGET_WEIGHT: Record<string, number> = { sofa: 0.3, bed: 0.3, dining_table: 0.22, desk: 0.18, armchair: 0.12, dresser: 0.12, tv_stand: 0.1, bookshelf: 0.08, coffee_table: 0.08, rug: 0.08, office_chair: 0.08, cabinet: 0.08, dining_chair: 0.04, nightstand: 0.04, mirror: 0.04, floor_lamp: 0.04, side_table: 0.03, wall_art: 0.03, table_lamp: 0.02, plant: 0.02, ottoman: 0.03, bench: 0.05 };

// Wrong product for a furnished adult room, or wrong for this room's size.
const NEVER = /\b(bunk|loft bed|crib|cot|children|kids?|baby|toddler|junior|doll|pet|cat|dog|outdoor|patio|gaming)\b/i;
function sizeOk(p: Product, category: string, area: number, longestWall: number): boolean {
  const t = p.title.toLowerCase();
  if (NEVER.test(t)) return false;
  // IKEA files kids' pieces under "Baby & kids" / "Children's …" even when the title doesn't say so.
  if (/baby & kids|children's|kids rugs|nursery/i.test(p.description ?? '')) return false;
  if (category === 'sofa' && /sectional|corner sofa|u-shaped|u shaped|modular|with chaise|4-seat|5-seat|6-seat/.test(t) && (area < 16 || longestWall < 3.4)) return false;
  if (category === 'bed' && /\bking\b/.test(t) && area < 13) return false;
  if (category === 'bed' && /\b(twin|single|day-?bed)\b/.test(t) && area >= 9) return false;
  if (category === 'dining_table' && /\b(8|10)\b.*seat|seats (8|10)/.test(t) && area < 16) return false;
  if (categoryDef(category).mount === 'floor' && /\bwall (shelf|shelves|cabinet|mounted)|wall-mounted/.test(t)) return false;
  if (category === 'rug' && (/runner/.test(t) || /runners & small rugs|door ?mat/i.test(p.description ?? ''))) return false;
  // The plan's plant is a floor plant: no hanging ivy, succulent sets or tabletop pots.
  if (category === 'plant' && /hanging|set of|succulent|lucky bamboo|plant box|castors|wax plant|\bivy\b|bouquet|cactus|orchid|herb|\bmini\b/.test(t)) return false;
  if (p.dims) {
    const long = Math.max(p.dims.w, p.dims.d);
    if (long > longestWall - 0.3 && categoryDef(category).mount === 'floor' && category !== 'rug') return false;
  }
  return true;
}

interface Pick { category: string; product: Product; why: string }

const str = { type: 'string' } as const;
const PICK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['concept', 'picks'],
  properties: {
    concept: str,
    picks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['category', 'ids', 'why'], properties: { category: { type: 'string', enum: CATEGORIES.map((c) => c.key) }, ids: { type: 'array', items: str }, why: str } } },
  },
};

async function choose(style: StyleProfile, plan: [string, number][], ctx: { kind: RoomKind; area: number; width: number; depth: number; longestWall: number; budget: number | null; keptNote: string; realSize: Map<string, RoomObject> }): Promise<{ picks: Pick[]; concept: string }> {
  const inventory = allInventory();
  const weights = plan.reduce((s, [c, n]) => s + (BUDGET_WEIGHT[c] ?? 0.05) * n, 0);
  const shortlist = new Map<string, Product[]>();
  for (const [category] of plan) {
    const alloc = ctx.budget ? (ctx.budget * (BUDGET_WEIGHT[category] ?? 0.05)) / weights : null;
    const scored = inventory
      .filter((p) => p.category === category && p.imageUrl && sizeOk(p, category, ctx.area, ctx.longestWall))
      .filter((p) => !alloc || p.price == null || p.price <= alloc * 2.2)
      .map((p) => {
        let s = styleScore(p, style);
        if (p.officialModel === true) s += 0.4;
        else if (p.officialModel === false) s -= config.demo3dOnly ? 5 : 0.6;
        if (alloc && p.price != null) s -= Math.max(0, p.price / alloc - 1.2) * 0.4;
        if (p.price == null) s -= 0.3;
        if (category === 'plant' && /tree|monstera|fig|palm|bird of paradise|olive|dracaena|fiddle|yucca|strelitzia|bamboo/i.test(p.title)) s += 0.6;
        // Replacing the user's own piece: about its size, so it stands in its spot.
        const real = ctx.realSize.get(category);
        if (real) { const e = sizeError(p.dims, real); s -= e == null ? 0.4 : Math.max(0, e - 0.15) * 2.5; }
        return { p, s };
      })
      .sort((a, b) => b.s - a.s);
    // Varied shortlist: at most two variants of one IKEA range.
    const out: Product[] = [];
    const ranges = new Map<string, number>();
    for (const { p } of scored) {
      const r = p.title.split(/[\s,]/)[0];
      if ((ranges.get(r) ?? 0) >= 2) continue;
      ranges.set(r, (ranges.get(r) ?? 0) + 1);
      out.push(p);
      if (out.length >= 12) break;
    }
    shortlist.set(category, out);
  }

  // The designer model picks one coherent set from the shortlists (text only: fast, cheap).
  let concept = `A ${style.label.toLowerCase()} ${ctx.kind}: ${style.blurb.charAt(0).toLowerCase()}${style.blurb.slice(1)}.`;
  const ranked = new Map<string, { ids: string[]; why: string }>();
  if (hasOpenAI()) {
    try {
      const alias = new Map<string, string>();
      const blocks = plan.map(([category, count]) => {
        const rows = (shortlist.get(category) ?? []).map((p, i) => {
          const a = `${category.slice(0, 2)}${i + 1}`;
          alias.set(a, p.id);
          const attrs = [...(p.attrs?.colors ?? []).slice(0, 2), ...(p.attrs?.materials ?? []).slice(0, 2)].join(', ');
          return `  ${a} | ${p.title} | ${p.priceText || 'price n/a'}${attrs ? ` | ${attrs}` : ''}${p.dims ? ` | ${p.dims.w}x${p.dims.d}x${p.dims.h} m` : ''}`;
        });
        const real = ctx.realSize.get(category);
        const fit = real ? `; replaces their ${Math.max(real.size.x, real.size.z).toFixed(1)} x ${Math.min(real.size.x, real.size.z).toFixed(1)} m one, so keep close to that size` : '';
        return `${categoryDef(category).label} (${category}${count > 1 ? `, ${count} matching` : ''}${fit}):\n${rows.join('\n') || '  (none)'}`;
      });
      const r = await chatJson<{ concept: string; picks: { category: string; ids: string[]; why: string }[] }>({
        messages: [
          { role: 'system', content: 'You are a senior interior designer choosing real catalog products for one coherent room. Output only JSON.' },
          {
            role: 'user',
            content: `Design a ${style.label} ${ctx.kind}.\nStyle brief: ${style.brief}\n` +
              `Room: about ${ctx.width.toFixed(1)} x ${ctx.depth.toFixed(1)} m (${ctx.area.toFixed(0)} m²).${ctx.keptNote}\n` +
              `${ctx.budget ? `Budget: about $${ctx.budget} for all of these pieces together.` : 'No fixed budget: keep it sensible.'}\n\n` +
              `For EVERY category below, rank up to 3 candidate ids, best first. The pieces must work together as one room: one wood-tone family, one metal finish, ` +
              `a palette of two or three colors plus neutrals, scale that suits the room (no oversized pieces in a small room). A piece that is clearly the wrong ` +
              `type or clashes with the style ranks last. Use only ids from the lists.\n` +
              `concept: one warm, specific sentence (max 24 words) the designer says out loud describing the look, e.g. palette and signature pieces; no brand or range names, no prices.\n` +
              `why: max 10 words, how that piece serves the look.\n\n${blocks.join('\n\n')}`,
          },
        ],
        schemaName: 'room_design',
        schema: PICK_SCHEMA,
        effort: 'low',
        timeoutMs: 45000,
      });
      if (r.concept?.trim()) concept = r.concept.trim();
      for (const x of r.picks ?? []) ranked.set(x.category, { ids: x.ids.map((a) => alias.get(a) ?? a).filter((id) => shortlist.get(x.category)?.some((p) => p.id === id)), why: x.why });
    } catch (e) {
      log.warn('design', `designer pick failed, heuristic: ${errMsg(e)}`);
    }
  }

  // Resolve each category to one product, preferring a real (official) 3D model; checks are free HEAD requests.
  const picks: Pick[] = [];
  await mapLimit(plan, 3, async ([category]) => {
    const list = shortlist.get(category) ?? [];
    const pref = ranked.get(category);
    const order = [...(pref?.ids ?? []).map((id) => list.find((p) => p.id === id)!).filter(Boolean), ...list.filter((p) => !pref?.ids.includes(p.id))];
    let chosen: Product | undefined;
    for (let i = 0; i < Math.min(order.length, config.demo3dOnly ? 12 : 4) && !chosen; i++) if (await hasOfficialModel(order[i])) chosen = order[i];
    if (!chosen && !config.demo3dOnly) chosen = order[0];
    if (chosen) picks.push({ category, product: chosen, why: pref?.why || `${style.label} ${categoryDef(category).label.toLowerCase()}` });
  });
  return { picks, concept };
}

// ------------------------------------------------------------------------------------------ design

export async function designRoom(sessionId: string, req: DesignRequest): Promise<DesignResult> {
  const s = getSession(sessionId);
  if (!s) throw Object.assign(new Error('Session not found'), { status: 404 });
  const geo: RoomGeometry = s.geometry ? { ...s.geometry } : defaultGeometry(req.user);
  if (req.user) geo.user = req.user;
  const probe = roomModel(geo);
  const xs = probe.poly.map((p) => p.x), zs = probe.poly.map((p) => p.z);
  const width = Math.max(...xs) - Math.min(...xs), depth = Math.max(...zs) - Math.min(...zs);
  const longestWall = Math.max(0, ...probe.walls.map((w) => w.width));
  const kind = roomKind(s, geo);
  const placed = (req.placed ?? []).filter((x) => x && x.instanceId && x.productId);

  // ---- what goes in: a styled plan, or the bag
  let styleKey: string | null = null;
  let concept = '';
  let items: { productId: string; category: string; why?: string }[] = [];
  if (req.mode === 'bag') {
    for (const c of s.cart) {
      const p = getProduct(c.productId);
      if (p) for (let i = 0; i < Math.min(4, c.qty); i++) items.push({ productId: p.id, category: p.category });
    }
    if (!items.length) throw Object.assign(new Error('Your bag is empty'), { status: 400 });
  } else {
    styleKey = styleProfile(req.style)?.key ?? matchStyle([...(s.room?.styleTags ?? []), s.prompt].join(' ')) ?? 'modern';
    const style = styleProfile(styleKey)!;
    const plan = roomPlan(kind, probe.area, geo);
    const keptCats = placed.filter((x) => !plan.some(([c]) => c === x.category)).map((x) => categoryDef(x.category).label.toLowerCase());
    const keptNote = keptCats.length ? ` Staying in the room: ${[...new Set(keptCats)].join(', ')}.` : '';
    // The user's own pieces of a planned kind get replaced: the picks should be about their size.
    const realSize = new Map<string, RoomObject>();
    for (const piece of Object.values(s.realFurniture ?? {})) {
      const box = geo.objects.find((o) => o.id === piece.id);
      const prev = piece.category ? realSize.get(piece.category) : undefined;
      if (box && piece.category && (!prev || box.size.x * box.size.z > prev.size.x * prev.size.z)) realSize.set(piece.category, box);
    }
    const chosen = await choose(style, plan, { kind, area: probe.area, width, depth, longestWall, budget: s.budget, keptNote, realSize });
    concept = chosen.concept;
    for (const [category, count] of plan) {
      const pick = chosen.picks.find((x) => x.category === category);
      if (!pick) continue;
      if (!getProduct(pick.product.id)) upsertProduct({ ...pick.product });
      for (let i = 0; i < count; i++) items.push({ productId: pick.product.id, category, why: pick.why });
    }
    if (!items.length) throw Object.assign(new Error(`I couldn't find ${style.label.toLowerCase()} pieces with 3D models in the catalog`), { status: 404 });
  }

  // Real 3D models first, so pieces are laid out at their true size (official IKEA models: free download).
  const ids = [...new Set(items.map((i) => i.productId))];
  for (const id of ids) if (getProduct(id)?.officialModel || config.demo3dOnly) ensureModel(id, { allowGenerate: false });
  await waitForModels(ids, 20000);
  const dimsOf = (id: string, category: string): Dims => {
    const d = getProduct(id)?.dims ?? categoryDef(category).dims;
    // Some picture/mirror models are measured lying flat: thin side is depth when it hangs on a wall.
    return categoryDef(category).mount === 'wall' && d.h < d.d ? { w: d.w, d: d.h, h: d.d } : d;
  };

  const layoutItems = items.map((it) => ({ ...it, dims: dimsOf(it.productId, it.category), isSet: isSet(getProduct(it.productId)) }));
  const t0 = Date.now();
  const { layout, remove, paintOut } = arrangeDesign({ geo, mode: req.mode, items: layoutItems, realFurniture: s.realFurniture, placed, titleOf: (id) => getProduct(id)?.title, dimsOf });
  log.info('design', `${sessionId} ${req.mode}${styleKey ? ` ${styleKey}` : ''} ${kind} ${probe.area.toFixed(1)} m²: ${layout.placements.length} placed, ${layout.skipped.length} skipped, ${remove.length} superseded, ${layout.freedObjects.length} real replaced, ${paintOut.length} painted out (${Date.now() - t0} ms)`);

  // The real pieces the design stands in for are now "replace" with its pick, same as choosing it on the piece's card.
  for (const p of layout.placements) {
    const id = p.replaced?.objectId;
    if (!id) continue;
    const cur = getSession(sessionId)!.realFurniture?.[id];
    const category = getProduct(p.productId)?.category;
    setPiece(sessionId, id, { state: 'replace', replacementId: p.productId, ...(category && cur && category !== cur.category ? { category } : {}) });
  }
  // Real pieces whose new counterpart stands somewhere better than their spot: painted out, nothing in their place.
  for (const id of paintOut) setPiece(sessionId, id, { state: 'replace', replacementId: null });

  const paintedLabels = paintOut.map((id) => { const o = geo.objects.find((x) => x.id === id); return o ? `your ${labelName(o.label)}` : ''; });
  const replacedLabels = [...new Set([...layout.placements.map((p) => p.replaced?.label), ...paintedLabels].filter((x): x is string => !!x))];
  const skipped = layout.skipped.map((x) => ({ productId: x.productId, label: categoryDef(x.category).label, reason: x.reason }));
  const total = Math.round(layout.placements.reduce((sum, p) => sum + (getProduct(p.productId)?.price ?? 0), 0));
  const style = styleProfile(styleKey);

  // Keep the design as a shelf in "For you" so every piece can be opened, bagged or bought.
  if (req.mode === 'style' && style) {
    const cur = getSession(sessionId)!;
    const row: CategoryResult = {
      category: 'design',
      label: `${style.label} ${kind.replace('home ', '')}`,
      query: '',
      why: concept,
      placement: { anchor: 'center' },
      productIds: [...new Set(layout.placements.map((p) => p.productId))],
      origin: 'design',
    };
    saveSession({ ...cur, categories: [row, ...cur.categories.filter((c) => c.origin !== 'design')] });
  }

  return {
    mode: req.mode,
    style: styleKey,
    styleLabel: style?.label ?? 'Your bag',
    roomType: kind,
    concept,
    placements: layout.placements.map(({ replaced, ...p }) => ({ ...p, ...(replaced?.objectId ? { replacesPieceId: replaced.objectId } : {}) })),
    remove,
    replacedPieces: [...layout.freedObjects, ...paintOut],
    replacedLabels,
    skipped,
    total,
    usedDefaultRoom: !s.geometry,
  };
}

// ------------------------------------------------------------------------------------------ arrangement

/** A dining "table and chairs" set: its height is the chair backs, so nothing stands on it. */
const isSet = (p?: Product) => !!p && p.category === 'dining_table' && /\bchairs?\b/i.test(p.title);

export interface ArrangeInput {
  geo: RoomGeometry;
  mode: 'style' | 'bag';
  items: { productId: string; category: string; dims: Dims; isSet?: boolean }[];
  realFurniture?: Record<string, RealPiece>;
  placed: PlacedPiece[];
  titleOf?: (productId: string) => string | undefined;
  dimsOf?: (productId: string, category: string) => Dims;
}

export interface Arrangement {
  layout: LayoutResult;
  remove: string[];      // headset instances the design supersedes
  paintOut: string[];    // real pieces replaced by a piece standing elsewhere (painted out, nothing in their spot)
}

/**
 * Where everything goes, and what it replaces (pure: no I/O, so tests can run whole designs). Replacement, never
 * overlap: a real piece of a planned kind is replaced by the design's piece of that kind (a same-kind piece always; a
 * piece of a related kind only when it's about the same size). The new piece takes its spot when it fits there, else
 * the real piece is painted out and the new one goes where it works best. Virtual pieces the design supersedes hand
 * over their spots and are removed.
 */
export function arrangeDesign(a: ArrangeInput): Arrangement {
  const { geo, mode, placed } = a;
  const dimsOf = a.dimsOf ?? ((_id: string, category: string) => categoryDef(category).dims);
  const probe = roomModel(geo);
  const covered = new Set(a.items.map((i) => i.category));
  const remove = new Set<string>();
  const moving = new Map<string, PlacedPiece[]>(); // bag mode: bag pieces already placed are rearranged, not duplicated
  if (mode === 'bag') {
    for (const x of placed) if (!x.replacesPieceId && a.items.some((i) => i.productId === x.productId)) moving.set(x.productId, [...(moving.get(x.productId) ?? []), x]);
  }
  const layoutItems: LayoutItem[] = a.items.map((it) => {
    const inst = moving.get(it.productId)?.shift();
    return { productId: it.productId, category: it.category, dims: inst?.dims ?? it.dims, instanceId: inst?.instanceId, ...(it.isSet ? { isSet: true } : {}) };
  });
  const movingIds = new Set(layoutItems.map((l) => l.instanceId).filter(Boolean));

  // Real furniture, biggest first: each piece to the planned piece of its kind (or a related kind of about its size)
  // closest to its size. The spot is the replacement pose the headset itself uses, so the new piece lands exactly
  // where the solver planned it.
  const floor = geo.floorPolygon.length ? geo.floorPolygon : [{ x: 0, z: 0 }];
  const centroid = { x: floor.reduce((s, p) => s + p.x, 0) / floor.length, z: floor.reduce((s, p) => s + p.z, 0) / floor.length };
  const pieces = Object.values(a.realFurniture ?? {})
    .map((piece) => ({ piece, box: geo.objects.find((o) => o.id === piece.id) }))
    .filter((x): x is { piece: RealPiece; box: RoomObject } => !!x.box && !!x.piece.category)
    .sort((p, q) => q.box.size.x * q.box.size.z - p.box.size.x * p.box.size.z);
  const reassigned = new Set<string>();
  for (const { piece, box } of pieces) {
    const cat = piece.category!;
    const fam = FAMILY[cat] ?? [cat];
    let best: LayoutItem | null = null, bestCost = Infinity;
    for (const li of layoutItems) {
      if (li.replaces || li.instanceId || !fam.includes(li.category)) continue;
      const e = sizeError(li.dims, box) ?? 0.5;
      const same = li.category === cat;
      const cost = same ? e * 0.5 : fam.indexOf(li.category) * 0.3 + e;
      if (!same && cost >= 0.8) continue; // an accent chair doesn't replace a big couch
      if (cost < bestCost) { best = li; bestCost = cost; }
    }
    if (!best) continue;
    const pose = replacementPose(box, best.dims, geo.walls, geo.floorY, centroid);
    best.replaces = { label: `your ${labelName(piece.label)}`, pos: { x: pose.position.x, z: pose.position.z }, yaw: (pose.yawDeg * Math.PI) / 180, y: pose.position.y - geo.floorY, objectId: piece.id };
    // A same-kind piece never doubles up with the real one (a styled design replaces related kinds too). A piece
    // something real stands on (the TV on its bench) can't be painted out: the new one goes in its spot or not at all.
    const real = mode === 'style' || best.category === cat;
    best.replaceMode = supportsReal(box, geo) ? (real ? 'drop' : undefined) : real ? 'paint' : undefined;
    reassigned.add(piece.id);
  }
  // Pieces the user already replaced and this design leaves alone stay painted out; their replacement is kept below.
  const skipObjectIds = Object.values(a.realFurniture ?? {}).filter((p) => p.state === 'replace' && !reassigned.has(p.id)).map((p) => p.id);

  // Virtual pieces the design supersedes hand their spots to new pieces of the same kind. (A replacement standing in
  // for a real piece belongs to that piece: it's swapped through the piece, never removed here.)
  const virtualSpots = new Map<string, { label: string; x: PlacedPiece; d: Dims }[]>();
  for (const x of placed) {
    if (!covered.has(x.category) || movingIds.has(x.instanceId) || x.replacesPieceId) continue;
    remove.add(x.instanceId);
    virtualSpots.set(x.category, [...(virtualSpots.get(x.category) ?? []), { label: `the ${shortTitle(a.titleOf?.(x.productId)) || labelOf(x.category)}`, x, d: x.dims ?? dimsOf(x.productId, x.category) }]);
  }
  for (const li of layoutItems) {
    if (li.replaces || li.instanceId) continue;
    const vs = virtualSpots.get(li.category)?.shift();
    if (!vs) continue;
    const yaw = (vs.x.yawDeg * Math.PI) / 180;
    const f = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const wall = categoryDef(li.category).mount === 'wall';
    // Against a wall: the new piece's back goes where the old one's was; otherwise same center.
    const back = !wall && nearWall(probe, vs.x.position, yaw, vs.d.d) ? (vs.d.d - li.dims.d) / 2 : 0;
    li.replaces = { label: vs.label, pos: { x: vs.x.position.x - f.x * back, z: vs.x.position.z - f.z * back }, yaw, y: wall ? vs.x.position.y - geo.floorY : undefined, instanceId: vs.x.instanceId };
  }
  const keep: KeptPiece[] = placed
    .filter((x) => !remove.has(x.instanceId) && !movingIds.has(x.instanceId) && !(x.replacesPieceId && reassigned.has(x.replacesPieceId)))
    .map((x) => ({ category: x.category, pos: { x: x.position.x, z: x.position.z }, yaw: (x.yawDeg * Math.PI) / 180, dims: x.dims ?? dimsOf(x.productId, x.category), y: Math.max(0, x.position.y - geo.floorY) }));

  const layout = solveRoom(geo, layoutItems, { keep, skipObjectIds, dropUnfit: mode === 'style' });
  // A real piece painted out with its new piece elsewhere: whatever stood in for it before goes.
  for (const x of placed) if (x.replacesPieceId && layout.paintedOut.includes(x.replacesPieceId)) remove.add(x.instanceId);
  return { layout, remove: [...remove], paintOut: layout.paintedOut };
}

const labelOf = (cat: string) => categoryDef(cat).label.toLowerCase();
const shortTitle = (t?: string) => (t ? t.split(',')[0].trim() : '');

/** Something real (not a door or window) rests on this piece's top: a TV on a TV bench, a lamp on a table. */
function supportsReal(box: RoomObject, geo: RoomGeometry): boolean {
  const top = box.center.y + box.size.y / 2;
  const r = Math.max(box.size.x, box.size.z) / 2;
  return geo.objects.some((o) => o !== box && !/DOOR|WINDOW|WALL_ART/i.test(o.label)
    && Math.abs(o.center.y - o.size.y / 2 - top) < 0.12
    && Math.hypot(o.center.x - box.center.x, o.center.z - box.center.z) < r);
}

function nearWall(room: RoomModel, p: Vec3, yaw: number, d: number): boolean {
  const back = { x: p.x - Math.sin(yaw) * d / 2, z: p.z - Math.cos(yaw) * d / 2 };
  return room.walls.some((w) => Math.abs((back.x - w.c.x) * w.n.x + (back.z - w.c.z) * w.n.z) < 0.2 && Math.abs((back.x - w.c.x) * w.t.x + (back.z - w.c.z) * w.t.z) < w.width / 2);
}

/** Styles the headset offers (the style picker). */
export const designStyles = () => STYLE_PROFILES.map((s) => ({ key: s.key, label: s.label, blurb: s.blurb, swatches: s.swatches }));
