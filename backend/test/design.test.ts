import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { arrangeDesign } from '../src/design.js';
import { syncPieces } from '../src/realFurniture.js';
import type { Dims, RoomGeometry, RoomObject } from '../src/types.js';

// 4 m x 5 m room, floor at y=0, x in [-2, 2], z in [0, 5]. Walls' normals point into the room.
const room = (objects: RoomObject[]): RoomGeometry => ({
  floorY: 0,
  ceilingHeight: 2.5,
  floorPolygon: [{ x: -2, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 5 }, { x: -2, z: 5 }],
  walls: [
    { center: { x: 0, y: 1.25, z: 0 }, normal: { x: 0, y: 0, z: 1 }, width: 4, height: 2.5 },
    { center: { x: 0, y: 1.25, z: 5 }, normal: { x: 0, y: 0, z: -1 }, width: 4, height: 2.5 },
    { center: { x: -2, y: 1.25, z: 2.5 }, normal: { x: 1, y: 0, z: 0 }, width: 5, height: 2.5 },
    { center: { x: 2, y: 1.25, z: 2.5 }, normal: { x: -1, y: 0, z: 0 }, width: 5, height: 2.5 },
  ],
  objects,
});
const obj = (id: string, label: string, c: [number, number, number], size: [number, number, number], yawDeg = 0): RoomObject =>
  ({ id, label, center: { x: c[0], y: c[1], z: c[2] }, size: { x: size[0], y: size[1], z: size[2] }, yawDeg });
const item = (category: string, dims: Dims) => ({ productId: `${category}-new`, category, dims });

function design(geo: RoomGeometry, items: ReturnType<typeof item>[], placed: Parameters<typeof arrangeDesign>[0]['placed'] = []) {
  return arrangeDesign({ geo, mode: 'style', items, realFurniture: syncPieces(undefined, geo), placed });
}

describe('design: replace, never double up', () => {
  it('stands the new sofa in the spot of a couch backed flush onto a wall', () => {
    // Couch against the z=5 wall, facing into the room; its back touches the wall exactly.
    const geo = room([obj('couch', 'COUCH', [0, 0.42, 4.55], [2.2, 0.85, 0.9], 180)]);
    const a = design(geo, [item('sofa', { w: 2.1, d: 0.9, h: 0.8 }), item('coffee_table', { w: 1.1, d: 0.6, h: 0.45 })]);
    const sofas = a.layout.placements.filter((p) => p.productId === 'sofa-new');
    assert.equal(sofas.length, 1);
    assert.equal(sofas[0].replaced?.objectId, 'couch');
    assert.ok(Math.abs(sofas[0].position.z - 4.55) < 0.06, `sofa z ${sofas[0].position.z}`);
    assert.equal(sofas[0].yawDeg, 180);
    assert.deepEqual(a.paintOut, []);
  });

  it('keeps a bed running head to foot when it replaces the real bed', () => {
    const geo = room([obj('bed', 'BED', [0, 0.3, 1.05], [1.5, 0.6, 2.05], 0)]);
    const a = design(geo, [item('bed', { w: 1.6, d: 2.1, h: 1.0 })]);
    const bed = a.layout.placements[0];
    assert.equal(bed.replaced?.objectId, 'bed');
    assert.equal(bed.yawDeg, 0); // headboard on the z=0 wall, facing into the room
    assert.ok(Math.abs(bed.position.z - 1.05) < 0.06, `bed z ${bed.position.z}`);
  });

  it('paints out a real piece whose replacement fits better elsewhere, instead of doubling it', () => {
    // A small couch squeezed between two tall shelves: a 2.6 m sofa can't stand there.
    const geo = room([
      obj('couch', 'COUCH', [-1.5, 0.4, 2.5], [1.4, 0.8, 0.9], 90),
      obj('s1', 'SHELF', [-1.8, 0.95, 1.4], [0.8, 1.9, 0.35], 90),
      obj('s2', 'SHELF', [-1.8, 0.95, 3.6], [0.8, 1.9, 0.35], 90),
    ]);
    const a = design(geo, [item('sofa', { w: 2.6, d: 0.95, h: 0.8 })]);
    assert.equal(a.layout.placements.filter((p) => p.productId === 'sofa-new').length, 1);
    assert.ok(a.paintOut.includes('couch') || a.layout.freedObjects.includes('couch'), 'the real couch is replaced');
  });

  it('never paints out a TV bench with the TV still standing on it', () => {
    const geo = room([
      obj('bench', 'STORAGE', [0, 0.25, 0.2], [1.2, 0.5, 0.4], 0),
      obj('tv', 'SCREEN', [0, 0.85, 0.2], [1.1, 0.65, 0.08], 0),
      obj('s1', 'SHELF', [-1.05, 0.95, 0.18], [0.8, 1.9, 0.35], 0),
      obj('s2', 'SHELF', [1.05, 0.95, 0.18], [0.8, 1.9, 0.35], 0),
    ]);
    // Too wide for the gap between the shelves.
    const a = design(geo, [item('tv_stand', { w: 1.9, d: 0.45, h: 0.5 })]);
    assert.ok(!a.paintOut.includes('bench'));
    assert.equal(a.layout.placements.length, 0);
    assert.match(a.layout.skipped[0]?.reason ?? '', /kept your storage unit/);
  });

  it('replaces virtual pieces placed earlier instead of adding more', () => {
    const geo = room([]);
    const placed = [{ instanceId: 'i1', productId: 'old-sofa', category: 'sofa', position: { x: 0, y: 0, z: 4.5 }, yawDeg: 180, dims: { w: 2, d: 0.9, h: 0.8 } }];
    const a = design(geo, [item('sofa', { w: 2.1, d: 0.9, h: 0.8 })], placed);
    assert.deepEqual(a.remove, ['i1']);
    assert.equal(a.layout.placements[0].replaced?.instanceId, 'i1');
  });
});
