using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Newtonsoft.Json;
using UnityEngine;
using VRShop.Api;
using VRShop.Core;
using VRShop.Furniture;
using VRShop.Input;
using VRShop.Interaction;
using VRShop.Rendering;
using VRShop.UI;

namespace VRShop.Room
{
    /// <summary>
    /// The user's real furniture as pieces they can keep or replace.
    ///  - Keep (default): solid. Dragging, placing and "Design my room" never leave virtual furniture inside it.
    ///  - Replace: the piece is painted out of passthrough and a product of the same kind and size stands in its spot;
    ///    ‹ › / thumbstick ↑↓ cycles through candidates, voice ("replace my couch with a green velvet sofa") picks them.
    ///  - Adjust: fix a Space Setup box that's a little off (saved on the headset per anchor, sent with the room).
    /// Decisions live in the session on the server so voice, the phone and the layout solver see the same state.
    /// </summary>
    public class RealFurniture : MonoBehaviour
    {
        public static RealFurniture Instance { get; private set; }

        public readonly List<RealPiece> Pieces = new List<RealPiece>();
        public readonly List<WallPlane> Walls = new List<WallPlane>();
        public RealPiece Selected { get; private set; }
        public float FloorTone { get; private set; }
        public float WallTone { get; private set; }
        /// <summary>Quest 3-class headsets see the room in color; Quest 2 passthrough is black and white.</summary>
        public bool ColorPassthrough { get; private set; }

        [Serializable]
        public class BoxOverride
        {
            public float cx, cy, cz, sx, sy, sz, yaw;
            [JsonIgnore] public Vector3 Center => new Vector3(cx, cy, cz);
            [JsonIgnore] public Vector3 Size => new Vector3(sx, sy, sz);
        }

        const string FloorKey = "vrshop.cover.floor", WallKey = "vrshop.cover.wall";
        Dictionary<string, BoxOverride> m_Overrides = new Dictionary<string, BoxOverride>();
        readonly Dictionary<RealPiece, float> m_SyncReplacementAt = new Dictionary<RealPiece, float>();
        bool m_Swapping;
        int m_StickDir;
        float m_NextCycle;

        ApiClient Api => VRShopApp.Instance != null ? VRShopApp.Instance.Api : null;
        Session Session => VRShopApp.Instance != null ? VRShopApp.Instance.Session : null;
        string OverridesPath => Path.Combine(Application.persistentDataPath, "real_furniture.json");

        void Awake()
        {
            Instance = this;
            FloorTone = PlayerPrefs.GetFloat(FloorKey, 0.4f);
            WallTone = PlayerPrefs.GetFloat(WallKey, 0.62f);
            ColorPassthrough = DetectColorPassthrough();
            LoadOverrides();
        }

        void Start()
        {
            var room = RoomService.Instance;
            if (room != null)
            {
                room.OnReady += Build;
                if (room.Ready) Build();
            }
            if (VRShopApp.Instance != null) VRShopApp.Instance.SessionChanged += OnSession;
            LaserPointer.FloorClicked += OnFloorClicked;
        }

        void OnDestroy() => LaserPointer.FloorClicked -= OnFloorClicked;

        // ================================================================== pieces from the room

        void Build()
        {
            foreach (var p in Pieces) if (p != null) Destroy(p.gameObject);
            Pieces.Clear();
            Selected = null;
            var room = RoomService.Instance;
            Walls.Clear();
            foreach (var w in room.Walls) Walls.Add(new WallPlane(w.center, w.normal, w.width));
            foreach (var o in room.Objects)
            {
                if (o.isOpening || string.IsNullOrEmpty(o.id)) continue;
                var go = new GameObject($"Real_{o.label}");
                go.transform.SetParent(transform, false);
                var piece = go.AddComponent<RealPiece>();
                m_Overrides.TryGetValue(o.id, out var ov);
                piece.Init(o, ov);
                Pieces.Add(piece);
            }
            Debug.Log($"[VRShop] Real furniture: {Pieces.Count} piece(s): {string.Join(", ", Pieces.Select(p => p.Label))}");
            if (Session != null) OnSession(Session);
            // The room upload that just went out used Space Setup's boxes; send the user's adjusted ones.
            if (Pieces.Any(p => p.Adjusted)) _ = VRShopApp.Instance?.ResendGeometry();
        }

        public RealPiece Find(string id) => string.IsNullOrEmpty(id) ? null : Pieces.FirstOrDefault(p => p != null && p.Id == id);

        public RealPiece PieceOf(FurnitureItem item) => item == null || string.IsNullOrEmpty(item.ReplacesPieceId) ? null : Find(item.ReplacesPieceId);

        /// <summary>
        /// Footprints virtual furniture must stay out of: every kept piece, except one hanging entirely above a piece
        /// <paramref name="itemHeight"/> tall (a wall-mounted TV over a TV bench). Mirrors the layout solver.
        /// </summary>
        public List<Obb> Solids(float itemHeight = float.PositiveInfinity)
        {
            var floorY = RoomService.Instance != null ? RoomService.Instance.FloorY : 0f;
            return Pieces.Where(p => p != null && !p.IsReplaced && !Above(p, itemHeight, floorY)).Select(p => p.Footprint).ToList();
        }

        public static bool Above(RealPiece p, float itemHeight, float floorY) => p.Bottom >= floorY + itemHeight + 0.02f;

        /// <summary>
        /// Furniture types the room already has: kept pieces, and replaced ones whose replacement stands in their spot.
        /// "Design my room" doesn't suggest another of these (no second sofa next to the user's couch or its replacement).
        /// </summary>
        public HashSet<string> CoveredCategories() => new HashSet<string>(Pieces
            .Where(p => p != null && !string.IsNullOrEmpty(p.Category) && (!p.IsReplaced || p.Replacement != null))
            .SelectMany(p => p.Replacement != null ? new[] { p.Category, p.Replacement.Product.category } : new[] { p.Category }));

        public List<string> KeptNames() => Pieces.Where(p => p != null && !p.IsReplaced).Select(p => p.Name).Distinct().ToList();

        /// <summary>Replacements standing in real pieces' spots: the layout arranges everything else around them.</summary>
        public List<FixedPlacement> FixedPlacements() => Pieces
            .Where(p => p != null && p.IsReplaced && p.Replacement != null)
            .Select(p => new FixedPlacement
            {
                productId = p.Replacement.Product.id,
                position = new Vec3(p.Replacement.transform.position),
                yawDeg = p.Replacement.transform.eulerAngles.y,
                reason = $"in place of your {p.Name}",
            }).ToList();

        public static string NameOf(string label) => label switch
        {
            "COUCH" => "couch",
            "TABLE" => "table",
            "DESK" => "desk",
            "BED" => "bed",
            "STORAGE" => "storage unit",
            "SHELF" => "shelf",
            "SCREEN" => "TV",
            "LAMP" => "lamp",
            "PLANT" => "plant",
            "OTHER" => "piece",
            _ => string.IsNullOrEmpty(label) ? "piece" : label.ToLowerInvariant().Replace('_', ' '),
        };

        // ================================================================== placement helpers

        Func<Vector2, bool> Inside()
        {
            var room = RoomService.Instance;
            if (room == null || room.Outline.Count < 3) return null;
            return p => room.Contains(new Vector3(p.x, 0, p.y));
        }

        /// <summary>Nearest spot to <paramref name="desired"/> where a footprint overlaps no kept piece (and, optionally, no placed item).</summary>
        public Vector3 FreeSpot(Vector3 desired, float w, float d, float yawDeg, FurnitureItem ignore = null, bool avoidItems = false, float h = float.PositiveInfinity)
        {
            var shape = new Obb(desired, w / 2, d / 2, yawDeg);
            var solids = Solids(h);
            if (avoidItems && FurnitureManager.Instance != null)
                solids.AddRange(FurnitureManager.Instance.Items.Where(i => i != null && i != ignore && i.Dims != null && !i.IsWallMounted && !i.IsFloorLayer && !i.IsResting).Select(i => Obb.Of(i.transform, i.Dims.w, i.Dims.d)));
            return FootprintSolver.TryFindFreeSpot(desired, shape, solids, Walls, Inside(), out var spot) ? spot : FootprintSolver.Resolve(desired, shape, solids, Walls);
        }

        /// <summary>Slide placed (virtual) floor items out of a footprint that just became solid or occupied.</summary>
        void PushItemsOutOf(Obb area, FurnitureItem except = null)
        {
            var fm = FurnitureManager.Instance;
            if (fm == null) return;
            foreach (var other in fm.Items.ToList())
            {
                if (other == null || other == except || other.IsWallMounted || other.IsFloorLayer || other.Dims == null || other.IsResting) continue;
                var ob = Obb.Of(other.transform, other.Dims.w, other.Dims.d);
                if (!ob.Overlaps(area)) continue;
                var blockers = Solids(other.Dims.h);
                blockers.Add(area);
                blockers.AddRange(fm.Items.Where(i => i != null && i != other && i != except && i.Dims != null && !i.IsWallMounted && !i.IsFloorLayer && !i.IsResting).Select(i => Obb.Of(i.transform, i.Dims.w, i.Dims.d)));
                if (FootprintSolver.TryFindFreeSpot(other.transform.position, ob, blockers, Walls, Inside(), out var spot, 2.5f))
                    fm.GlideTo(other, spot);
            }
        }

        // ================================================================== selection

        public void Select(RealPiece p)
        {
            if (Selected == p) return;
            if (Selected != null)
            {
                if (Selected.Adjusting) EndAdjust(Selected, true);
                Selected.SetPinned(false);
            }
            Selected = p;
            if (p != null)
            {
                p.Message = null;
                p.SetPinned(true);
                if (ManipulationController.Instance != null && ManipulationController.Instance.Selected != p.Replacement) ManipulationController.Instance.Select(null);
            }
        }

        void OnFloorClicked(LaserPointer lp, RaycastHit hit)
        {
            if (Selected != null && !Selected.Adjusting) Select(null);
        }

        // ================================================================== keep / replace

        public async void Replace(RealPiece p)
        {
            if (p == null || Session == null || p.Searching) return;
            if (string.IsNullOrEmpty(p.Category))
            {
                p.Message = $"What should replace your {p.Name}? Pick a type with the button on the right.";
                p.RefreshTag();
                return;
            }
            if (p.IsReplaced && p.CandidateIds.Count > 0) { if (p.Replacement == null) ShowCandidate(p, p.CandidateIndex); return; }
            Select(p);
            p.Message = null;
            p.SetReplaced(true);
            p.Searching = true;
            p.PendingUntil = Time.time + 60;
            p.RefreshTag();
            try
            {
                var res = await Api.ReplacementCandidates(Session.id, p.Id, p.Category);
                if (p == null) return;
                p.Searching = false;
                if (!p.IsReplaced) { p.RefreshTag(); return; } // Keep was pressed meanwhile
                StoreCandidates(p, res?.products);
                if (p.CandidateIds.Count == 0)
                {
                    p.SetReplaced(false);
                    p.Message = $"No {UIKit.Pretty(p.Category).ToLowerInvariant()} with a 3D model near this size. Try another type, or ask me by voice.";
                    p.RefreshTag();
                    return;
                }
                ShowCandidate(p, 0);
                await Push(p, new { state = "replace", replacementId = p.CandidateIds[0] });
            }
            catch (Exception e)
            {
                if (p == null) return;
                p.Searching = false;
                p.SetReplaced(false);
                p.Message = $"Couldn't find replacements: {e.Message}";
                p.RefreshTag();
            }
        }

        public async void Keep(RealPiece p)
        {
            if (p == null) return;
            var was = p.IsReplaced;
            Restore(p);
            p.Message = null;
            p.RefreshTag();
            if (was) await Push(p, new { state = "keep" });
        }

        /// <summary>Bring the real piece back (locally): remove its replacement, make it solid again.</summary>
        void Restore(RealPiece p)
        {
            p.Searching = false;
            p.SetReplaced(false);
            m_SyncReplacementAt.Remove(p);
            if (p.Replacement != null)
            {
                var r = p.Replacement;
                // Lamps and plants on the replacement go back onto the real table (or down, if it has no top).
                var carried = Stacking.Carried(r);
                foreach (var c in carried) Stacking.LiftOff(c);
                p.Replacement = null;
                m_Swapping = true;
                FurnitureManager.Instance?.Remove(r);
                m_Swapping = false;
                Stacking.MoveOnto(carried, Stacking.TopOf(p));
            }
            PushItemsOutOf(p.Footprint);
        }

        /// <summary>
        /// "Design my room" replaced this piece with <paramref name="productId"/>, standing at the planned spot (its
        /// replacement pose, or slid a little along the wall to clear a neighbour or a doorway). Applied directly, so it
        /// lands even if a change of the user's is still syncing.
        /// </summary>
        public void StandIn(string pieceId, string productId, Vector3 position, float yawDeg)
        {
            var p = Find(pieceId);
            if (p == null || Session?.GetProduct(productId) == null) return;
            p.Searching = false;
            p.Message = null;
            p.PendingUntil = Time.time + 2f; // the server already has it; don't let an older poll undo it
            if (!p.CandidateIds.Contains(productId)) p.CandidateIds.Insert(0, productId);
            if (!p.IsReplaced) p.SetReplaced(true);
            if (p.Replacement == null || p.Replacement.Product.id != productId) ShowCandidate(p, p.CandidateIds.IndexOf(productId));
            var item = p.Replacement;
            if (item == null) return;
            var rot = Quaternion.Euler(0, yawDeg, 0);
            if ((item.transform.position - position).sqrMagnitude > 0.0009f || Quaternion.Angle(item.transform.rotation, rot) > 3f)
            {
                item.UserMoved = true; // stays where the design put it, even once its model's true size is known
                FurnitureManager.Instance.GlideTo(item, position, rot);
            }
            p.RefreshTag();
        }

        /// <summary>"Design my room" replaced this piece with one standing elsewhere: painted out, nothing in its spot.</summary>
        public void PaintOut(string pieceId)
        {
            var p = Find(pieceId);
            if (p == null) return;
            p.Searching = false;
            p.PendingUntil = Time.time + 2f;
            if (!p.IsReplaced)
            {
                p.SetReplaced(true);
                Stacking.MoveOnto(Stacking.Carried(p), null); // nothing to stand on any more
            }
            p.Message = $"Replaced by the new design. Keep brings your {p.Name} back.";
            p.RefreshTag();
        }

        /// <summary>"Clear room": every real piece comes back.</summary>
        public void KeepAll()
        {
            foreach (var p in Pieces.Where(p => p != null && p.IsReplaced).ToList()) Keep(p);
        }

        public void Cycle(RealPiece p, int dir)
        {
            if (p == null || p.Searching) return;
            if (p.CandidateIds.Count == 0) { Replace(p); return; }
            // "Design my room" stood a single pick here: fetch the other size-matched options the first time.
            if (p.CandidateIds.Count == 1 && p.Replacement != null) { _ = LoadMoreCandidates(p, dir); return; }
            if (!p.IsReplaced) p.SetReplaced(true);
            ShowCandidate(p, p.CandidateIndex + (p.Replacement == null ? 0 : dir));
            m_SyncReplacementAt[p] = Time.time + 0.8f; // tell the server once the user settles on one
            XRInput.Instance?.Haptic(Hand.Right, 0.2f, 0.03f);
        }

        async Task LoadMoreCandidates(RealPiece p, int dir)
        {
            var current = p.Replacement != null ? p.Replacement.Product.id : null;
            p.Searching = true;
            p.RefreshTag();
            try
            {
                var res = await Api.ReplacementCandidates(Session.id, p.Id, p.Category);
                if (p == null) return;
                StoreCandidates(p, res?.products);
                if (current != null) { p.CandidateIds.Remove(current); p.CandidateIds.Insert(0, current); }
            }
            catch (Exception e) { Debug.LogWarning($"[VRShop] candidates for {p?.Id}: {e.Message}"); }
            finally { if (p != null) p.Searching = false; }
            if (p == null) return;
            if (p.CandidateIds.Count > 1) Cycle(p, dir);
            else p.RefreshTag();
        }

        public async void NextCategory(RealPiece p)
        {
            if (p == null || p.Choices == null || p.Choices.Count == 0 || p.Searching) return;
            var i = string.IsNullOrEmpty(p.Category) ? -1 : p.Choices.IndexOf(p.Category);
            p.Category = p.Choices[(i + 1) % p.Choices.Count];
            p.Message = null;
            p.CandidateIds.Clear();
            p.RefreshTag();
            await Push(p, new { category = p.Category });
            if (p.IsReplaced)
            {
                // Show the new kind right away.
                p.SetReplaced(false);
                Replace(p);
            }
        }

        void StoreCandidates(RealPiece p, List<Product> products)
        {
            p.CandidateIds.Clear();
            p.CandidateIndex = 0;
            if (products == null) return;
            foreach (var prod in products)
            {
                if (prod?.id == null) continue;
                VRShopApp.Instance?.UpdateProduct(prod);
                p.CandidateIds.Add(prod.id);
            }
        }

        /// <summary>Stand candidate <paramref name="index"/> in the piece's spot (or where the user moved the previous one).</summary>
        void ShowCandidate(RealPiece p, int index)
        {
            var n = p.CandidateIds.Count;
            if (n == 0 || Session == null) return;
            index = ((index % n) + n) % n;
            var product = Session.GetProduct(p.CandidateIds[index]);
            if (product == null) return;
            p.CandidateIndex = index;
            Vector3? at = null;
            float? yaw = null;
            var moved = false;
            var old = p.Replacement;
            // Lamps and plants on the real table (or on the previous replacement) move onto the new one.
            var carried = old != null ? Stacking.Carried(old) : Stacking.Carried(p);
            foreach (var c in carried) Stacking.LiftOff(c);
            if (old != null)
            {
                if (old.UserMoved) { at = old.transform.position; yaw = old.transform.eulerAngles.y; moved = true; }
                p.Replacement = null;
                m_Swapping = true;
                FurnitureManager.Instance.Remove(old);
                m_Swapping = false;
            }
            p.Replacement = Spawn(p, product, at, yaw, moved);
            if (carried.Count > 0) Stacking.MoveOnto(carried, Stacking.TopOf(p.Replacement));
            p.RefreshTag();
        }

        FurnitureItem Spawn(RealPiece p, Product product, Vector3? at, float? yaw, bool userMoved)
        {
            var room = RoomService.Instance;
            var (w, d) = Footprint(product, p);
            var pose = ReplacementPose.For(p.Center, p.Size, p.Yaw, w, d, room.Walls, room.FloorY, room.Centroid());
            var item = FurnitureManager.Instance.Place(product, at ?? pose.position, yaw ?? pose.yawDeg, false);
            item.ReplacesPieceId = p.Id;
            item.UserMoved = userMoved;
            item.ModelReady += OnReplacementModelReady;
            item.PlayRise();
            // A replaced lamp that stood on a table stands on that table (and moves with it).
            if (item.transform.position.y > room.FloorY + 0.05f) Stacking.Settle(item);
            Fit(item);
            return item;
        }

        static (float w, float d) Footprint(Product product, RealPiece p) =>
            product.dims != null && product.dims.w > 0.05f && product.dims.d > 0.02f
                ? (product.dims.w, product.dims.d)
                : (Mathf.Max(p.Size.x, p.Size.z), Mathf.Min(p.Size.x, p.Size.z));

        void OnReplacementModelReady(FurnitureItem item)
        {
            var p = PieceOf(item);
            if (p == null || p.Replacement != item) return;
            if (!item.UserMoved && item.Dims != null)
            {
                // The model's measured size can differ from the listing: re-seat it in the piece's spot.
                var room = RoomService.Instance;
                var pose = ReplacementPose.For(p.Center, p.Size, p.Yaw, item.Dims.w, item.Dims.d, room.Walls, room.FloorY, room.Centroid());
                item.transform.SetPositionAndRotation(pose.position, Quaternion.Euler(0, pose.yawDeg, 0));
            }
            Fit(item);
            p.RefreshTag();
        }

        /// <summary>
        /// Settle a replacement: nudge it off kept furniture and walls if it's only slightly in (bigger overlaps are shown
        /// as "doesn't fit"), and slide our own virtual furniture out of its way — real furniture never moves.
        /// </summary>
        void Fit(FurnitureItem item)
        {
            if (item == null || item.Dims == null || item.IsWallMounted) return;
            var shape = Obb.Of(item.transform, item.Dims.w, item.Dims.d);
            if (!item.IsFloorLayer && !item.IsResting)
            {
                var pos = item.transform.position;
                var resolved = FootprintSolver.Resolve(pos, shape, Solids(item.Dims.h), Walls);
                if ((resolved - pos).magnitude <= 0.2f) item.transform.position = resolved;
                PushItemsOutOf(Obb.Of(item.transform, item.Dims.w, item.Dims.d), item);
            }
            ManipulationController.Instance?.CheckFit(item);
            FurnitureManager.Instance?.ScheduleSync();
        }

        /// <summary>Called by FurnitureManager when an item is deleted.</summary>
        public void OnItemRemoved(FurnitureItem item)
        {
            if (m_Swapping || item == null) return;
            var p = PieceOf(item);
            if (p == null || p.Replacement != item) return;
            p.Replacement = null;
            p.Message = $"Your {p.Name} stays painted out. Try another with ‹ ›, or Keep to bring it back.";
            p.RefreshTag();
            _ = Push(p, new { state = "replace", clearReplacement = true });
        }

        public void AddReplacementToBag(RealPiece p)
        {
            var product = p?.Replacement != null ? p.Replacement.Product : null;
            if (product == null || Session == null) return;
            _ = AddToBag(product);
        }

        async Task AddToBag(Product product)
        {
            try
            {
                var s = await Api.SetCart(Session.id, product.id, 1);
                VRShopApp.Instance.SetSession(s);
                Toast.Show($"Added {product.title} to your bag");
                foreach (var p in Pieces) p?.RefreshTag();
            }
            catch (Exception e) { Toast.Show($"Couldn't add it: {e.Message}"); }
        }

        /// <summary>The assistant replaced a piece ("replace my couch with a green velvet sofa").</summary>
        public void ApplyVoiceReplace(ReplaceResult r)
        {
            var p = Find(r?.pieceId);
            if (p == null) return;
            if (r.products != null) foreach (var prod in r.products) if (prod?.id != null) VRShopApp.Instance?.UpdateProduct(prod);
            var ids = (r.productIds ?? new List<string>()).Where(id => Session?.GetProduct(id) != null).ToList();
            if (ids.Count == 0) return;
            if (!string.IsNullOrEmpty(r.category)) p.Category = r.category;
            p.CandidateIds.Clear();
            p.CandidateIds.AddRange(ids);
            p.PendingUntil = Time.time + 4f; // the server already has this state
            p.Searching = false;
            p.Message = null;
            p.SetReplaced(true);
            ShowCandidate(p, 0);
            Select(p);
        }

        // ================================================================== adjust the box

        public void BeginAdjust(RealPiece p)
        {
            if (p == null) return;
            Select(p);
            p.BeginAdjust();
        }

        public void EndAdjust(RealPiece p, bool save)
        {
            if (p == null || !p.Adjusting) return;
            p.EndAdjust();
            if (!save) return;
            if (p.Adjusted)
            {
                m_Overrides[p.Id] = new BoxOverride { cx = p.Center.x, cy = p.Center.y, cz = p.Center.z, sx = p.Size.x, sy = p.Size.y, sz = p.Size.z, yaw = p.Yaw };
                SaveOverrides();
            }
            AfterBoxChange(p);
        }

        public void ResetBox(RealPiece p)
        {
            if (p == null) return;
            m_Overrides.Remove(p.Id);
            SaveOverrides();
            p.SetBox(p.Scanned.center, p.Scanned.size, p.Scanned.yawDeg, false);
            p.RefreshTag();
        }

        void AfterBoxChange(RealPiece p)
        {
            _ = VRShopApp.Instance?.ResendGeometry();
            if (p.IsReplaced && p.Replacement != null && !p.Replacement.UserMoved)
            {
                var room = RoomService.Instance;
                var item = p.Replacement;
                var pose = ReplacementPose.For(p.Center, p.Size, p.Yaw, item.Dims.w, item.Dims.d, room.Walls, room.FloorY, room.Centroid());
                item.transform.SetPositionAndRotation(pose.position, Quaternion.Euler(0, pose.yawDeg, 0));
                Fit(item);
            }
            else if (!p.IsReplaced)
            {
                PushItemsOutOf(p.Footprint);
                Stacking.Reseat(p); // lamps on it follow its new top
            }
        }

        void LoadOverrides()
        {
            try
            {
                if (File.Exists(OverridesPath))
                    m_Overrides = JsonConvert.DeserializeObject<Dictionary<string, BoxOverride>>(File.ReadAllText(OverridesPath)) ?? new Dictionary<string, BoxOverride>();
            }
            catch (Exception e) { Debug.LogWarning($"[VRShop] real_furniture.json: {e.Message}"); }
        }

        void SaveOverrides()
        {
            try { File.WriteAllText(OverridesPath, JsonConvert.SerializeObject(m_Overrides)); }
            catch (Exception e) { Debug.LogWarning($"[VRShop] saving box adjustments: {e.Message}"); }
        }

        // ================================================================== cover tones

        public void NudgeTone(bool floor, float delta)
        {
            if (floor) FloorTone = Mathf.Clamp(FloorTone + delta, 0.04f, 0.96f);
            else WallTone = Mathf.Clamp(WallTone + delta, 0.04f, 0.96f);
            PlayerPrefs.SetFloat(FloorKey, FloorTone);
            PlayerPrefs.SetFloat(WallKey, WallTone);
            PlayerPrefs.Save();
            foreach (var p in Pieces) if (p != null) p.UpdateCoverColors();
        }

        /// <summary>What the painted-out floor / wall looks like: a gray matched by the user (Quest 2), or the room's color.</summary>
        public Color ToneColor(bool floor)
        {
            var t = floor ? FloorTone : WallTone;
            if (!ColorPassthrough) return new Color(t, t, t, 1);
            var room = Session?.room;
            var c = VRShopMaterials.Hex(floor ? room?.floor?.colorHex : room?.walls?.colorHex, floor ? new Color(0.55f, 0.45f, 0.36f) : new Color(0.9f, 0.89f, 0.86f));
            var k = t / (floor ? 0.4f : 0.62f);
            return new Color(Mathf.Clamp01(c.r * k), Mathf.Clamp01(c.g * k), Mathf.Clamp01(c.b * k), 1);
        }

        static bool DetectColorPassthrough()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            try
            {
                var t = OVRPlugin.GetSystemHeadsetType().ToString();
                return !(t.Contains("Quest_2") || t == "Oculus_Quest" || t.StartsWith("Oculus_Quest"));
            }
            catch { return false; }
#else
            return false;
#endif
        }

        // ================================================================== server sync

        async Task Push(RealPiece p, object patch)
        {
            var s = Session;
            if (s == null || p == null || Api == null) return;
            p.PendingUntil = Time.time + 8f;
            for (var attempt = 0; attempt < 2; attempt++)
            {
                try
                {
                    var res = await Api.SetRealPiece(s.id, p.Id, patch);
                    if (p != null) p.PendingUntil = Time.time + 1.5f;
                    if (res != null && VRShopApp.Instance?.Session?.id == res.id) VRShopApp.Instance.SetSession(res);
                    return;
                }
                catch (ApiException e) when (e.Status == 404 && attempt == 0)
                {
                    // The server hasn't seen this room yet: upload it, then retry.
                    await VRShopApp.Instance.ResendGeometry();
                }
                catch (Exception e)
                {
                    Debug.LogWarning($"[VRShop] real piece {p?.Id}: {e.Message}");
                    return;
                }
            }
        }

        /// <summary>Apply decisions made elsewhere (voice, the phone, a restart) unless we have our own change in flight.</summary>
        void OnSession(Session s)
        {
            if (s?.realFurniture == null) return;
            foreach (var p in Pieces)
            {
                if (p == null || !s.realFurniture.TryGetValue(p.Id, out var dto)) continue;
                if (dto.choices != null && dto.choices.Count > 0) p.Choices = dto.choices;
                if (Time.time < p.PendingUntil || p.Searching) continue;
                if (!string.IsNullOrEmpty(dto.category)) p.Category = dto.category;
                var want = dto.state == "replace";
                if (!want && p.IsReplaced) Restore(p);
                else if (want)
                {
                    var current = p.Replacement != null ? p.Replacement.Product.id : null;
                    if (!string.IsNullOrEmpty(dto.replacementId) && dto.replacementId != current && s.GetProduct(dto.replacementId) != null)
                    {
                        if (!p.CandidateIds.Contains(dto.replacementId)) p.CandidateIds.Insert(0, dto.replacementId);
                        p.SetReplaced(true);
                        ShowCandidate(p, p.CandidateIds.IndexOf(dto.replacementId));
                    }
                    else if (!p.IsReplaced)
                    {
                        p.SetReplaced(true);
                        Stacking.MoveOnto(Stacking.Carried(p), null); // nothing to stand on any more
                    }
                }
                p.RefreshTag();
            }
        }

        // ================================================================== thumbstick

        void Update()
        {
            // Tell the server which candidate the user settled on.
            if (m_SyncReplacementAt.Count > 0)
            {
                foreach (var kv in m_SyncReplacementAt.Where(kv => Time.time >= kv.Value).ToList())
                {
                    m_SyncReplacementAt.Remove(kv.Key);
                    var p = kv.Key;
                    if (p != null && p.IsReplaced && p.Replacement != null) _ = Push(p, new { state = "replace", replacementId = p.Replacement.Product.id });
                }
            }

            var input = XRInput.Instance;
            if (input == null) return;
            var right = input.Stick(Hand.Right);
            var stick = right.sqrMagnitude > 0.04f ? right : input.Stick(Hand.Left);

            // Adjusting: the stick turns the box.
            if (Selected != null && Selected.Adjusting)
            {
                if (Mathf.Abs(stick.x) > 0.2f) Selected.SetBox(Selected.Center, Selected.Size, Selected.Yaw + stick.x * 60f * Time.deltaTime, true);
                return;
            }

            // Replaced piece selected (or its replacement): up/down tries the next / previous candidate.
            var target = Selected != null && Selected.IsReplaced ? Selected : PieceOf(ManipulationController.Instance != null ? ManipulationController.Instance.Selected : null);
            if (target == null || Mathf.Abs(stick.y) < 0.3f) { m_StickDir = 0; return; }
            if (Mathf.Abs(stick.y) < 0.7f || Mathf.Abs(stick.x) > Mathf.Abs(stick.y)) return;
            var dir = stick.y > 0 ? 1 : -1;
            if (dir == m_StickDir && Time.time < m_NextCycle) return;
            m_NextCycle = Time.time + (dir == m_StickDir ? 0.45f : 0.6f);
            m_StickDir = dir;
            Cycle(target, dir);
        }
    }
}
