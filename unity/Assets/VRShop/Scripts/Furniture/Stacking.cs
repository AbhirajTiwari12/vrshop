using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using VRShop.Api;
using VRShop.Interaction;
using VRShop.Room;

namespace VRShop.Furniture
{
    /// <summary>
    /// What can go on top of what, from the catalog's kinds of items: table lamps and small plants go on flat tops
    /// (tables, desks, nightstands, dressers, cabinets, TV stands, bookshelves; small plants on benches too), virtual
    /// ones and the user's real tables / desks / storage. Everything else stands on the floor, art hangs on walls.
    /// Pure rules + math (unit-tested); Stacking does the scene work. Mirrored by stackable() in backend/src/layout.ts.
    /// </summary>
    public static class StackRules
    {
        static readonly HashSet<string> k_Tops = new HashSet<string>
            { "coffee_table", "side_table", "dining_table", "desk", "nightstand", "dresser", "cabinet", "tv_stand", "bookshelf", "bench" };
        static readonly HashSet<string> k_RealTops = new HashSet<string> { "TABLE", "DESK", "STORAGE", "SHELF" };

        /// <summary>Items small enough to sit on a top: table lamps, and plants under ~0.9 m that fit a tabletop.</summary>
        public static bool IsStackable(string category, Dims d)
        {
            if (category == "table_lamp") return true;
            if (category != "plant") return false;
            return d == null || (d.h <= 0.9f && Mathf.Max(d.w, d.d) <= 0.7f);
        }

        /// <summary>Does a virtual piece of this kind have a usable top?</summary>
        public static bool IsTop(string category) => category != null && k_Tops.Contains(category);

        /// <summary>Does a real piece with this Space Setup label have a usable top? (Not couches, beds or TVs.)</summary>
        public static bool IsRealTop(string label) => label != null && k_RealTops.Contains(label);

        /// <summary>
        /// May an item of <paramref name="item"/> kind sit on a top of <paramref name="topCategory"/> kind (null = a real
        /// table / storage) at <paramref name="topHeight"/> above the floor? Lamps don't go on benches or up on tall
        /// shelves; plants can (a trailing plant on a bookshelf).
        /// </summary>
        public static bool Allows(string item, Dims itemDims, string topCategory, float topHeight)
        {
            if (!IsStackable(item, itemDims)) return false;
            if (item == "table_lamp") return topCategory != "bench" && topHeight <= 1.3f;
            return topHeight <= 2.2f; // plants
        }

        /// <summary>
        /// Where an item's center can be so its whole footprint stays on a top (with a small margin), as close as
        /// possible to <paramref name="desired"/>. False if it's too big for the top at this angle.
        /// </summary>
        public static bool TryClampOnto(Obb top, Obb item, Vector2 desired, out Vector2 center, float margin = 0.015f)
        {
            // The item's half extents along the top's own axes (it may be turned relative to the top).
            var ex = Mathf.Abs(Vector2.Dot(item.Right, top.Right)) * item.HalfWidth + Mathf.Abs(Vector2.Dot(item.Fwd, top.Right)) * item.HalfDepth;
            var ez = Mathf.Abs(Vector2.Dot(item.Right, top.Fwd)) * item.HalfWidth + Mathf.Abs(Vector2.Dot(item.Fwd, top.Fwd)) * item.HalfDepth;
            var maxX = top.HalfWidth - ex - margin;
            var maxZ = top.HalfDepth - ez - margin;
            center = desired;
            if (maxX < 0 || maxZ < 0) return false;
            var rel = desired - top.Center;
            var x = Mathf.Clamp(Vector2.Dot(rel, top.Right), -maxX, maxX);
            var z = Mathf.Clamp(Vector2.Dot(rel, top.Fwd), -maxZ, maxZ);
            center = top.Center + top.Right * x + top.Fwd * z;
            return true;
        }
    }

    /// <summary>A flat top something can stand on: a placed piece of furniture, or one of the user's real ones.</summary>
    public struct Top
    {
        public FurnitureItem item;   // virtual (null for a real piece)
        public RealPiece piece;      // real (null for a virtual piece)
        public float y;              // world height of the top surface
        public Obb footprint;

        public string Name => item != null ? UI.UIKit.Pretty(item.Product.category).ToLowerInvariant() : piece != null ? $"your {piece.Name}" : "top";
        public string Category => item != null ? item.Product.category : null;
    }

    /// <summary>Scene side of stacking: find tops, rest items on them (they move with the piece below), lift them off.</summary>
    public static class Stacking
    {
        static float FloorY => RoomService.Instance != null ? RoomService.Instance.FloorY : 0f;

        public static float HeightAboveFloor(float y) => y - FloorY;

        public static Top? TopOf(FurnitureItem item)
        {
            if (item == null || item.Dims == null || !StackRules.IsTop(item.Product.category)) return null;
            return new Top { item = item, y = item.transform.position.y + item.Dims.h, footprint = Obb.Of(item.transform, item.Dims.w, item.Dims.d) };
        }

        public static Top? TopOf(RealPiece piece)
        {
            if (piece == null || piece.IsReplaced || !StackRules.IsRealTop(piece.Label)) return null;
            return new Top { piece = piece, y = piece.Top, footprint = piece.Footprint };
        }

        public static bool Allows(FurnitureItem item, Top top) =>
            item != null && StackRules.Allows(item.Product.category, item.Dims, top.Category, HeightAboveFloor(top.y));

        /// <summary>The top a controller ray is pointing at (its upper face), if <paramref name="item"/> may go on it.</summary>
        public static Top? UnderRay(Ray ray, FurnitureItem item, out bool tooBig, out Top blockedBy)
        {
            tooBig = false;
            blockedBy = default;
            var hits = Physics.RaycastAll(ray, 12f, ~0, QueryTriggerInteraction.Collide).OrderBy(h => h.distance);
            foreach (var h in hits)
            {
                if (item != null && h.collider.transform.IsChildOf(item.transform)) continue; // itself and what it carries
                if (h.collider.GetComponentInParent<Handle>() != null) continue;
                Top? top = null;
                var piece = h.collider.GetComponent<RealPiece>();
                if (piece != null) top = TopOf(piece);
                else
                {
                    var fi = h.collider.GetComponentInParent<FurnitureItem>();
                    if (fi != null) top = TopOf(fi);
                    else if (h.collider.GetComponent<RoomSurface>() != null) return null; // floor / wall first
                    else continue;                                                      // UI and other triggers
                }
                // Something without a usable top (a sofa) is in the way: not a top.
                if (!top.HasValue || h.point.y < top.Value.y - 0.06f) return null;
                if (!Allows(item, top.Value)) { blockedBy = top.Value; return null; }
                return top;
            }
            return null;
        }

        /// <summary>Put <paramref name="item"/> on <paramref name="top"/> as close to <paramref name="desired"/> as fits. False if it doesn't fit.</summary>
        public static bool RestOn(FurnitureItem item, Top top, Vector2 desired)
        {
            if (item == null || item.Dims == null) return false;
            var shape = Obb.Of(item.transform, item.Dims.w, item.Dims.d);
            if (!StackRules.TryClampOnto(top.footprint, shape, desired, out var c)) return false;
            item.transform.position = new Vector3(c.x, top.y, c.y);
            if (top.item != null)
            {
                item.transform.SetParent(top.item.transform, true); // moves and turns with the piece below
                item.RestingOnPieceId = null;
            }
            else
            {
                item.transform.SetParent(null, true);
                item.RestingOnPieceId = top.piece.Id;
            }
            return true;
        }

        /// <summary>Take an item off whatever it stands on (keeps its world position).</summary>
        public static void LiftOff(FurnitureItem item)
        {
            if (item == null) return;
            if (item.transform.parent != null) item.transform.SetParent(null, true);
            item.RestingOnPieceId = null;
        }

        /// <summary>Items standing on this piece (virtual carrier) or on this real piece.</summary>
        public static List<FurnitureItem> Carried(FurnitureItem carrier) =>
            carrier == null ? new List<FurnitureItem>() : FurnitureManager.Instance.Items.Where(i => i != null && i != carrier && i.transform.parent == carrier.transform).ToList();

        public static List<FurnitureItem> Carried(RealPiece piece) =>
            piece == null ? new List<FurnitureItem>() : FurnitureManager.Instance.Items.Where(i => i != null && i.RestingOnPieceId == piece.Id).ToList();

        /// <summary>
        /// Move items onto a new top (a replacement taking over a real table), keeping their spots where they fit;
        /// anything that can't go there drops to the nearest free floor spot.
        /// </summary>
        public static void MoveOnto(IEnumerable<FurnitureItem> items, Top? top)
        {
            foreach (var i in items.ToList())
            {
                if (i == null) continue;
                LiftOff(i);
                var pos = i.transform.position;
                if (top.HasValue && Allows(i, top.Value) && RestOn(i, top.Value, new Vector2(pos.x, pos.z))) continue;
                DropToFloor(i);
            }
        }

        public static void DropToFloor(FurnitureItem item)
        {
            if (item == null) return;
            LiftOff(item);
            var p = item.transform.position;
            p.y = FloorY;
            var rf = RealFurniture.Instance;
            if (rf != null && item.Dims != null) p = rf.FreeSpot(p, item.Dims.w, item.Dims.d, item.transform.eulerAngles.y, item, true);
            item.transform.position = p;
            ManipulationController.Instance?.CheckFit(item);
        }

        /// <summary>Carried items follow a carrier whose height changed (its real model came in taller or shorter).</summary>
        public static void Reseat(FurnitureItem carrier)
        {
            var top = TopOf(carrier);
            if (!top.HasValue) return;
            foreach (var i in Carried(carrier))
            {
                var pos = i.transform.position;
                if (!RestOn(i, top.Value, new Vector2(pos.x, pos.z))) DropToFloor(i);
            }
        }

        public static void Reseat(RealPiece piece)
        {
            var top = TopOf(piece);
            foreach (var i in Carried(piece))
            {
                var pos = i.transform.position;
                if (!top.HasValue || !RestOn(i, top.Value, new Vector2(pos.x, pos.z))) DropToFloor(i);
            }
        }

        /// <summary>
        /// After an item was put somewhere above the floor (a layout, "put a lamp here" at a tabletop): rest it on the
        /// top under it, or drop it to the floor if there's none it may stand on.
        /// </summary>
        public static void Settle(FurnitureItem item)
        {
            if (item == null || item.IsWallMounted || item.Dims == null) return;
            var pos = item.transform.position;
            if (HeightAboveFloor(pos.y) < 0.05f) { LiftOff(item); return; }
            var xz = new Vector2(pos.x, pos.z);
            var candidates = new List<Top>();
            foreach (var other in FurnitureManager.Instance.Items)
            {
                if (other == null || other == item || other.transform.IsChildOf(item.transform)) continue;
                var t = TopOf(other);
                if (t.HasValue) candidates.Add(t.Value);
            }
            if (RealFurniture.Instance != null)
                foreach (var p in RealFurniture.Instance.Pieces) { var t = TopOf(p); if (t.HasValue) candidates.Add(t.Value); }
            var best = candidates
                .Where(t => Mathf.Abs(t.y - pos.y) < 0.12f && Allows(item, t) && Contains(t.footprint, xz))
                .OrderBy(t => Mathf.Abs(t.y - pos.y))
                .Cast<Top?>()
                .FirstOrDefault();
            if (best.HasValue && RestOn(item, best.Value, xz)) return;
            DropToFloor(item);
        }

        static bool Contains(Obb box, Vector2 p)
        {
            var rel = p - box.Center;
            return Mathf.Abs(Vector2.Dot(rel, box.Right)) <= box.HalfWidth && Mathf.Abs(Vector2.Dot(rel, box.Fwd)) <= box.HalfDepth;
        }
    }
}
