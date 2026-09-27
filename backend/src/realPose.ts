import { CATEGORIES } from './catalog.js';
import type { Dims, RoomObject, Vec3 } from './types.js';

// Pure helpers for the user's real furniture (Space Setup boxes): what kind of furniture a box is, how well a product's
// size matches it, and where a replacement should stand. No I/O, so tests and the layout solver can use them directly.
// Unity mirrors replacementPose() in Room/ReplacementPose.cs; keep the two in step.

export const isOpening = (label: string) => /DOOR|WINDOW/i.test(label);

/** First Space Setup label of a (possibly combined) MRUK label string: "TABLE, OTHER" -> "TABLE". */
export const primaryLabel = (label: string) => (label.split(/[,|]/)[0] ?? '').trim().toUpperCase();

const NAMES: Record<string, string> = { COUCH: 'couch', TABLE: 'table', DESK: 'desk', BED: 'bed', STORAGE: 'storage unit', SHELF: 'shelf', SCREEN: 'TV', LAMP: 'lamp', PLANT: 'plant', OTHER: 'piece' };

/** "your couch", "your table": how the designer refers to a real piece. */
export const labelName = (label: string) => NAMES[primaryLabel(label)] ?? primaryLabel(label).toLowerCase().replace(/_/g, ' ');

/**
 * Our furniture type for a Space Setup box. The label says what it is; the size says which kind
 * (a narrow "couch" is an armchair, a low table a coffee table, tall storage a bookshelf...).
 * null = can't tell (SCREEN, OTHER): the user picks a type before replacing it.
 */
export function categoryForBox(label: string, size: Vec3): string | null {
  const L = primaryLabel(label);
  const w = Math.max(size.x, size.z), d = Math.min(size.x, size.z), h = size.y;
  if (L === 'COUCH') return w < 1.15 ? 'armchair' : 'sofa';
  if (L === 'BED') return 'bed';
  if (L === 'TABLE' || L === 'DESK') {
    if (h < 0.58) return w < 0.7 ? 'side_table' : 'coffee_table';
    if (d >= 0.75) return 'dining_table';
    return w >= 0.9 ? 'desk' : 'side_table';
  }
  if (L === 'STORAGE' || L === 'SHELF') {
    if (h >= 1.3) return d <= 0.45 ? 'bookshelf' : 'cabinet';
    if (h < 0.7) return w >= 1.2 ? 'tv_stand' : w < 0.6 ? 'nightstand' : 'cabinet';
    return w >= 1.0 ? 'dresser' : 'cabinet';
  }
  if (L === 'LAMP') return h >= 1.0 ? 'floor_lamp' : 'table_lamp';
  if (L === 'PLANT') return 'plant';
  return null;
}

/** Furniture types that make sense for a label, most likely first (the headset's type picker cycles these). */
export function categoryChoices(label: string, auto: string | null): string[] {
  const L = primaryLabel(label);
  const byLabel: Record<string, string[]> = {
    COUCH: ['sofa', 'armchair', 'bench', 'ottoman'],
    TABLE: ['coffee_table', 'side_table', 'dining_table', 'desk', 'nightstand'],
    DESK: ['desk', 'dining_table', 'side_table'],
    STORAGE: ['dresser', 'cabinet', 'bookshelf', 'tv_stand', 'nightstand'],
    SHELF: ['bookshelf', 'cabinet', 'dresser'],
    BED: ['bed'],
    LAMP: ['floor_lamp', 'table_lamp'],
    PLANT: ['plant'],
  };
  const list = byLabel[L] ?? CATEGORIES.filter((c) => c.mount === 'floor' && c.key !== 'rug').map((c) => c.key);
  return auto ? [auto, ...list.filter((c) => c !== auto)] : list;
}

/**
 * How far a product's size is from a real piece's box, as a fraction (0 = same size, 0.25 = 25% off). Orientation-free:
 * the long side is compared with the long side. Height counts less than footprint. null = product size unknown.
 */
export function sizeError(d: Dims | undefined | null, box: Pick<RoomObject, 'size'>): number | null {
  if (!d || !(d.w > 0) || !(d.d > 0) || !(d.h > 0)) return null;
  const pl = Math.max(d.w, d.d), ps = Math.min(d.w, d.d);
  const bl = Math.max(box.size.x, box.size.z, 0.05), bs = Math.max(Math.min(box.size.x, box.size.z), 0.05);
  return Math.max(Math.abs(pl / bl - 1), 0.8 * Math.abs(ps / bs - 1), 0.6 * Math.abs(d.h / Math.max(box.size.y, 0.05) - 1));
}

type V2 = { x: number; z: number };
const v = (x: number, z: number): V2 => ({ x, z });
const add = (a: V2, b: V2) => v(a.x + b.x, a.z + b.z);
const sub = (a: V2, b: V2) => v(a.x - b.x, a.z - b.z);
const mul = (a: V2, s: number) => v(a.x * s, a.z * s);
const dot = (a: V2, b: V2) => a.x * b.x + a.z * b.z;
const norm = (a: V2) => { const l = Math.hypot(a.x, a.z) || 1; return v(a.x / l, a.z / l); };

export interface WallLike { center: Vec3; normal: Vec3; width: number }
export interface Pose { position: Vec3; yawDeg: number; againstWall: boolean }

/**
 * Where a replacement product stands so it reads as "the new one in the old one's place": its width runs along the
 * piece's long side; if the piece backs onto a wall, the product's back goes against that same wall and it faces
 * into the room; otherwise it's centered on the piece, facing the room. Pieces raised off the floor (a lamp on a
 * table) keep their height.
 */
export function replacementPose(box: RoomObject, dims: Dims, walls: WallLike[], floorY: number, centroid: V2): Pose {
  const yaw = (box.yawDeg * Math.PI) / 180;
  const f = v(Math.sin(yaw), Math.cos(yaw)), r = v(Math.cos(yaw), -Math.sin(yaw));
  const c = v(box.center.x, box.center.z);
  const longIsX = box.size.x >= box.size.z;
  const ratio = Math.max(box.size.x, box.size.z) / Math.max(Math.min(box.size.x, box.size.z), 0.01);
  // Front/back axis = across the short side; square-ish pieces may face either way, so try both axes.
  const axes = ratio < 1.15 ? [{ n: longIsX ? f : r, half: (longIsX ? box.size.z : box.size.x) / 2 }, { n: longIsX ? r : f, half: (longIsX ? box.size.x : box.size.z) / 2 }]
    : [{ n: longIsX ? f : r, half: (longIsX ? box.size.z : box.size.x) / 2 }];

  let front: V2 | null = null, half = axes[0].half, best = Infinity;
  for (const ax of axes) {
    for (const s of [1, -1]) {
      const dir = mul(ax.n, s);
      const back = sub(c, mul(dir, ax.half));
      for (const w of walls) {
        const wc = v(w.center.x, w.center.z);
        let wn = norm(v(w.normal.x, w.normal.z));
        if (dot(wn, sub(centroid, wc)) < 0) wn = mul(wn, -1); // into the room
        if (dot(wn, dir) < 0.7) continue;                     // we'd back onto this wall facing away from it
        const t = v(wn.z, -wn.x);
        if (Math.abs(dot(sub(back, wc), t)) > w.width / 2 + 0.1) continue;
        const dist = dot(sub(back, wc), wn);
        if (dist > -0.15 && dist < 0.35 && dist < best) { best = dist; front = dir; half = ax.half; }
      }
    }
  }
  const againstWall = front != null;
  if (!front) front = dot(axes[0].n, sub(centroid, c)) >= 0 ? axes[0].n : mul(axes[0].n, -1);
  const pos = againstWall ? add(sub(c, mul(front, half)), mul(front, dims.d / 2)) : c;
  const bottom = box.center.y - box.size.y / 2;
  const y = bottom > floorY + 0.12 ? bottom : floorY;
  const yawDeg = Math.round(((Math.atan2(front.x, front.z) * 180) / Math.PI + 360) % 360);
  return { position: { x: round(pos.x), y: round(y), z: round(pos.z) }, yawDeg, againstWall };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
