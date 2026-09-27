import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { heuristicInterpret } from '../src/ai/assistant.js';
import { solveLayout } from '../src/layout.js';
import { findPiece, syncPieces } from '../src/realFurniture.js';
import { categoryChoices, categoryForBox, replacementPose, sizeError } from '../src/realPose.js';
import type { RoomGeometry, RoomObject, Session } from '../src/types.js';

const box = (label: string, x: number, y: number, z: number, center = { x: 0, y: y / 2, z: 0 }, yawDeg = 0, id = label.toLowerCase()): RoomObject =>
  ({ id, label, center, size: { x, y, z }, yawDeg });

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
const centroid = { x: 0, z: 2.5 };

describe('categoryForBox', () => {
  it('reads the type from the label and the kind from the size', () => {
    assert.equal(categoryForBox('COUCH', { x: 2.1, y: 0.85, z: 0.9 }), 'sofa');
    assert.equal(categoryForBox('COUCH', { x: 0.85, y: 0.9, z: 0.85 }), 'armchair');
    assert.equal(categoryForBox('TABLE', { x: 1.1, y: 0.45, z: 0.6 }), 'coffee_table');
    assert.equal(categoryForBox('TABLE', { x: 0.5, y: 0.5, z: 0.5 }), 'side_table');
    assert.equal(categoryForBox('TABLE', { x: 1.6, y: 0.75, z: 0.9 }), 'dining_table');
    assert.equal(categoryForBox('TABLE', { x: 1.2, y: 0.74, z: 0.6 }), 'desk');
    assert.equal(categoryForBox('STORAGE', { x: 0.8, y: 1.8, z: 0.3 }), 'bookshelf');
    assert.equal(categoryForBox('STORAGE', { x: 1.2, y: 0.8, z: 0.5 }), 'dresser');
    assert.equal(categoryForBox('STORAGE', { x: 1.6, y: 0.5, z: 0.4 }), 'tv_stand');
    assert.equal(categoryForBox('LAMP', { x: 0.4, y: 1.6, z: 0.4 }), 'floor_lamp');
    assert.equal(categoryForBox('TABLE, OTHER', { x: 1.1, y: 0.45, z: 0.6 }), 'coffee_table');
  });
  it('leaves screens and unknown boxes for the user to name', () => {
    assert.equal(categoryForBox('SCREEN', { x: 1.2, y: 0.7, z: 0.1 }), null);
    assert.equal(categoryForBox('OTHER', { x: 1, y: 1, z: 1 }), null);
    assert.ok(categoryChoices('OTHER', null).includes('sofa'));
    assert.ok(!categoryChoices('OTHER', null).includes('rug'));
  });
  it('puts the auto type first in the choices', () => {
    assert.deepEqual(categoryChoices('COUCH', 'armchair').slice(0, 2), ['armchair', 'sofa']);
  });
});

describe('sizeError', () => {
  const couch = box('COUCH', 2.0, 0.85, 0.9);
  it('is 0 for the same size in either orientation', () => {
    assert.equal(sizeError({ w: 2.0, d: 0.9, h: 0.85 }, couch), 0);
    assert.equal(sizeError({ w: 0.9, d: 2.0, h: 0.85 }, couch), 0);
  });
  it('grows with the difference and ignores unknown sizes', () => {
    assert.ok(Math.abs(sizeError({ w: 2.5, d: 0.9, h: 0.85 }, couch)! - 0.25) < 1e-9);
    assert.equal(sizeError(undefined, couch), null);
  });
});

describe('replacementPose', () => {
  it('backs a replacement onto the same wall and faces it into the room', () => {
    // Couch against the z=0 wall, its box depth axis along z (yaw 0), back 5 cm off the wall.
    const couch = box('COUCH', 2.0, 0.85, 0.9, { x: 0.3, y: 0.425, z: 0.5 });
    const pose = replacementPose(couch, { w: 2.2, d: 0.95, h: 0.8 }, room([]).walls, 0, centroid);
    assert.equal(pose.againstWall, true);
    assert.equal(pose.yawDeg, 0); // faces +z, into the room
    assert.ok(Math.abs(pose.position.z - (0.05 + 0.95 / 2)) < 1e-6, `back stays 5 cm off the wall (z=${pose.position.z})`);
    assert.equal(pose.position.x, 0.3);
  });
  it('works when the Space Setup box faces the other way', () => {
    const couch = box('COUCH', 2.0, 0.85, 0.9, { x: 0, y: 0.425, z: 0.5 }, 180);
    const pose = replacementPose(couch, { w: 2.0, d: 0.9, h: 0.85 }, room([]).walls, 0, centroid);
    assert.equal(pose.yawDeg, 0);
    assert.ok(Math.abs(pose.position.z - 0.5) < 1e-6);
  });
  it('turns the product to run along the long side of a box drawn sideways', () => {
    // Couch against the x=-2 wall: long side along z, so the box's x size is the short one.
    const couch = box('COUCH', 0.9, 0.85, 2.0, { x: -1.5, y: 0.425, z: 2.5 });
    const pose = replacementPose(couch, { w: 2.0, d: 0.9, h: 0.85 }, room([]).walls, 0, centroid);
    assert.equal(pose.yawDeg, 90); // faces +x, away from the wall
    assert.ok(Math.abs(pose.position.x - (-1.5)) < 1e-6);
  });
  it('centers a freestanding piece and faces the room center', () => {
    const table = box('TABLE', 1.1, 0.45, 0.6, { x: 0, y: 0.225, z: 3.6 });
    const pose = replacementPose(table, { w: 1.0, d: 0.5, h: 0.4 }, room([]).walls, 0, centroid);
    assert.equal(pose.againstWall, false);
    assert.equal(pose.position.z, 3.6);
    assert.equal(pose.yawDeg, 180);
  });
  it('keeps a lamp standing on a table at the table top', () => {
    const lamp = box('LAMP', 0.3, 0.5, 0.3, { x: 1, y: 0.75 + 0.25, z: 3 });
    assert.equal(replacementPose(lamp, { w: 0.3, d: 0.3, h: 0.5 }, room([]).walls, 0, centroid).position.y, 0.75);
  });
});

describe('solveLayout with real pieces', () => {
  const couch = box('COUCH', 2.0, 0.85, 0.9, { x: 0, y: 0.425, z: 0.5 });
  it('treats kept pieces as obstacles and replaced ones as free space', () => {
    const geo = room([couch]);
    const kept = solveLayout(geo, [{ productId: 'rug', category: 'coffee_table', dims: { w: 1.1, d: 0.6, h: 0.45 } }]);
    assert.match(kept[0].reason ?? '', /your couch/);
    const replaced = solveLayout(geo, [{ productId: 't', category: 'coffee_table', dims: { w: 1.1, d: 0.6, h: 0.45 } }], { skipObjectIds: ['couch'] });
    assert.doesNotMatch(replaced[0].reason ?? '', /your couch/);
  });
  it('keeps a pinned replacement in place and arranges the rest around it', () => {
    const geo = room([couch]);
    const out = solveLayout(geo, [
      { productId: 'sofa', category: 'sofa', dims: { w: 2.0, d: 0.9, h: 0.85 } },
      { productId: 'table', category: 'coffee_table', dims: { w: 1.1, d: 0.6, h: 0.45 } },
    ], { fixed: [{ productId: 'sofa', position: { x: 0, y: 0, z: 0.5 }, yawDeg: 0, reason: 'in place of your couch' }], skipObjectIds: ['couch'] });
    const sofa = out.find((p) => p.productId === 'sofa')!, table = out.find((p) => p.productId === 'table')!;
    assert.deepEqual([sofa.position.x, sofa.position.z, sofa.yawDeg], [0, 0.5, 0]);
    assert.equal(sofa.reason, 'in place of your couch');
    assert.match(table.reason ?? '', /in front of the sofa/);
    assert.ok(Math.abs(table.position.z - (0.5 + 0.45 + 0.45 + 0.3)) < 1e-6, `table at z=${table.position.z}`);
  });
});

describe('pieces and voice', () => {
  const geo = room([box('COUCH', 2, 0.85, 0.9, { x: 0, y: 0.4, z: 0.5 }, 0, 'a1'), box('TABLE', 1.1, 0.45, 0.6, { x: 0, y: 0.2, z: 2 }, 0, 'a2'), box('DOOR_FRAME', 0.9, 2, 0.05, { x: 1, y: 1, z: 0 }, 0, 'd1')]);
  it('syncs pieces from geometry and keeps the user\'s decisions', () => {
    const first = syncPieces(undefined, geo);
    assert.deepEqual(Object.keys(first).sort(), ['a1', 'a2']);
    assert.equal(first.a1.category, 'sofa');
    assert.equal(first.a1.state, 'keep');
    const edited = { ...first, a2: { ...first.a2, state: 'replace' as const, category: 'desk', categorySource: 'user' as const, replacementId: 'ikea-1' } };
    const again = syncPieces(edited, geo);
    assert.equal(again.a2.state, 'replace');
    assert.equal(again.a2.category, 'desk');
    assert.equal(again.a2.replacementId, 'ikea-1');
  });
  it('finds the piece the user means', () => {
    const s = { geometry: geo, realFurniture: syncPieces(undefined, geo) } as unknown as Session;
    assert.equal(findPiece(s, 'couch')?.id, 'a1');
    assert.equal(findPiece(s, 'the coffee table')?.id, 'a2');
    assert.equal(findPiece(s, 'this', 'a2')?.id, 'a2');
    assert.equal(findPiece(s, 'this'), undefined); // two pieces and no pointing: ask
  });
  it('understands "replace my couch with ..." without an AI key', () => {
    const ctx = { filters: {}, visible: [], total: 0, priceRange: null, room: null, budget: null, cartTotal: 0, chat: [], stores: [], realFurniture: ['couch (sofa)'] };
    const r = heuristicInterpret('replace my couch with a green velvet sofa', ctx);
    assert.equal(r.action, 'replace');
    assert.equal(r.replaceTarget, 'couch');
    assert.equal(r.filters.category, 'sofa');
    assert.deepEqual(r.filters.colors, ['green']);
    assert.deepEqual(r.filters.materials, ['velvet']);
    assert.equal(heuristicInterpret('swap this for something round', ctx).replaceTarget, 'this');
  });
});

describe('stacking in layouts', () => {
  const lamp = (id: string) => ({ productId: id, category: 'table_lamp', dims: { w: 0.3, d: 0.3, h: 0.5 } });
  const sideTable = box('TABLE', 0.5, 0.55, 0.5, { x: 1.4, y: 0.275, z: 1 }, 0, 'side');
  const couch = box('COUCH', 2.0, 0.85, 0.9, { x: 0, y: 0.425, z: 0.5 }, 0, 'couch');
  it('puts a table lamp on the user\'s real side table, at its height', () => {
    const [p] = solveLayout(room([couch, sideTable]), [lamp('l1')]);
    assert.match(p.reason ?? '', /on your table/);
    assert.deepEqual([p.position.x, p.position.y, p.position.z], [1.4, 0.55, 1]);
  });
  it('never on a couch, a tall shelf, or a table being replaced', () => {
    const tall = box('STORAGE', 0.8, 1.8, 0.35, { x: -1.5, y: 0.9, z: 3 }, 90, 'shelf');
    const [a] = solveLayout(room([couch, tall]), [lamp('l1')]);
    assert.equal(a.position.y, 0, `lamp stays on the floor: ${a.reason}`);
    const [b] = solveLayout(room([couch, sideTable]), [lamp('l1')], { skipObjectIds: ['side'] });
    assert.equal(b.position.y, 0);
  });
  it('prefers a placed nightstand, and gives each lamp its own top', () => {
    const out = solveLayout(room([sideTable]), [
      { productId: 'bed', category: 'bed', dims: { w: 1.6, d: 2.1, h: 1.0 } },
      { productId: 'ns', category: 'nightstand', dims: { w: 0.45, d: 0.4, h: 0.55 } },
      lamp('l1'), lamp('l2'),
    ]);
    const l1 = out.find((p) => p.productId === 'l1')!, l2 = out.find((p) => p.productId === 'l2')!;
    assert.match(l1.reason ?? '', /on the nightstand/);
    assert.match(l2.reason ?? '', /on your table/);
  });
  it('puts small plants on tops and trees in corners', () => {
    const shelf = box('STORAGE', 1.2, 0.8, 0.45, { x: -1.4, y: 0.4, z: 3 }, 90, 'dresser');
    const [small] = solveLayout(room([shelf]), [{ productId: 'p', category: 'plant', dims: { w: 0.3, d: 0.3, h: 0.5 } }]);
    assert.match(small.reason ?? '', /on your storage unit/);
    assert.equal(small.position.y, 0.8);
    const [tree] = solveLayout(room([shelf]), [{ productId: 't', category: 'plant', dims: { w: 0.5, d: 0.5, h: 1.4 } }]);
    assert.equal(tree.position.y, 0);
    assert.match(tree.reason ?? '', /corner/);
  });
});

describe('layout fallbacks', () => {
  it('finds open floor when the preferred spot is taken', () => {
    const out = solveLayout(room([]), [
      { productId: 'bed', category: 'bed', dims: { w: 1.2, d: 2.4, h: 0.6 } },
      { productId: 'set', category: 'dining_table', dims: { w: 1.3, d: 0.66, h: 0.5 }, isSet: true },
    ]);
    const set = out.find((p) => p.productId === 'set')!;
    assert.doesNotMatch(set.reason ?? '', /in front of you/);
  });
});
