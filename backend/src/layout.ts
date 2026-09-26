import { categoryDef } from './catalog.js';
import type { Dims, Placement, RoomGeometry, Vec3 } from './types.js';

// "Design my room": deterministic interior-layout solver.
// Works in the headset's world space (meters, Y up). Yaw convention matches Unity:
// yaw rotates +Z toward +X; an item's front (+Z in its model) faces (sin(yaw), cos(yaw)).
// Strategy: place anchor pieces on walls first (bed, sofa, desk...), then pieces that relate to them
// (coffee table in front of the sofa, rug under the group, nightstands beside the bed, lamp by the seat...),
// validating every candidate against the floor outline, existing furniture boxes and already placed items.

export interface LayoutItem { productId: string; category: string; dims: Dims; anchor?: string; near?: string }

type V2 = { x: number; z: number };
interface Obb { c: V2; hw: number; hd: number; yaw: number }
interface Placed { item: LayoutItem; pos: V2; yaw: number; y: number; obb: Obb }
interface Wall { c: V2; n: V2; t: V2; width: number; hasDoor: boolean; hasWindow: boolean }

const ORDER = ['bed', 'sofa', 'desk', 'dining_table', 'tv_stand', 'dresser', 'bookshelf', 'cabinet', 'coffee_table', 'rug', 'armchair', 'side_table', 'nightstand', 'office_chair', 'dining_chair', 'floor_lamp', 'table_lamp', 'ottoman', 'bench', 'plant', 'mirror', 'wall_art'];
const GAP = 0.03;

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

export function solveLayout(geo: RoomGeometry, items: LayoutItem[]): Placement[] {
  const poly = geo.floorPolygon.map((p) => v(p.x, p.z));
  const centroid = poly.reduce((a, p) => add(a, mul(p, 1 / poly.length)), v(0, 0));
  const doors = geo.objects.filter((o) => /DOOR/i.test(o.label));
  const windows = geo.objects.filter((o) => /WINDOW/i.test(o.label));
  const walls: Wall[] = (geo.walls.length ? geo.walls : wallsFromPolygon(poly)).map((w) => {
    const c = v(w.center.x, w.center.z);
    let n = norm(v(w.normal.x, w.normal.z));
    if (dot(n, sub(centroid, c)) < 0) n = mul(n, -1); // make sure normals point into the room
    const t = v(n.z, -n.x);
    const near = (o: { center: Vec3 }) => Math.abs(dot(sub(v(o.center.x, o.center.z), c), n)) < 0.25 && Math.abs(dot(sub(v(o.center.x, o.center.z), c), t)) < w.width / 2;
    return { c, n, t, width: w.width, hasDoor: doors.some(near), hasWindow: windows.some(near) };
  });

  // Obstacles: existing furniture (Space Setup boxes) + door swing zones.
  const obstacles: Obb[] = [];
  for (const o of geo.objects) {
    if (/WALL|FLOOR|CEILING|WINDOW|ART|INVISIBLE/i.test(o.label)) continue;
    if (/DOOR/i.test(o.label)) {
      const wall = walls.reduce((best, w) => (Math.abs(dot(sub(v(o.center.x, o.center.z), w.c), w.n)) < Math.abs(dot(sub(v(o.center.x, o.center.z), best.c), best.n)) ? w : best), walls[0]);
      if (wall) obstacles.push({ c: add(v(o.center.x, o.center.z), mul(wall.n, 0.5)), hw: Math.max(o.size.x, 0.9) / 2, hd: 0.5, yaw: yawOf(wall.n) });
      continue;
    }
    obstacles.push({ c: v(o.center.x, o.center.z), hw: o.size.x / 2, hd: o.size.z / 2, yaw: (o.yawDeg * Math.PI) / 180 });
  }
  const existing = (label: RegExp) => geo.objects.find((o) => label.test(o.label));

  const placed: Placed[] = [];
  const results: Placement[] = [];
  const sorted = [...items].sort((a, b) => rank(a.category) - rank(b.category));

  const fits = (obb: Obb, isRug: boolean) => {
    if (!corners(obb).every((p) => inPolygon(p, poly)) || !inPolygon(obb.c, poly)) return false;
    if (isRug) return true;
    return !obstacles.some((o) => overlaps(o, obb)) && !placed.some((p) => p.item.category !== 'rug' && p.y < 0.05 && categoryDef(p.item.category).mount !== 'wall' && overlaps(p.obb, obb));
  };
  const findPlaced = (...cats: string[]) => placed.find((p) => cats.includes(p.item.category));

  for (const item of sorted) {
    const def = categoryDef(item.category);
    const { w, d, h } = item.dims;
    const isRug = item.category === 'rug';
    const cands: { pos: V2; yaw: number; y?: number; score: number; why: string }[] = [];
    const push = (pos: V2, yaw: number, score: number, why: string, y?: number) => cands.push({ pos, yaw, score, why, y });

    const wallSlots = (prefer: 'center' | 'ends' | 'any', filter: (wl: Wall) => boolean = () => true, depth = d) => {
      for (const wl of walls) {
        if (!filter(wl)) continue;
        const span = wl.width / 2 - w / 2 - 0.05;
        if (span < 0) continue;
        for (let s = -span; s <= span + 1e-6; s += 0.1) {
          const pos = add(add(wl.c, mul(wl.t, s)), mul(wl.n, depth / 2 + GAP));
          const centered = 1 - Math.abs(s) / Math.max(span, 0.01);
          const sc = prefer === 'center' ? centered : prefer === 'ends' ? 1 - centered : 0.5;
          push(pos, yawOf(wl.n), sc + wl.width * 0.05 - (wl.hasDoor ? 0.6 : 0), `against a ${wl.width.toFixed(1)} m wall`);
        }
      }
    };
    const beside = (anchor: Placed | undefined, sideGap: number, forwardOffset: number, yawOffset = 0, why = '') => {
      if (!anchor) return;
      const f = fwd(anchor.yaw), r = right(anchor.yaw);
      for (const side of [1, -1]) {
        const pos = add(add(anchor.pos, mul(r, side * (anchor.item.dims.w / 2 + sideGap))), mul(f, forwardOffset));
        push(pos, anchor.yaw + yawOffset * side, 2, why || `next to the ${categoryDef(anchor.item.category).label.toLowerCase()}`);
      }
    };

    switch (item.category) {
      case 'sofa': {
        const screen = existing(/SCREEN/) ?? null;
        wallSlots('center');
        if (screen) for (const c of cands) c.score += 2 * dot(fwd(c.yaw), norm(sub(v(screen.center.x, screen.center.z), c.pos)));
        break;
      }
      case 'bed':
        wallSlots('center', (wl) => !wl.hasDoor);
        wallSlots('center');
        break;
      case 'desk':
        wallSlots('center');
        for (const c of cands) if (walls.some((wl) => wl.hasWindow && Math.abs(dot(sub(c.pos, wl.c), wl.n)) < d)) c.score += 1.5;
        break;
      case 'tv_stand': {
        wallSlots('center');
        const sofa = findPlaced('sofa') ?? null;
        const couch = existing(/COUCH/);
        const target = sofa ? sofa.pos : couch ? v(couch.center.x, couch.center.z) : null;
        if (target) for (const c of cands) c.score += 2 * dot(fwd(c.yaw), norm(sub(target, c.pos)));
        break;
      }
      case 'dresser': case 'bookshelf': case 'cabinet': case 'bench':
        wallSlots('ends');
        break;
      case 'coffee_table': {
        const sofa = findPlaced('sofa');
        const couch = existing(/COUCH/);
        if (sofa) push(add(sofa.pos, mul(fwd(sofa.yaw), sofa.item.dims.d / 2 + 0.45 + d / 2)), sofa.yaw, 5, 'in front of the sofa, 45 cm legroom');
        else if (couch) {
          const yaw = (couch.yawDeg * Math.PI) / 180;
          push(add(v(couch.center.x, couch.center.z), mul(fwd(yaw), couch.size.z / 2 + 0.45 + d / 2)), yaw, 4, 'in front of your couch');
        }
        push(centroid, walls[0] ? yawOf(walls[0].n) : 0, 1, 'center of the room');
        break;
      }
      case 'rug': {
        const sofa = findPlaced('sofa'), table = findPlaced('coffee_table', 'dining_table'), bed = findPlaced('bed');
        // Designer rule: the sofa's front legs sit on the rug, the rug runs under the coffee table.
        if (sofa) push(add(sofa.pos, mul(fwd(sofa.yaw), sofa.item.dims.d / 2 - 0.25 + d / 2)), sofa.yaw, 6, 'sofa front legs on the rug, anchors the seating group');
        if (sofa && table) push(mul(add(sofa.pos, table.pos), 0.5), sofa.yaw, 5, 'anchors the seating group');
        if (table && table.item.category === 'dining_table') push(table.pos, table.yaw, 5, 'under the dining table');
        if (bed) push(add(bed.pos, mul(fwd(bed.yaw), bed.item.dims.d * 0.2)), bed.yaw, 4, 'under the lower two-thirds of the bed');
        push(centroid, walls[0] ? yawOf(walls[0].n) : 0, 1, 'center of the room');
        break;
      }
      case 'armchair': {
        const sofa = findPlaced('sofa'), table = findPlaced('coffee_table');
        if (sofa && table) {
          for (const side of [1, -1]) {
            const pos = add(table.pos, mul(right(sofa.yaw), side * (table.item.dims.w / 2 + 0.35 + d / 2)));
            push(pos, sofa.yaw - side * (Math.PI / 2), 4, 'facing the sofa across the coffee table');
          }
        }
        cornerSlots(poly, centroid, w, d, push, 'cozy corner');
        break;
      }
      case 'side_table':
        beside(findPlaced('sofa', 'armchair'), w / 2 + 0.05, -((findPlaced('sofa', 'armchair')?.item.dims.d ?? 0) / 2) + d / 2 + 0.05);
        break;
      case 'nightstand': {
        const bed = findPlaced('bed');
        if (bed) beside(bed, w / 2 + 0.05, -bed.item.dims.d / 2 + d / 2 + 0.02, 0, 'beside the bed');
        break;
      }
      case 'office_chair': {
        const desk = findPlaced('desk');
        if (desk) push(add(desk.pos, mul(fwd(desk.yaw), desk.item.dims.d / 2 + d / 2 + 0.02)), desk.yaw + Math.PI, 5, 'pulled up to the desk');
        break;
      }
      case 'dining_chair': {
        const table = findPlaced('dining_table');
        if (table) for (const s of [1, -1]) push(add(table.pos, mul(fwd(table.yaw), s * (table.item.dims.d / 2 + d / 2 + 0.02))), table.yaw + (s > 0 ? Math.PI : 0), 5, 'at the dining table');
        break;
      }
      case 'floor_lamp': {
        const seat = findPlaced('sofa', 'armchair', 'bed');
        if (seat) beside(seat, w / 2 + 0.12, -seat.item.dims.d / 2 + d / 2 + 0.05, 0, `reading light by the ${categoryDef(seat.item.category).label.toLowerCase()}`);
        cornerSlots(poly, centroid, w, d, push, 'lights a dark corner');
        break;
      }
      case 'table_lamp': {
        const surf = findPlaced('side_table', 'nightstand', 'desk', 'dresser');
        if (surf) push(surf.pos, surf.yaw, 6, `on the ${categoryDef(surf.item.category).label.toLowerCase()}`, surf.item.dims.h);
        break;
      }
      case 'ottoman': {
        const chair = findPlaced('armchair');
        if (chair) push(add(chair.pos, mul(fwd(chair.yaw), chair.item.dims.d / 2 + 0.25 + d / 2)), chair.yaw, 4, 'footrest for the armchair');
        break;
      }
      case 'plant':
        cornerSlots(poly, centroid, w, d, push, 'softens a corner');
        break;
      case 'wall_art': case 'mirror': {
        const over = findPlaced('sofa', 'bed', 'desk', 'dresser', 'tv_stand');
        const couch = existing(/COUCH|BED/);
        const bottom = (under: number) => Math.max(under + 0.25, 1.45 - h / 2);
        if (over) {
          const back = sub(over.pos, mul(fwd(over.yaw), over.item.dims.d / 2 + GAP - d / 2 - 0.01));
          push(back, over.yaw, 5, `centered above the ${categoryDef(over.item.category).label.toLowerCase()}`, item.category === 'mirror' ? 0 : bottom(over.item.dims.h));
        } else if (couch) {
          const yaw = (couch.yawDeg * Math.PI) / 180;
          push(sub(v(couch.center.x, couch.center.z), mul(fwd(yaw), couch.size.z / 2 - d / 2)), yaw, 4, 'above your couch', bottom(couch.size.y));
        }
        for (const wl of walls) push(add(wl.c, mul(wl.n, d / 2 + 0.01)), yawOf(wl.n), wl.width * 0.1 - (wl.hasDoor ? 1 : 0), 'centered on a wall', item.category === 'mirror' ? 0 : 1.45 - h / 2);
        break;
      }
      case 'dining_table':
        push(centroid, walls[0] ? yawOf(walls[0].t) : 0, 3, 'center of the room');
        break;
    }

    // Generic fallbacks so everything lands somewhere sensible.
    if (def.mount === 'floor' && !cands.some((c) => c.score >= 2)) {
      if (def.anchor === 'wall') wallSlots('any');
      if (def.anchor === 'corner') cornerSlots(poly, centroid, w, d, push, 'in a corner');
      gridSlots(poly, centroid, push);
    }

    cands.sort((a, b) => b.score - a.score);
    // Wall-mounted items and items standing on another item (table lamp) skip floor collision checks.
    let chosen = cands.find((c) => def.mount === 'wall' || (c.y ?? 0) > 0.05 || fits({ c: c.pos, hw: w / 2, hd: d / 2, yaw: c.yaw }, isRug));
    let reason = chosen?.why ?? '';
    if (!chosen) {
      // Nothing valid: put it 1.5 m in front of the user and say so.
      const u = geo.user ? v(geo.user.position.x, geo.user.position.z) : centroid;
      const f = geo.user ? norm(v(geo.user.forward.x, geo.user.forward.z)) : v(0, 1);
      chosen = { pos: add(u, mul(f, 1.5)), yaw: yawOf(mul(f, -1)), score: 0, why: '' };
      reason = "didn't fit anywhere without overlapping — placed in front of you";
    }
    const obb = { c: chosen.pos, hw: w / 2, hd: d / 2, yaw: chosen.yaw };
    placed.push({ item, pos: chosen.pos, yaw: chosen.yaw, y: chosen.y ?? 0, obb });
    results.push({
      productId: item.productId,
      position: { x: round(chosen.pos.x), y: round(geo.floorY + (chosen.y ?? 0)), z: round(chosen.pos.z) },
      yawDeg: deg(chosen.yaw),
      reason,
    });
  }
  return results;
}

function cornerSlots(poly: V2[], centroid: V2, w: number, d: number, push: (p: V2, yaw: number, s: number, why: string) => void, why: string) {
  const r = Math.hypot(w, d) / 2 + 0.05; // clearance for a diagonal (room-facing) orientation
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], a = poly[(i + poly.length - 1) % poly.length], b = poly[(i + 1) % poly.length];
    const e1 = norm(sub(a, p)), e2 = norm(sub(b, p));
    const pos = add(add(p, mul(e1, r)), mul(e2, r));
    push(pos, yawOf(sub(centroid, pos)), 1.5, why);
  }
}

function gridSlots(poly: V2[], centroid: V2, push: (p: V2, yaw: number, s: number, why: string) => void) {
  const xs = poly.map((p) => p.x), zs = poly.map((p) => p.z);
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.25) {
    for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.25) {
      const pos = v(x, z);
      push(pos, yawOf(sub(centroid, pos)), 0.1 - len(sub(pos, centroid)) * 0.01, 'open floor space');
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

const rank = (c: string) => { const i = ORDER.indexOf(c); return i < 0 ? ORDER.length : i; };
const round = (x: number) => Math.round(x * 1000) / 1000;

/** Rectangular default room around the user for when the headset has no Space Setup data. */
export function defaultGeometry(user?: RoomGeometry['user']): RoomGeometry {
  const cx = user?.position.x ?? 0, cz = (user?.position.z ?? 0) + 1.2;
  const W = 4, D = 4.5;
  const poly = [{ x: cx - W / 2, z: cz - D / 2 }, { x: cx + W / 2, z: cz - D / 2 }, { x: cx + W / 2, z: cz + D / 2 }, { x: cx - W / 2, z: cz + D / 2 }];
  return { floorY: 0, ceilingHeight: 2.5, floorPolygon: poly, walls: [], objects: [], user };
}
