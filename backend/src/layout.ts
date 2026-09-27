import { categoryDef } from './catalog.js';
import { labelName, replacementPose } from './realPose.js';
import type { Dims, Placement, RoomGeometry, RoomObject, Vec3 } from './types.js';

// "Design my room": deterministic interior-layout solver.
// Works in the headset's world space (meters, Y up). Yaw convention matches Unity:
// yaw rotates +Z toward +X; an item's front (+Z in its model) faces (sin(yaw), cos(yaw)).
//
// Strategy, the way a designer works a floor plan:
//  1. Pinned pieces (a replacement the user already stands in a real piece's spot) stay put. Pieces that REPLACE
//     something (a real couch from Space Setup, or a piece already placed in the headset) go next and take that
//     piece's spot, so a redesign swaps furniture instead of piling new pieces on top of old.
//  2. The anchor piece (sofa, bed, desk, dining table) is tried on several good walls; for each, the rest of the room
//     is laid out around it and the best complete arrangement wins (a sofa is only as good as the room it leaves).
//  3. Every piece is scored, not just collision-checked: its use zone (legroom in front of a sofa, the drawer arc of a
//     dresser, chair room around a table) must stay free, walkways from doors stay open, tall pieces keep off
//     windows, and pieces that belong together (coffee table and sofa, lamp and chair) are kept together.
//  4. What doesn't fit is left out and reported, rather than dropped in the middle of the room.

export interface LayoutItem {
  productId: string;
  category: string;
  dims: Dims;
  instanceId?: string;        // an existing headset piece being moved (arranging the bag)
  replaces?: Spot;            // take this piece's place when it fits there
  /**
   * When it can't stand in a real piece's spot: 'paint' = the real piece goes anyway (painted out) and the new one
   * stands where it works best; 'drop' = the real piece stays and the new one is left out (something real stands on
   * it, like the TV on a TV bench). Unset: both stay, the new one placed elsewhere.
   */
  replaceMode?: 'paint' | 'drop';
  anchor?: string;
  near?: string;
  isSet?: boolean;            // a table-and-chairs set: its height is the chair backs, so nothing stands on it
}

/**
 * Where a new piece stands when it replaces an existing one: for real furniture, the replacement pose the headset uses
 * (realPose.ts replacementPose, mirrored by Room/ReplacementPose.cs); for a virtual piece, that piece's spot.
 */
export interface Spot {
  label: string;              // "your couch", "the KIVIK sofa"
  pos: { x: number; z: number };
  yaw: number;                // radians, the direction its front faces
  y?: number;                 // height above the floor (a lamp on a table, wall-mounted pieces)
  objectId?: string;          // real piece (RoomObject.id): the headset stands the product exactly here, so no sliding
  instanceId?: string;        // headset instance id
}

/** An item that must stay where it is (a replacement standing in a real piece's spot); the rest arranges around it. */
export interface FixedPlacement { productId: string; position: Vec3; yawDeg: number; reason?: string }

/** A virtual piece that stays where it is (an obstacle for the new layout). */
export interface KeptPiece { category: string; pos: { x: number; z: number }; yaw: number; dims: Dims; y: number }

export interface LayoutOptions {
  keep?: KeptPiece[];
  dropUnfit?: boolean;        // leave out what doesn't fit (design) instead of parking it in front of the user
  fixed?: FixedPlacement[];
  /** Real pieces (Space Setup ids) the user is replacing: no longer obstacles or anchors. */
  skipObjectIds?: Iterable<string>;
}

export interface PlacedResult extends Placement { instanceId?: string; replaced?: Spot }
export interface LayoutResult {
  placements: PlacedResult[];
  skipped: { productId: string; category: string; reason: string }[];
  freedObjects: string[];     // real pieces a new piece now stands in for (in their spot)
  paintedOut: string[];       // real pieces replaced by a piece standing elsewhere
}

// What can stand on top of what (mirrors StackRules in unity/.../Furniture/Stacking.cs): table lamps and small plants
// go on flat tops; lamps not on benches or up on tall shelves.
const REAL_TOPS = /^(TABLE|DESK|STORAGE|SHELF)/i;
export function stackable(category: string, d: Dims): boolean {
  return category === 'table_lamp' || (category === 'plant' && d.h <= 0.9 && Math.max(d.w, d.d) <= 0.7);
}
export function allowedOnTop(category: string, d: Dims, topCategory: string | null, topHeight: number): boolean {
  if (!stackable(category, d)) return false;
  return category === 'table_lamp' ? topCategory !== 'bench' && topHeight <= 1.3 : topHeight <= 2.2;
}
const fitsTop = (d: Dims, w: number, depth: number) => Math.max(d.w, d.d) <= Math.max(w, depth) - 0.03 && Math.min(d.w, d.d) <= Math.min(w, depth) - 0.03;

type V2 = { x: number; z: number };
interface Obb { c: V2; hw: number; hd: number; yaw: number }
interface Wall { c: V2; n: V2; t: V2; width: number; hasDoor: boolean; openings: { s0: number; s1: number; y0: number; y1: number; door: boolean }[] }
interface Obstacle { obb: Obb; y0: number; y1: number; id?: string; real?: boolean }
interface Placed { item: LayoutItem; pos: V2; yaw: number; y: number; obb: Obb; zone: Obb | null; score: number }
interface Cand { pos: V2; yaw: number; y?: number; score: number; why: string; spot?: boolean; top?: string }

const ORDER = ['bed', 'sofa', 'desk', 'dining_table', 'tv_stand', 'dresser', 'bookshelf', 'cabinet', 'coffee_table', 'rug', 'armchair', 'side_table', 'nightstand', 'office_chair', 'dining_chair', 'bench', 'floor_lamp', 'table_lamp', 'ottoman', 'plant', 'mirror', 'wall_art'];
const ANCHORS = new Set(['sofa', 'bed', 'desk', 'dining_table']);
const rank = (c: string) => { const i = ORDER.indexOf(c); return i < 0 ? ORDER.length : i; };
const GAP = 0.03;

// Use zone in front of a piece that must stay walkable (m), and which pieces may stand inside it.
const FRONT_CLEAR: Record<string, number> = { sofa: 0.8, armchair: 0.55, bed: 0.6, desk: 0.7, dresser: 0.75, cabinet: 0.65, bookshelf: 0.55, tv_stand: 0.5, bench: 0.35 };
const ZONE_OK: Record<string, string[]> = {
  sofa: ['coffee_table', 'rug', 'ottoman', 'armchair', 'side_table'],
  armchair: ['coffee_table', 'rug', 'ottoman', 'side_table', 'sofa', 'armchair'],
  bed: ['rug', 'bench', 'ottoman'],
  desk: ['office_chair', 'rug'],
  dining_table: ['dining_chair', 'rug', 'bench'],
  tv_stand: ['rug'],
};
// Pieces that look wrong floating in the middle of the room: wall slots (or their partner) only.
const WALL_ONLY = new Set(['bed', 'sofa', 'desk', 'tv_stand', 'dresser', 'bookshelf', 'cabinet', 'bench']);

const v = (x: number, z: number): V2 => ({ x, z });
const add = (a: V2, b: V2): V2 => v(a.x + b.x, a.z + b.z);
const sub = (a: V2, b: V2): V2 => v(a.x - b.x, a.z - b.z);
const mul = (a: V2, s: number): V2 => v(a.x * s, a.z * s);
const dot = (a: V2, b: V2) => a.x * b.x + a.z * b.z;
const len = (a: V2) => Math.hypot(a.x, a.z);
const norm = (a: V2) => { const l = len(a) || 1; return v(a.x / l, a.z / l); };
const fwd = (yaw: number) => v(Math.sin(yaw), Math.cos(yaw));
const right = (yaw: number) => v(Math.cos(yaw), -Math.sin(yaw));
const yawOf = (dir: V2) => Math.atan2(dir.x, dir.z);
const deg = (r: number) => Math.round(((r * 180) / Math.PI + 360) % 360);
const labelOf = (cat: string) => categoryDef(cat).label.toLowerCase();

function corners(o: Obb): V2[] {
  const f = fwd(o.yaw), r = right(o.yaw);
  return [add(add(o.c, mul(r, o.hw)), mul(f, o.hd)), add(sub(o.c, mul(r, o.hw)), mul(f, o.hd)), sub(sub(o.c, mul(r, o.hw)), mul(f, o.hd)), sub(add(o.c, mul(r, o.hw)), mul(f, o.hd))];
}

function overlaps(a: Obb, b: Obb, tol = 0.01): boolean {
  const ca = corners(a), cb = corners(b);
  for (const axis of [fwd(a.yaw), right(a.yaw), fwd(b.yaw), right(b.yaw)]) {
    const pa = ca.map((p) => dot(p, axis)), pb = cb.map((p) => dot(p, axis));
    if (Math.max(...pa) - tol <= Math.min(...pb) || Math.max(...pb) - tol <= Math.min(...pa)) return false;
  }
  return true;
}

function inPolygon(p: V2, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from p along dir to the room outline. */
function rayToOutline(p: V2, dir: V2, poly: V2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const e = sub(b, a);
    const den = dir.x * e.z - dir.z * e.x;
    if (Math.abs(den) < 1e-9) continue;
    const ap = sub(a, p);
    const t = (ap.x * e.z - ap.z * e.x) / den;
    const u = (ap.x * dir.z - ap.z * dir.x) / den;
    if (t > 1e-4 && u >= -1e-6 && u <= 1 + 1e-6) best = Math.min(best, t);
  }
  return best;
}

function polygonArea(poly: V2[]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.z - q.x * p.z; }
  return Math.abs(a) / 2;
}

// ------------------------------------------------------------------------------------------ room model

export interface RoomModel {
  poly: V2[];
  centroid: V2;
  area: number;
  walls: Wall[];
  obstacles: Obstacle[];     // real furniture + kept virtual pieces (with the height they occupy)
  doorZones: Obb[];          // swing area inside each door: hard keep-out
  paths: Obb[];              // walkway from each door toward the middle of the room: soft keep-out
  realZones: { zone: Obb; ok: string[]; id?: string }[]; // the space in front of real storage / couches / beds: soft keep-out
  objects: RoomObject[];     // real pieces still in the room (minus the ones being replaced)
  floorY: number;
  geo: RoomGeometry;
}

const IGNORED = /WALL|FLOOR|CEILING|WINDOW|INVISIBLE|GLOBAL_MESH/i;

export function roomModel(geo: RoomGeometry, keep: KeptPiece[] = [], skipObjectIds: Iterable<string> = []): RoomModel {
  const skip = new Set(skipObjectIds);
  const objects = geo.objects.filter((o) => !o.id || !skip.has(o.id));
  const poly = geo.floorPolygon.map((p) => v(p.x, p.z));
  const centroid = poly.reduce((a, p) => add(a, mul(p, 1 / poly.length)), v(0, 0));
  const openingsRaw = objects.filter((o) => /DOOR|WINDOW/i.test(o.label));
  const walls: Wall[] = (geo.walls.length ? geo.walls : wallsFromPolygon(poly)).map((w) => {
    const c = v(w.center.x, w.center.z);
    let n = norm(v(w.normal.x, w.normal.z));
    if (dot(n, sub(centroid, c)) < 0) n = mul(n, -1); // make sure normals point into the room
    const t = v(n.z, -n.x);
    const openings: Wall['openings'] = [];
    for (const o of openingsRaw) {
      const rel = sub(v(o.center.x, o.center.z), c);
      if (Math.abs(dot(rel, n)) > 0.3 || Math.abs(dot(rel, t)) > w.width / 2 + 0.1) continue;
      const s = dot(rel, t), y = o.center.y - geo.floorY;
      openings.push({ s0: s - o.size.x / 2, s1: s + o.size.x / 2, y0: y - o.size.y / 2, y1: y + o.size.y / 2, door: /DOOR/i.test(o.label) });
    }
    return { c, n, t, width: w.width, hasDoor: openings.some((o) => o.door), openings };
  });

  const obstacles: Obstacle[] = [];
  const doorZones: Obb[] = [];
  const paths: Obb[] = [];
  for (const o of objects) {
    const c = v(o.center.x, o.center.z);
    if (/DOOR/i.test(o.label)) {
      const wall = nearestWall(walls, c);
      if (!wall) continue;
      const threshold = add(c, mul(wall.n, -dot(sub(c, wall.c), wall.n)));
      doorZones.push({ c: add(threshold, mul(wall.n, 0.45)), hw: Math.max(o.size.x, 0.85) / 2, hd: 0.45, yaw: yawOf(wall.n) });
      // Walkway: from just inside the door toward the middle of the room, 0.8 m wide.
      const start = add(threshold, mul(wall.n, 0.9));
      const to = sub(centroid, start);
      const l = Math.min(2.4, len(to));
      if (l > 0.3) paths.push({ c: add(start, mul(norm(to), l / 2)), hw: 0.4, hd: l / 2, yaw: yawOf(to) });
      continue;
    }
    if (IGNORED.test(o.label) || /\bART\b|WALL_ART/i.test(o.label)) continue;
    const y0 = o.center.y - o.size.y / 2 - geo.floorY;
    obstacles.push({ obb: { c, hw: o.size.x / 2, hd: o.size.z / 2, yaw: (o.yawDeg * Math.PI) / 180 }, y0: Math.max(0, y0), y1: y0 + o.size.y, id: o.id, real: true });
  }
  const partial: RoomModel = { poly, centroid, area: polygonArea(poly), walls, obstacles, doorZones, paths, realZones: [], objects, floorY: geo.floorY, geo };
  // Real furniture needs its own use space too: nothing tall parked in front of your shelves or your couch.
  for (const o of objects) {
    const kind = /COUCH/.test(o.label) ? 'sofa' : /\bBED\b/.test(o.label) ? 'bed' : /STORAGE/.test(o.label) ? 'dresser' : null;
    if (!kind) continue;
    const f = facing(partial, o);
    const zone = zoneOf(kind, { c: f.pos, hw: f.w / 2, hd: f.d / 2, yaw: f.yaw });
    if (zone) partial.realZones.push({ zone, ok: ZONE_OK[kind] ?? [], id: o.id });
  }
  for (const k of keep) {
    if (categoryDef(k.category).mount === 'wall' || k.category === 'rug') continue;
    obstacles.push({ obb: { c: v(k.pos.x, k.pos.z), hw: k.dims.w / 2, hd: k.dims.d / 2, yaw: k.yaw }, y0: k.y, y1: k.y + k.dims.h });
  }
  return partial;
}

function nearestWall(walls: Wall[], p: V2): Wall | undefined {
  let best: Wall | undefined, bd = Infinity;
  for (const w of walls) {
    const rel = sub(p, w.c);
    const along = Math.max(0, Math.abs(dot(rel, w.t)) - w.width / 2);
    const dist = Math.hypot(dot(rel, w.n), along);
    if (dist < bd) { bd = dist; best = w; }
  }
  return best;
}

// ------------------------------------------------------------------------------------------ solver

/** Placements only (the /layout endpoint and tests); see solveRoom for what was left out and which pieces were replaced. */
export function solveLayout(geo: RoomGeometry, items: LayoutItem[], opts: LayoutOptions = {}): Placement[] {
  return solveRoom(geo, items, opts).placements;
}

export function solveRoom(geo: RoomGeometry, items: LayoutItem[], opts: LayoutOptions = {}): LayoutResult {
  const room = roomModel(geo, opts.keep, opts.skipObjectIds);
  const fixedIds = new Set((opts.fixed ?? []).map((f) => f.productId));
  // Stand-ins for real furniture first (they keep the room's physical arrangement), then everything else in designer
  // order. A piece replacing an earlier virtual piece prefers that spot but still competes like any other.
  const real = (i: LayoutItem) => (i.replaces?.objectId !== undefined ? 0 : 1);
  const sorted = items.filter((i) => !fixedIds.has(i.productId)).sort((a, b) => real(a) - real(b) || rank(a.category) - rank(b.category));
  const pinned = items.filter((i) => fixedIds.has(i.productId));

  // Try the anchor piece on its few best spots and keep the arrangement that works best as a whole.
  const primary = sorted.find((i) => ANCHORS.has(i.category) && real(i));
  let best: Run | null = null;
  if (primary) {
    const probe = new Run(room, sorted, pinned, opts);
    probe.placeUntil(primary);
    const options = probe.options(primary).slice(0, 6);
    for (const o of options) {
      const run = new Run(room, sorted, pinned, opts);
      run.solve(primary, o);
      if (!best || run.total() > best.total()) best = run;
    }
  }
  if (!best) { best = new Run(room, sorted, pinned, opts); best.solve(); }
  return best.result();
}

class Run {
  placed: Placed[] = [];
  results: PlacedResult[] = [];
  skipped: LayoutResult['skipped'] = [];
  obstacles: Obstacle[];
  realZones: RoomModel['realZones'];
  freed: string[] = [];
  paintedOut: string[] = [];
  usedTops = new Set<string>(); // one lamp / plant per top
  private next = 0;

  private items: LayoutItem[];

  constructor(private room: RoomModel, items: LayoutItem[], pinned: LayoutItem[], private opts: LayoutOptions) {
    this.items = [...items];
    // A real piece stays an obstacle for everything else until its replacement actually stands in its spot.
    this.obstacles = [...room.obstacles];
    this.realZones = [...room.realZones];
    // Pinned pieces (replacements already standing in a real piece's spot) are simply there.
    const fixed = new Map((opts.fixed ?? []).map((f) => [f.productId, f]));
    for (const item of pinned) {
      const f = fixed.get(item.productId)!;
      const pos = v(f.position.x, f.position.z), yaw = (f.yawDeg * Math.PI) / 180;
      const y = Math.max(0, f.position.y - room.floorY);
      const obb = { c: pos, hw: item.dims.w / 2, hd: item.dims.d / 2, yaw };
      this.placed.push({ item, pos, yaw, y, obb, zone: categoryDef(item.category).mount === 'wall' || y > 0.05 ? null : zoneOf(item.category, obb), score: 0 });
      this.results.push({ productId: item.productId, position: { x: round(f.position.x), y: round(f.position.y), z: round(f.position.z) }, yawDeg: deg(yaw), reason: f.reason ?? '' });
    }
  }

  total() {
    return this.placed.reduce((s, p) => s + p.score, 0) - this.skipped.length * 6 - this.results.filter((r) => /in front of you/.test(r.reason ?? '')).length * 6;
  }

  /** Place everything that comes before `stop` in order (used to probe the anchor's options in context). */
  placeUntil(stop: LayoutItem) {
    while (this.next < this.items.length && this.items[this.next] !== stop) this.place(this.items[this.next++]);
  }

  solve(forcedItem?: LayoutItem, forced?: Cand) {
    while (this.next < this.items.length) {
      const item = this.items[this.next++];
      this.place(item, item === forcedItem ? forced : undefined);
    }
  }

  /** The anchor's distinct good options (at least 0.5 m or 30 degrees apart), best first. */
  options(item: LayoutItem): Cand[] {
    const scored = this.candidates(item).map((c) => ({ c, s: this.evaluate(item, c) })).filter((x) => x.s !== null).sort((a, b) => b.s! - a.s!);
    const out: Cand[] = [];
    for (const { c, s } of scored) {
      if (out.some((o) => len(sub(o.pos, c.pos)) < 0.5 && Math.abs(Math.cos(o.yaw - c.yaw)) > 0.87)) continue;
      out.push({ ...c, score: s! });
      if (out.length >= 6) break;
    }
    return out;
  }

  result(): LayoutResult {
    return { placements: this.results, skipped: this.skipped, freedObjects: this.freed, paintedOut: this.paintedOut };
  }

  private place(item: LayoutItem, forced?: Cand) {
    const { room } = this;
    const def = categoryDef(item.category);
    let chosen: Cand | null = forced ?? null;
    let score = forced?.score ?? 0;
    if (!chosen) {
      for (const c of this.candidates(item)) {
        const s = this.evaluate(item, c);
        if (s !== null && (!chosen || s > score)) { chosen = c; score = s; }
      }
    }
    // The new piece took the old one's spot: the real piece is gone as far as the rest of the layout is concerned.
    // If it couldn't, the old piece simply stays (an obstacle like any other) and the new one waits for its normal
    // turn, so a coffee table still gets arranged in front of the sofa placed after it.
    const spot = item.replaces;
    if (spot?.objectId !== undefined && !forced && !chosen?.spot) {
      // Must go (a second sofa next to the real couch is never the design): paint the real piece out and place the
      // new one wherever works best, in its normal turn.
      if (item.replaceMode === 'drop') {
        this.skipped.push({ productId: item.productId, category: item.category, reason: `kept ${spot.label}: the new ${labelOf(item.category)} didn't fit its spot` });
        return;
      }
      if (item.replaceMode === 'paint') this.release(spot.objectId, true);
      const later = { ...item, replaces: undefined, replaceMode: undefined };
      const at = this.items.findIndex((x, i) => i >= this.next && x.replaces?.objectId === undefined && rank(x.category) > rank(later.category));
      this.items.splice(at < 0 ? this.items.length : at, 0, later);
      return;
    }
    if (spot?.objectId !== undefined && chosen?.spot) this.release(spot.objectId, false);
    if (chosen?.top) this.usedTops.add(chosen.top);

    let reason = chosen?.why ?? '';
    if (!chosen) {
      if (this.opts.dropUnfit) {
        this.skipped.push({ productId: item.productId, category: item.category, reason: `no room for the ${labelOf(item.category)} without crowding the space` });
        return;
      }
      // The user picked this piece: put it 1.5 m in front of them and say so.
      const geo = room.geo;
      const u = geo.user ? v(geo.user.position.x, geo.user.position.z) : room.centroid;
      const f = geo.user ? norm(v(geo.user.forward.x, geo.user.forward.z)) : v(0, 1);
      chosen = { pos: add(u, mul(f, 1.5)), yaw: yawOf(mul(f, -1)), score: 0, why: '' };
      reason = "didn't fit anywhere without overlapping — placed in front of you";
    }
    const y = chosen.y ?? 0;
    const obb = { c: chosen.pos, hw: item.dims.w / 2, hd: item.dims.d / 2, yaw: chosen.yaw };
    this.placed.push({ item, pos: chosen.pos, yaw: chosen.yaw, y, obb, zone: def.mount === 'wall' || y > 0.05 ? null : zoneOf(item.category, obb), score });
    this.results.push({
      productId: item.productId,
      position: { x: round(chosen.pos.x), y: round(room.floorY + y), z: round(chosen.pos.z) },
      yawDeg: deg(chosen.yaw),
      reason,
      ...(item.instanceId ? { instanceId: item.instanceId } : {}),
      ...(chosen.spot && spot ? { replaced: spot } : {}),
    });
  }

  private gone(id: string) { return this.freed.includes(id) || this.paintedOut.includes(id); }

  /** A real piece is gone as far as the rest of the layout is concerned (replaced in its spot, or painted out). */
  private release(id: string, paintOut: boolean) {
    (paintOut ? this.paintedOut : this.freed).push(id);
    this.obstacles = this.obstacles.filter((o) => o.id !== id);
    this.realZones = this.realZones.filter((z) => z.id !== id);
  }

  // -------------------------------------------------------------------------------------- scoring

  /** Total score of a candidate, or null when it can't go there at all. */
  private evaluate(item: LayoutItem, c: Cand): number | null {
    const { room } = this;
    const def = categoryDef(item.category);
    const { w, d, h } = item.dims;
    const body: Obb = { c: c.pos, hw: w / 2, hd: d / 2, yaw: c.yaw };
    let s = c.score;

    if (def.mount === 'wall') {
      const y0 = c.y ?? 1.45 - h / 2, y1 = y0 + h;
      const wall = nearestWall(room.walls, c.pos);
      if (wall) {
        const sc = dot(sub(c.pos, wall.c), wall.t);
        for (const o of wall.openings) if (sc + w / 2 > o.s0 && sc - w / 2 < o.s1 && y1 > o.y0 && y0 < o.y1) return null; // over a window or door
      }
      for (const p of this.placed) {
        if (categoryDef(p.item.category).mount !== 'wall') continue;
        if (overlaps(p.obb, { ...body, hd: Math.max(body.hd, 0.1) }) && y1 > p.y && y0 < p.y + p.item.dims.h) return null;
      }
      // Something tall standing in front of the wall would hide it.
      for (const o of this.obstacles) if (o.y1 > y0 + 0.2 && overlaps(o.obb, { ...body, hd: 0.3 })) return null;
      for (const p of this.placed) if (categoryDef(p.item.category).mount !== 'wall' && p.y + p.item.dims.h > y0 + 0.2 && overlaps(p.obb, { ...body, hd: 0.3 })) return null;
      return s;
    }
    if ((c.y ?? 0) > 0.05) return s; // standing on another piece (table lamp)

    // Inside the room, with the headset's tolerance: a piece backed flush onto a wall (a stand-in for real furniture)
    // touches the outline.
    if (!corners({ ...body, hw: Math.max(0.01, body.hw - 0.02), hd: Math.max(0.01, body.hd - 0.02) }).every((p) => inPolygon(p, room.poly)) || !inPolygon(body.c, room.poly)) return null;
    const isRug = item.category === 'rug';
    if (isRug) {
      if (this.placed.some((p) => p.item.category === 'rug' && overlaps(p.obb, body))) return null;
      return s;
    }
    // Same tolerance as the headset's fit check (ManipulationController.CheckFit), so a designed piece is never flagged.
    const tol = 0.015;
    const own = item.replaces?.objectId;
    for (const o of this.obstacles) {
      if (c.spot && o.id === own) continue; // the piece it replaces
      // Real pieces block their whole footprint, whatever their height (as the headset's fit check sees them); a
      // virtual piece resting on a top doesn't take floor space.
      if (!o.real && o.y0 > 0.05) continue;
      if (o.y0 >= h + 0.02) continue; // above it (a wall-mounted TV over the TV bench)
      if (overlaps(o.obb, body, tol)) return null;
    }
    for (const z of room.doorZones) if (overlaps(z, body)) return null;
    for (const p of this.placed) {
      if (p.item.category === 'rug' || p.y > 0.05 || categoryDef(p.item.category).mount === 'wall') continue;
      if (overlaps(p.obb, body, -0.03)) return null; // at least 3 cm between pieces (model bounds vary by a few cm)
    }

    // Soft rules.
    if (room.paths.some((z) => overlaps(z, body))) s -= h > 0.35 ? 2.5 : 1.2;
    const zone = zoneOf(item.category, body);
    if (zone) {
      const zc = corners(zone);
      const outside = zc.filter((p) => !inPolygon(p, room.poly)).length;
      s -= outside * 0.8;
      if (this.obstacles.some((o) => o.id !== own && o.y0 < 0.5 && overlaps(o.obb, zone, 0.03))) s -= 3;
      if (room.doorZones.some((z) => overlaps(z, zone))) s -= 1;
      const ok = ZONE_OK[item.category] ?? [];
      for (const p of this.placed) {
        if (p.item.category === 'rug' || p.y > 0.05 || categoryDef(p.item.category).mount === 'wall' || ok.includes(p.item.category)) continue;
        if (overlaps(p.obb, zone, 0.03)) s -= 2.5;
      }
    }
    for (const z of this.realZones) if (!(c.spot && z.id === own) && !z.ok.includes(item.category) && overlaps(z.zone, body, 0.03)) s -= 2;
    // Don't stand in another piece's use zone (the chair in front of the dresser).
    for (const p of this.placed) {
      if (!p.zone || (ZONE_OK[p.item.category] ?? []).includes(item.category)) continue;
      if (overlaps(p.zone, body, 0.03)) s -= 2.5;
    }
    // Keep the sightline from the sofa to the TV clear.
    const view = this.viewZone();
    if (view && !['coffee_table', 'ottoman', 'side_table', 'tv_stand', 'sofa'].includes(item.category) && overlaps(view, body, 0.03)) s -= 3;
    // Tall pieces keep off windows.
    if (h > 1.0) {
      const wall = nearestWall(room.walls, c.pos);
      if (wall && Math.abs(dot(sub(c.pos, wall.c), wall.n)) < d / 2 + 0.25) {
        const sc = dot(sub(c.pos, wall.c), wall.t);
        if (wall.openings.some((o) => !o.door && sc + w / 2 > o.s0 && sc - w / 2 < o.s1 && o.y0 < h)) s -= 2.5;
      }
    }
    return s;
  }

  /** Floor between the sofa and the TV (a stand we placed, or a real screen in front of the sofa). */
  private viewZone(): Obb | null {
    const sofa = this.placed.find((p) => p.item.category === 'sofa');
    if (!sofa) return null;
    const tv = this.placed.find((p) => p.item.category === 'tv_stand');
    const screen = this.room.geo.objects.find((o) => /SCREEN/.test(o.label));
    const target = tv ? tv.pos : screen ? v(screen.center.x, screen.center.z) : null;
    if (!target) return null;
    const front = add(sofa.pos, mul(fwd(sofa.yaw), sofa.item.dims.d / 2));
    const to = sub(target, front);
    if (dot(norm(to), fwd(sofa.yaw)) < 0.5 || len(to) < 0.5) return null;
    return { c: add(front, mul(to, 0.5)), hw: Math.min(0.6, sofa.item.dims.w / 2), hd: len(to) / 2 - 0.15, yaw: yawOf(to) };
  }

  // -------------------------------------------------------------------------------------- candidates

  private candidates(item: LayoutItem): Cand[] {
    const { room } = this;
    const { poly, centroid, walls } = room;
    const def = categoryDef(item.category);
    const { w, d, h } = item.dims;
    const cands: Cand[] = [];
    const push = (pos: V2, yaw: number, score: number, why: string, y?: number, spot?: boolean, top?: string) => cands.push({ pos, yaw, score, why, y, spot, top });
    const findPlaced = (...cats: string[]) => this.placed.find((p) => cats.includes(p.item.category));
    const allPlaced = (...cats: string[]) => this.placed.filter((p) => cats.includes(p.item.category));
    const existing = (label: RegExp) => room.objects.find((o) => label.test(o.label) && !(o.id && this.gone(o.id)));

    // Take the replaced piece's spot, sliding a little along its wall if the new piece doesn't quite fit there (a
    // wider sofa next to a shelf, a bed by the door). The headset glides a real piece's stand-in to the same spot.
    const spot = item.replaces;
    if (spot) {
      const r = right(spot.yaw);
      const y = def.mount === 'wall' ? spot.y ?? 1.45 - h / 2 : spot.y;
      const slides = (spot.y ?? 0) > 0.05 ? [0] : [0, 0.1, -0.1, 0.2, -0.2, 0.35, -0.35, 0.5, -0.5];
      for (const s of slides) push(add(spot.pos, mul(r, s)), spot.yaw, 7 - Math.abs(s) * 2, `in place of ${spot.label}`, y, true);
    }
    // Lamps and small plants on tops: placed pieces first (in order of preference), then the user's own tables / storage.
    const onTops = (prefer: string[], base: number, realScore: number) => {
      for (const [i, cat] of prefer.entries()) {
        for (const surf of this.placed.filter((p) => p.item.category === cat && !p.item.isSet && !this.usedTops.has(p.item.productId + '@' + p.pos.x + ',' + p.pos.z))) {
          const topH = surf.y + surf.item.dims.h;
          if (fitsTop(item.dims, surf.item.dims.w, surf.item.dims.d) && allowedOnTop(item.category, item.dims, cat, topH))
            push(surf.pos, surf.yaw, base - i * 0.3, `on the ${labelOf(cat)}`, topH, false, surf.item.productId + '@' + surf.pos.x + ',' + surf.pos.z);
        }
      }
      for (const o of room.objects) {
        if (!REAL_TOPS.test(o.label) || (o.id && (this.usedTops.has(o.id) || this.gone(o.id)))) continue;
        const topH = o.center.y + o.size.y / 2 - room.floorY;
        // Already taken by something real standing on it (the TV on a TV table, a lamp).
        const busy = room.objects.some((x) => x !== o && !/DOOR|WINDOW/i.test(x.label) && Math.abs(x.center.y - x.size.y / 2 - room.floorY - topH) < 0.12
          && overlaps({ c: v(x.center.x, x.center.z), hw: x.size.x / 2, hd: x.size.z / 2, yaw: (x.yawDeg * Math.PI) / 180 }, { c: v(o.center.x, o.center.z), hw: o.size.x / 2, hd: o.size.z / 2, yaw: (o.yawDeg * Math.PI) / 180 }));
        if (busy) continue;
        if (fitsTop(item.dims, o.size.x, o.size.z) && allowedOnTop(item.category, item.dims, null, topH))
          push(v(o.center.x, o.center.z), (o.yawDeg * Math.PI) / 180, realScore, `on your ${labelName(o.label)}`, topH, false, o.id ?? o.label);
      }
    };

    const wallSlots = (prefer: 'center' | 'ends' | 'any', filter: (wl: Wall) => boolean = () => true, bonus = 0) => {
      for (const wl of walls) {
        if (!filter(wl)) continue;
        const span = wl.width / 2 - w / 2 - 0.05;
        if (span < 0) continue;
        for (let s = -span; s <= span + 1e-6; s += 0.1) {
          const pos = add(add(wl.c, mul(wl.t, s)), mul(wl.n, d / 2 + GAP));
          const centered = 1 - Math.abs(s) / Math.max(span, 0.01);
          const sc = prefer === 'center' ? centered : prefer === 'ends' ? 1 - centered : 0.5;
          push(pos, yawOf(wl.n), bonus + sc + Math.min(wl.width, 5) * 0.05 - (wl.hasDoor ? 0.6 : 0), `against a ${wl.width.toFixed(1)} m wall`);
        }
      }
    };
    const beside = (anchor: Placed | undefined, sideGap: number, forwardOffset: number, score: number, why: string, yawOffset = 0) => {
      if (!anchor) return;
      const f = fwd(anchor.yaw), r = right(anchor.yaw);
      for (const side of [1, -1]) {
        const pos = add(add(anchor.pos, mul(r, side * (anchor.item.dims.w / 2 + sideGap))), mul(f, forwardOffset));
        push(pos, anchor.yaw + yawOffset * side, score, why);
      }
    };
    /** Free floor ahead of a piece standing at `pos` facing `yaw` (front edge to the opposite wall). */
    const ahead = (pos: V2, yaw: number, depth: number) => rayToOutline(add(pos, mul(fwd(yaw), depth / 2)), fwd(yaw), poly);

    switch (item.category) {
      case 'sofa': {
        const screen = existing(/SCREEN/);
        wallSlots('center');
        for (const c of cands) {
          if (c.spot) continue;
          const room_ = ahead(c.pos, c.yaw, d);
          // Room for legroom + a coffee table + a walkway, but a sofa shouldn't face a wall 5 m away either.
          c.score += room_ < 1.5 ? -2.5 : room_ < 2.0 ? -0.8 : room_ > 5 ? -0.3 : 0.6;
          if (screen) {
            // Face the TV squarely and sit roughly centered on it.
            const to = sub(v(screen.center.x, screen.center.z), c.pos);
            const facing = dot(fwd(c.yaw), norm(to));
            c.score += 3 * facing - (facing < 0.7 ? 1.5 : 0) - Math.abs(dot(to, right(c.yaw))) * 1.0;
          }
        }
        break;
      }
      case 'bed': {
        const doors = walls.flatMap((wl) => wl.openings.filter((o) => o.door).map((o) => add(wl.c, mul(wl.t, (o.s0 + o.s1) / 2))));
        wallSlots('center', (wl) => !wl.hasDoor, 0.8);
        wallSlots('center');
        for (const c of cands) {
          if (c.spot) continue;
          if (ahead(c.pos, c.yaw, d) < 0.7) c.score -= 3;
          // Headboard on the wall farthest from the door, and not under a window.
          if (doors.length) c.score += Math.min(...doors.map((p) => len(sub(p, c.pos)))) * 0.25;
          const wl = nearestWall(walls, c.pos);
          if (wl?.openings.some((o) => !o.door && Math.abs(dot(sub(c.pos, wl.c), wl.t) - (o.s0 + o.s1) / 2) < w / 2)) c.score -= 0.6;
          // A double bed needs a way in on both sides (and a nightstand each side); a narrow bed can go in a corner.
          if (w >= 1.2) {
            for (const side of [1, -1]) {
              const room_ = rayToOutline(c.pos, mul(right(c.yaw), side), poly) - w / 2;
              c.score -= room_ < 0.45 ? 2.5 : room_ < 0.6 ? 0.8 : 0;
            }
          }
        }
        break;
      }
      case 'desk':
        wallSlots('center');
        for (const c of cands) {
          if (c.spot) continue;
          if (walls.some((wl) => wl.openings.some((o) => !o.door) && Math.abs(dot(sub(c.pos, wl.c), wl.n)) < d)) c.score += 1.5; // daylight
          if (ahead(c.pos, c.yaw, d) < 1.1) c.score -= 2;
        }
        break;
      case 'dining_table': {
        const long = walls.reduce((a, b) => (b.width > a.width ? b : a), walls[0]);
        const yaw = long ? yawOf(long.t) : 0;
        for (let dx = -1; dx <= 1; dx += 0.25) {
          for (let dz = -1; dz <= 1; dz += 0.25) {
            const pos = add(centroid, v(dx, dz));
            push(pos, yaw, 3 - len(v(dx, dz)) * 0.8, 'centered with chair room all around');
            push(pos, yaw + Math.PI / 2, 2.6 - len(v(dx, dz)) * 0.8, 'centered with chair room all around');
          }
        }
        break;
      }
      case 'tv_stand': {
        const screen = existing(/SCREEN/);
        if (screen && screen.center.y - screen.size.y / 2 - room.floorY > 0.3) {
          // A wall-mounted TV: the stand goes right under it.
          const wl = nearestWall(walls, v(screen.center.x, screen.center.z));
          if (wl && Math.abs(dot(sub(v(screen.center.x, screen.center.z), wl.c), wl.n)) < 0.4) push(add(add(wl.c, mul(wl.t, dot(sub(v(screen.center.x, screen.center.z), wl.c), wl.t))), mul(wl.n, d / 2 + GAP)), yawOf(wl.n), 6, 'under your TV');
        }
        wallSlots('center');
        for (const c of cands) {
          const wl = nearestWall(walls, c.pos);
          if (!wl || Math.abs(dot(sub(c.pos, wl.c), wl.n)) > d / 2 + 0.2) continue;
          const sc = dot(sub(c.pos, wl.c), wl.t);
          if (wl.openings.some((o) => !o.door && sc + w / 2 + 0.3 > o.s0 && sc - w / 2 - 0.3 < o.s1)) c.score -= 3;
        }
        const seat = findPlaced('sofa');
        const couch = existing(/COUCH/);
        const target = seat ? seat.pos : couch ? v(couch.center.x, couch.center.z) : null;
        if (target) {
          for (const c of cands) {
            const dist = len(sub(target, c.pos));
            c.score += 2.5 * dot(fwd(c.yaw), norm(sub(target, c.pos))) + (dist >= 1.8 && dist <= 3.8 ? 1 : dist < 1.4 ? -1.5 : 0);
            if (seat && Math.abs(dot(sub(c.pos, seat.pos), right(seat.yaw))) < 0.4) c.score += 0.8; // centered on the sofa
          }
        }
        break;
      }
      case 'dresser': {
        wallSlots('ends');
        const bed = findPlaced('bed');
        if (bed) for (const c of cands) if (dot(fwd(c.yaw), fwd(bed.yaw)) < -0.8) c.score += 1; // facing the bed
        break;
      }
      case 'bookshelf': case 'cabinet': {
        wallSlots('ends');
        const partner = findPlaced('desk', 'armchair');
        if (partner) for (const c of cands) if (len(sub(c.pos, partner.pos)) < 1.8) c.score += 0.8;
        break;
      }
      case 'bench': {
        const bed = findPlaced('bed');
        if (bed) push(add(bed.pos, mul(fwd(bed.yaw), bed.item.dims.d / 2 + 0.05 + d / 2)), bed.yaw, 5, 'at the foot of the bed');
        const table = findPlaced('dining_table');
        if (table) for (const s of [1, -1]) push(add(table.pos, mul(fwd(table.yaw), s * (table.item.dims.d / 2 + d / 2 + 0.06))), table.yaw + (s > 0 ? Math.PI : 0), 4.5, 'at the dining table');
        wallSlots('ends');
        break;
      }
      case 'coffee_table': {
        const sofa = findPlaced('sofa');
        const couch = existing(/COUCH/);
        if (sofa) push(add(sofa.pos, mul(fwd(sofa.yaw), sofa.item.dims.d / 2 + 0.45 + d / 2)), sofa.yaw, 5, 'in front of the sofa, 45 cm legroom');
        else if (couch) {
          const cp = facing(room, couch);
          push(add(cp.pos, mul(fwd(cp.yaw), cp.d / 2 + 0.45 + d / 2)), cp.yaw, 4, 'in front of your couch');
        }
        const chairs = allPlaced('armchair');
        if (!sofa && chairs.length) {
          // No sofa: serve the chairs. A pair side by side gets the table in front of both; facing chairs, between them.
          const [a, b2] = chairs;
          const pair = b2 && dot(fwd(a.yaw), fwd(b2.yaw)) > 0.7;
          const mid = b2 ? mul(add(a.pos, b2.pos), 0.5) : a.pos;
          if (!b2 || pair) push(add(mid, mul(fwd(a.yaw), a.item.dims.d / 2 + 0.4 + d / 2)), a.yaw, 4, b2 ? 'in front of the pair of chairs' : 'in front of the accent chair');
          else push(mid, a.yaw, 3, 'between the chairs');
        }
        push(centroid, walls[0] ? yawOf(walls[0].n) : 0, 0.5, 'center of the room');
        break;
      }
      case 'rug': {
        const sofa = findPlaced('sofa'), table = findPlaced('coffee_table', 'dining_table'), bed = findPlaced('bed'), desk = findPlaced('desk');
        const both = (pos: V2, yaw: number, s: number, why: string) => { push(pos, yaw, s, why); push(pos, yaw + Math.PI / 2, s - 1, why); };
        // Designer rule: the sofa's front legs sit on the rug, the rug runs under the coffee table.
        if (sofa) both(add(sofa.pos, mul(fwd(sofa.yaw), sofa.item.dims.d / 2 - 0.25 + d / 2)), sofa.yaw, 6, 'sofa front legs on the rug, anchors the seating group');
        if (sofa && table) both(mul(add(sofa.pos, table.pos), 0.5), sofa.yaw, 5, 'anchors the seating group');
        if (table && table.item.category === 'dining_table') both(table.pos, table.yaw, 6, 'under the dining table, chairs stay on it');
        if (bed) {
          both(add(bed.pos, mul(fwd(bed.yaw), bed.item.dims.d * 0.2)), bed.yaw, 5, 'under the lower two-thirds of the bed');
          push(add(bed.pos, mul(fwd(bed.yaw), bed.item.dims.d / 2 + d / 2 - 0.3)), bed.yaw + Math.PI / 2, 3.5, 'across the foot of the bed');
        }
        if (table && !sofa && table.item.category === 'coffee_table') {
          // Chairs without a sofa: the rug centers on the coffee table and reaches the chairs' front legs.
          const chair = findPlaced('armchair');
          const toward = chair ? mul(norm(sub(chair.pos, table.pos)), 0.15) : v(0, 0);
          both(add(table.pos, toward), table.yaw, 5, 'under the coffee table, grounding the chairs');
        }
        if (desk) both(add(desk.pos, mul(fwd(desk.yaw), desk.item.dims.d / 2 + 0.2)), desk.yaw, 3, 'under the desk chair');
        const chair = findPlaced('armchair');
        if (chair) both(add(chair.pos, mul(fwd(chair.yaw), 0.4)), chair.yaw, 2, 'grounds the reading corner');
        push(centroid, walls[0] ? yawOf(walls[0].n) : 0, 1, 'center of the room');
        break;
      }
      case 'armchair': {
        const sofa = findPlaced('sofa'), table = findPlaced('coffee_table');
        if (sofa && table) {
          for (const side of [1, -1]) {
            const pos = add(table.pos, mul(right(sofa.yaw), side * (table.item.dims.w / 2 + 0.35 + d / 2)));
            push(pos, sofa.yaw - side * (Math.PI / 2 + 0.2), 4.2, 'angled toward the sofa across the coffee table');
          }
          // Opposite the sofa, facing it.
          const opp = add(table.pos, mul(fwd(sofa.yaw), table.item.dims.d / 2 + 0.4 + d / 2));
          for (const s of [0, 0.5, -0.5]) push(add(opp, mul(right(sofa.yaw), s * (w + 0.1))), sofa.yaw + Math.PI, 3.8, 'facing the sofa for conversation');
        } else if (sofa) {
          beside(sofa, 0.35 + w / 2, sofa.item.dims.d / 2 + 0.3, 3, 'turned toward the sofa', -Math.PI / 5);
        }
        const other = findPlaced('armchair');
        if (other) push(add(other.pos, mul(right(other.yaw), -(w + 0.5))), other.yaw, 3.5, 'a matching pair');
        const shelf = findPlaced('bookshelf');
        if (shelf) beside(shelf, 0.15 + w / 2, shelf.item.dims.d / 2 + 0.25, 2.5, 'a reading spot by the bookshelf');
        cornerSlots(poly, centroid, w, d, push, 'cozy reading corner', 1.5);
        break;
      }
      case 'side_table': {
        const seat = findPlaced('sofa') ?? findPlaced('armchair');
        if (seat) beside(seat, w / 2 + 0.05, -(seat.item.dims.d / 2) + d / 2 + 0.05, 4, `at the arm of the ${labelOf(seat.item.category)}`);
        const chair = allPlaced('armchair').find((c) => c !== seat);
        if (chair) beside(chair, w / 2 + 0.05, 0, 3, 'next to the accent chair');
        break;
      }
      case 'nightstand': {
        const bed = findPlaced('bed');
        if (bed) beside(bed, w / 2 + 0.05, -bed.item.dims.d / 2 + d / 2 + 0.02, 5, 'beside the bed');
        break;
      }
      case 'office_chair': {
        const desk = findPlaced('desk');
        if (desk) push(add(desk.pos, mul(fwd(desk.yaw), desk.item.dims.d / 2 + d / 2 + 0.05)), desk.yaw + Math.PI, 5, 'pulled up to the desk');
        break;
      }
      case 'dining_chair': {
        const table = findPlaced('dining_table');
        if (table) {
          const tw = table.item.dims.w, td = table.item.dims.d;
          const perSide = Math.max(1, Math.min(3, Math.floor(tw / 0.6)));
          for (const s of [1, -1]) {
            for (let k = 0; k < perSide; k++) {
              const off = perSide === 1 ? 0 : (k / (perSide - 1) - 0.5) * (tw - 0.6);
              const pos = add(add(table.pos, mul(fwd(table.yaw), s * (td / 2 + d / 2 + 0.05))), mul(right(table.yaw), off));
              // Balanced: a side with fewer chairs than the other goes first.
              const mine = allPlaced('dining_chair').filter((ch) => dot(sub(ch.pos, table.pos), fwd(table.yaw)) * s > td / 2).length;
              const theirs = allPlaced('dining_chair').filter((ch) => dot(sub(ch.pos, table.pos), fwd(table.yaw)) * -s > td / 2).length;
              push(pos, table.yaw + (s > 0 ? Math.PI : 0), 5 - Math.abs(off) * 0.2 + (theirs - mine) * 1.2, 'at the dining table');
            }
          }
          for (const s of [1, -1]) push(add(table.pos, mul(right(table.yaw), s * (tw / 2 + d / 2 + 0.05))), table.yaw + (s > 0 ? -Math.PI / 2 : Math.PI / 2), 4, 'at the head of the table');
        }
        break;
      }
      case 'floor_lamp': {
        const seat = findPlaced('armchair') ?? findPlaced('sofa') ?? findPlaced('bed');
        if (seat) beside(seat, w / 2 + 0.1, -seat.item.dims.d / 2 + d / 2 + 0.05, 4, `reading light by the ${labelOf(seat.item.category)}`);
        const sofa = findPlaced('sofa');
        if (sofa && sofa !== seat) beside(sofa, w / 2 + 0.1, -sofa.item.dims.d / 2 + d / 2 + 0.05, 3.5, 'reading light by the sofa');
        const desk = findPlaced('desk');
        if (desk) beside(desk, w / 2 + 0.1, 0, 3, 'lights the desk');
        cornerSlots(poly, centroid, w, d, push, 'lights a dark corner', 1.5);
        break;
      }
      case 'table_lamp':
        onTops(['side_table', 'nightstand', 'desk', 'dresser', 'cabinet', 'tv_stand', 'bookshelf', 'coffee_table', 'dining_table'], 6, 4.5);
        break;
      case 'ottoman': {
        const chair = findPlaced('armchair');
        if (chair) push(add(chair.pos, mul(fwd(chair.yaw), chair.item.dims.d / 2 + 0.25 + d / 2)), chair.yaw, 4, 'footrest for the armchair');
        const table = findPlaced('coffee_table'), sofa = findPlaced('sofa');
        if (table && sofa) for (const s of [1, -1]) push(add(table.pos, mul(right(sofa.yaw), s * (table.item.dims.w / 2 + 0.25 + w / 2))), sofa.yaw, 3, 'extra seat by the coffee table');
        const bed = findPlaced('bed');
        if (bed) push(add(bed.pos, mul(fwd(bed.yaw), bed.item.dims.d / 2 + 0.05 + d / 2)), bed.yaw, 3, 'at the foot of the bed');
        break;
      }
      case 'plant':
        if (stackable('plant', item.dims)) onTops(['side_table', 'dresser', 'bookshelf', 'cabinet', 'tv_stand', 'desk', 'bench', 'nightstand', 'coffee_table'], 3.5, 3);
        cornerSlots(poly, centroid, w, d, push, 'softens a corner', 2);
        for (const p of allPlaced('sofa', 'bookshelf', 'tv_stand', 'dresser', 'desk')) beside(p, w / 2 + 0.12, -p.item.dims.d / 2 + d / 2 + 0.05, 1.2, `beside the ${labelOf(p.item.category)}`);
        break;
      case 'wall_art': case 'mirror': {
        const floorMirror = item.category === 'mirror' && h > 1.2;
        if (floorMirror) {
          wallSlots('ends');
          for (const c of cands) c.y = 0;
          break;
        }
        const overCats = item.category === 'mirror' ? ['dresser', 'bench', 'side_table', 'cabinet', 'sofa'] : ['sofa', 'bed', 'desk', 'dresser', 'tv_stand', 'bench', 'cabinet'];
        const bottom = (under: number) => Math.max(under + 0.22, 1.45 - h / 2);
        overCats.forEach((cat, i) => {
          for (const over of allPlaced(cat)) {
            const back = sub(over.pos, mul(fwd(over.yaw), over.item.dims.d / 2 + GAP - d / 2 - 0.01));
            const wl = nearestWall(walls, back);
            if (!wl || Math.abs(dot(sub(back, wl.c), wl.n)) > 0.2) continue; // the piece isn't against a wall
            push(back, over.yaw, 5 - i * 0.4, `centered above the ${labelOf(cat)}`, bottom(over.item.dims.h));
          }
        });
        const couch = existing(/COUCH|BED/);
        if (couch) {
          const cp = facing(room, couch);
          if (cp.againstWall) push(sub(cp.pos, mul(fwd(cp.yaw), cp.d / 2 - d / 2)), cp.yaw, 4, `above your ${/BED/.test(couch.label) ? 'bed' : 'couch'}`, bottom(couch.size.y));
        }
        for (const wl of walls) {
          for (const s of [0, -0.25, 0.25]) {
            const pos = add(add(wl.c, mul(wl.t, s * wl.width)), mul(wl.n, d / 2 + 0.01));
            push(pos, yawOf(wl.n), Math.min(wl.width, 5) * 0.1 - Math.abs(s) * 0.8 - (wl.hasDoor ? 0.8 : 0), 'centered on a wall', 1.45 - h / 2);
          }
        }
        break;
      }
    }

    // Generic fallbacks so a piece with nowhere obvious still finds a sensible spot.
    if (def.mount === 'floor' && !cands.some((c) => c.score >= 2)) {
      wallSlots('any', undefined, -0.5);
      if (def.anchor === 'corner' || item.category === 'plant' || item.category === 'floor_lamp') cornerSlots(poly, centroid, w, d, push, 'in a corner', 0.5);
      if (!WALL_ONLY.has(item.category)) gridSlots(poly, centroid, push);
    }
    return cands;
  }
}

/** Where a piece's use zone lies (legroom, drawer arc, chair room), or null for pieces that don't need one. */
function zoneOf(category: string, body: Obb): Obb | null {
  if (category === 'dining_table') return { ...body, hw: body.hw + 0.7, hd: body.hd + 0.7 };
  const depth = FRONT_CLEAR[category];
  if (!depth) return null;
  return { c: add(body.c, mul(fwd(body.yaw), body.hd + depth / 2)), hw: body.hw * 0.9, hd: depth / 2, yaw: body.yaw };
}

function cornerSlots(poly: V2[], centroid: V2, w: number, d: number, push: (p: V2, yaw: number, s: number, why: string) => void, why: string, score: number) {
  const r = Math.hypot(w, d) / 2 + 0.05; // clearance for a diagonal (room-facing) orientation
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], a = poly[(i + poly.length - 1) % poly.length], b = poly[(i + 1) % poly.length];
    const e1 = norm(sub(a, p)), e2 = norm(sub(b, p));
    // Only real corners (roughly square), not the many shallow bends a hand-drawn outline has.
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(e1, e2))));
    if (angle < Math.PI / 3 || angle > (2 * Math.PI) / 3) continue;
    const pos = add(add(p, mul(e1, r)), mul(e2, r));
    if (!inPolygon(pos, poly)) continue; // a reflex corner points into the room
    push(pos, yawOf(sub(centroid, pos)), score, why);
  }
}

function gridSlots(poly: V2[], centroid: V2, push: (p: V2, yaw: number, s: number, why: string) => void) {
  const xs = poly.map((p) => p.x), zs = poly.map((p) => p.z);
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.25) {
    for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.25) {
      const pos = v(x, z);
      push(pos, yawOf(sub(centroid, pos)), -0.5 - len(sub(pos, centroid)) * 0.05, 'open floor space');
    }
  }
}

function wallsFromPolygon(poly: V2[]): RoomGeometry['walls'] {
  const out: RoomGeometry['walls'] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const t = norm(sub(b, a));
    out.push({ center: { x: (a.x + b.x) / 2, y: 1.25, z: (a.z + b.z) / 2 }, normal: { x: -t.z, y: 0, z: t.x }, width: len(sub(b, a)), height: 2.5 });
  }
  return out;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

// ------------------------------------------------------------------------------------------ existing furniture

/**
 * Which way a real piece faces and its footprint in that frame (w across, d front to back), using the same rule as a
 * replacement's pose (realPose.ts): backed onto the wall it's against, else facing into the room.
 */
function facing(room: RoomModel, o: RoomObject): { pos: V2; yaw: number; w: number; d: number; againstWall: boolean } {
  const pose = replacementPose(o, { w: o.size.x, d: o.size.z, h: o.size.y }, room.geo.walls, room.floorY, room.centroid);
  const yaw = (pose.yawDeg * Math.PI) / 180, yaw0 = (o.yawDeg * Math.PI) / 180;
  const f = fwd(yaw);
  const d = Math.abs(dot(f, fwd(yaw0))) * o.size.z + Math.abs(dot(f, right(yaw0))) * o.size.x;
  const w = Math.abs(dot(f, right(yaw0))) * o.size.z + Math.abs(dot(f, fwd(yaw0))) * o.size.x;
  return { pos: v(o.center.x, o.center.z), yaw, w, d, againstWall: pose.againstWall };
}

/** Rectangular default room around the user for when the headset has no Space Setup data. */
export function defaultGeometry(user?: RoomGeometry['user']): RoomGeometry {
  const cx = user?.position.x ?? 0, cz = (user?.position.z ?? 0) + 1.2;
  const W = 4, D = 4.5;
  const poly = [{ x: cx - W / 2, z: cz - D / 2 }, { x: cx + W / 2, z: cz - D / 2 }, { x: cx + W / 2, z: cz + D / 2 }, { x: cx - W / 2, z: cz + D / 2 }];
  return { floorY: 0, ceilingHeight: 2.5, floorPolygon: poly, walls: [], objects: [], user };
}

