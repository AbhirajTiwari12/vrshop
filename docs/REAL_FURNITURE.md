# Your real furniture: keep or replace

Passthrough shows the user's real room, so virtual furniture used to pass straight through their real couch. Now every
box from the Quest's **Space Setup** (couch, table, bed, storage, lamp, plant...) is a *real piece* the user can
**keep** or **replace**.

- **Keep** (the default): nothing virtual ends up inside the piece.
  - While dragging, an item can pass through it: it's outlined red, with a light buzz as it enters. Let go there and
    it glides to the nearest free spot. Turning an item into it works the same way: it slides clear when you let go
    of the stick. Walls always stop it.
  - New items start in the nearest free spot.
  - "Design my room" arranges around it, and doesn't suggest a second sofa next to your couch.
  - Virtual items behind it are hidden by it, as before.
- **Replace**: the real piece is painted out of passthrough, and a product of the same kind and about the same size
  rises in its spot, backed onto the same wall and facing the room.
  - **Try others:** ‹ › on the card, or thumbstick ↑↓.
  - **Place it elsewhere:** drag it anywhere; the old piece stays painted out.
  - **Bigger replacements** push other *virtual* items out of the way. Real furniture never moves. If it can't fit, it
    says so: "Overlaps your table by 12 cm".
  - **Keep** brings the real piece back.
- **By voice:** hold X and say "replace my couch with a green velvet sofa", or point at a piece and say "replace this
  with something round".
- **Adjust**: if a Space Setup box is a little off, drag its dots to fit (sides, top, the dark disc to move it,
  thumbstick to turn).
  - The adjustment is saved on the headset per Space Setup anchor, so it survives restarts and new rooms from the phone.
  - It's sent to the server with the room.
  - "Reset to scan" goes back to Space Setup's box.

Point at a real piece to see its card; click it to pin the card. "Clear room" also brings every real piece back.

## Things on top of things

Table lamps and small plants (under ~0.9 m, fitting the top) can stand on flat tops: coffee / side / dining tables,
desks, nightstands, dressers, cabinets, TV stands, bookshelves (plants also on benches). That covers virtual ones
and the user's real Space Setup tables, desks and storage (not couches, beds or TVs). Lamps don't go on benches or
tops above 1.3 m.
- **Dragging:** drag one over a top and it hops on and stays within the edges; drag it past the edge and it's back on
  the floor.
- **Placing:** "Place" or "put a lamp here" while pointing at a tabletop puts it there.
- **Moving the piece below:** things on a piece move and turn with it.
- **Deleting the piece below:** things on it drop to the nearest free floor spot.
- **Replacing a real table:** its lamp moves onto the replacement, and Keep moves it back.
- **"Design my room":** puts lamps and small plants on tops (placed ones first, then the user's real tables), one per
  top; trees stay in corners.

Rules: `StackRules` in `Furniture/Stacking.cs`, mirrored by `stackable()` / `allowedOnTop()` in `backend/src/layout.ts`.

## How "painted out" works (Quest 2)

Apps can't read the Quest 2's cameras, so nothing can truly erase an object. `Shaders/RoomCover.shader` hides it
instead:

- **The drawing:** it draws the back faces of the piece's box, slightly enlarged. For each pixel seen through the box,
  it traces the view ray to the floor, wall or ceiling behind the piece and draws that surface.
- **Depth:** it writes that surface's real depth. So the replacement and its shadow draw on top correctly, and kept
  furniture in front still hides it.
- **Soft edge:** the edge fades with how much of the box the ray crosses.
- **Color:** Quest 2 passthrough is black and white, so the floor and wall are grays the user matches under "Match your
  room" on the card; the setting is saved on the headset. On color-passthrough headsets (Quest 3-class), the room
  analysis colors are used.

Honest limits:
- **Up close:** it's a flat, slightly grainy tone, not the real texture, so it reads as "gone" from a normal viewing
  distance rather than up close.
- **Things behind a replaced piece:** another real piece behind it can't be shown, since nothing ever saw it.
- **Box accuracy:** it only covers the box; a box drawn much too small leaves part of the real piece visible, which is
  what Adjust is for.

## Where it lives

| Piece | File |
|---|---|
| Pieces, decisions, server sync, thumbstick, tones, saved box adjustments | `unity/Assets/VRShop/Scripts/Room/RealFurniture.cs` |
| One piece: collider, occluder, cover, outline, handles | `Room/RealPiece.cs`, `Room/BoxHandles.cs`, `Room/WireBox.cs` |
| Its card | `UI/RealPieceTag.cs` |
| Solid dragging, free spots (pure math, unit-tested) | `Interaction/Footprint.cs` (`Obb`, `FootprintSolver`) |
| Where a replacement stands | `Room/ReplacementPose.cs`, mirrored by `backend/src/realPose.ts` |
| Box → furniture type, size match, pose | `backend/src/realPose.ts` |
| Piece state, candidates (with IKEA sizes fetched once and cached), voice matching | `backend/src/realFurniture.ts` |

Backend API:
- **Uploading a room** (`POST /api/sessions/:id/geometry`, objects now carry their anchor `id`) syncs
  `session.realFurniture` and fetches likely replacements' sizes in the background.
- **`PUT /api/sessions/:id/real/:pieceId`** takes `{ state: 'keep' | 'replace', category?, replacementId?,
  clearReplacement? }`.
- **`GET /api/sessions/:id/real/:pieceId/candidates?category=&limit=`** returns products of the same type, sized like
  the piece (within 25%, then 40%, then closest), ranked for the room's style. In `DEMO_3D_ONLY` mode, only products
  with official 3D models are included, and the top 5 are downloaded ahead.
- **`POST /api/sessions/:id/layout`** accepts `fixed: [{ productId, position, yawDeg, reason }]`. Replaced pieces stop
  being obstacles.
- **The assistant** has a `replace` action; `/ask` and `/voice` accept `pieceId` (what the user pointed at) and return
  `replace: { pieceId, category, productIds, products }`.

Tests: `cd backend && npm test`, and Unity EditMode tests (`Assets/VRShop/Tests/Editor`).
