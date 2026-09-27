using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using UnityEngine;
using VRShop.Api;
using VRShop.Core;
using VRShop.Input;
using VRShop.Interaction;
using VRShop.Room;
using VRShop.UI;

namespace VRShop.Furniture
{
    /// <summary>
    /// Spawns products into the room, drives model preparation on the backend (IKEA official GLB, AI
    /// generation or stand-in), loads the GLB, applies AI layouts, and syncs placements back to the server.
    /// </summary>
    public class FurnitureManager : MonoBehaviour
    {
        public static FurnitureManager Instance { get; private set; }
        public readonly List<FurnitureItem> Items = new List<FurnitureItem>();
        public event Action Changed;

        /// <summary>Set by voice ("put a lamp here"): the next Place() goes to this floor point.</summary>
        public Vector3? PendingPoint { get; set; }

        float m_SyncAt = -1;
        ApiClient Api => VRShopApp.Instance.Api;

        void Awake() => Instance = this;

        void Update()
        {
            if (Time.frameCount % 6 == 0) UpdateFloorLayering();
            if (m_SyncAt > 0 && Time.time > m_SyncAt)
            {
                m_SyncAt = -1;
                SyncPlacements();
            }
        }

        /// <summary>
        /// Rugs sit under everything. Depth already draws items over a rug, but their contact shadows live a few mm
        /// above the floor, i.e. inside a ~1.5 cm rug, so lift each shadow onto the top of any rug it overlaps.
        /// </summary>
        void UpdateFloorLayering()
        {
            foreach (var item in Items)
            {
                if (item == null || item.IsWallMounted || item.IsFloorLayer || item.Dims == null) continue;
                var box = Obb.Of(item.transform, item.Dims.w, item.Dims.d);
                var top = 0f;
                foreach (var rug in Items)
                {
                    if (rug == null || !rug.IsFloorLayer || rug.Dims == null) continue;
                    if (Obb.Of(rug.transform, rug.Dims.w, rug.Dims.d).Overlaps(box, 0))
                        top = Mathf.Max(top, Mathf.Min(rug.Dims.h, 0.05f) + rug.transform.position.y - item.transform.position.y);
                }
                item.SetContactHeight(Mathf.Max(0, top));
            }
        }

        public FurnitureItem Place(Product p, Vector3? position = null, float? yawDeg = null, bool select = true)
        {
            var room = RoomService.Instance;
            var head = XRInput.Instance.Head;
            var isWall = p.category == "wall_art" || p.category == "mirror";
            var pos = position ?? PendingPoint ?? SpawnPoint(isWall, p);
            PendingPoint = null;
            var toUser = head.position - pos; toUser.y = 0;
            var yaw = yawDeg ?? (toUser.sqrMagnitude > 0.01f ? Quaternion.LookRotation(toUser).eulerAngles.y : 0f);
            var floorY = room != null ? room.FloorY : 0f;
            var onTop = !isWall && pos.y > floorY + 0.05f; // "put a lamp here" at a tabletop
            // A new piece never starts inside the user's real furniture (or another piece): nearest free spot instead.
            // Explicit positions (layouts, replacements) are already solved.
            if (!position.HasValue && !onTop && !isWall && p.category != "rug" && RealFurniture.Instance != null)
            {
                var d = p.dims ?? new Dims { w = 0.6f, d = 0.6f, h = 0.6f };
                pos = RealFurniture.Instance.FreeSpot(pos, d.w, d.d, yaw, null, true, d.h);
            }
            if (isWall && !position.HasValue && room != null)
            {
                var w = room.NearestWall(pos, out _);
                if (w != null) yaw = Quaternion.LookRotation(w.normal).eulerAngles.y;
            }

            var go = new GameObject();
            go.transform.SetPositionAndRotation(pos, Quaternion.Euler(0, yaw, 0));
            var item = go.AddComponent<FurnitureItem>();
            item.Init(p);
            Items.Add(item);
            if (onTop && !position.HasValue) Stacking.Settle(item); // onto the top it was aimed at, or down to the floor
            if (select) ManipulationController.Instance?.Select(item);
            _ = LoadModel(item);
            Changed?.Invoke();
            ScheduleSync();
            return item;
        }

        Vector3 SpawnPoint(bool isWall, Product p)
        {
            var room = RoomService.Instance;
            var head = XRInput.Instance.Head;
            var floorY = room != null ? room.FloorY : 0f;
            var fwd = Vector3.ProjectOnPlane(head.forward, Vector3.up).normalized;
            if (fwd.sqrMagnitude < 0.01f) fwd = Vector3.forward;

            if (isWall && room != null)
            {
                // Onto the wall the user is facing, art centered at 1.45 m.
                if (Physics.Raycast(head.position, fwd, out var hit, 8f, ~0, QueryTriggerInteraction.Ignore) && hit.collider.TryGetComponent<RoomSurface>(out var s) && s.kind == SurfaceKind.Wall)
                {
                    var h = p.dims?.h ?? 0.6f;
                    var d = p.dims?.d ?? 0.03f;
                    return new Vector3(hit.point.x, floorY + Mathf.Max(0.1f, 1.45f - h / 2), hit.point.z) + hit.normal * (d / 2 + 0.01f);
                }
            }
            // Lamps and small plants: onto the tabletop the user just pointed at.
            var lasers = FindObjectsByType<LaserPointer>(FindObjectsSortMode.None);
            if (StackRules.IsStackable(p.category, p.dims))
            {
                var topPointer = lasers.Where(l => l.LastTopPoint.HasValue && Time.time - l.LastTopPointTime < 1.5f && (!l.LastFloorPoint.HasValue || l.LastTopPointTime > l.LastFloorPointTime))
                    .OrderByDescending(l => l.LastTopPointTime).FirstOrDefault();
                if (topPointer != null) return topPointer.LastTopPoint.Value;
            }
            // Recently pointed floor spot, else ~1.6 m in front of the user.
            var pointer = lasers.Where(l => l.LastFloorPoint.HasValue && Time.time - l.LastFloorPointTime < 1.5f).OrderByDescending(l => l.LastFloorPointTime).FirstOrDefault();
            var depth = p.dims?.d ?? 0.6f;
            var pos = pointer != null ? pointer.LastFloorPoint.Value : head.position + fwd * (1.2f + depth / 2);
            pos.y = floorY;
            if (room != null && room.Outline.Count >= 3 && !room.Contains(pos))
            {
                // Pull it back inside the room outline.
                var c = room.Centroid();
                for (var i = 0; i < 20 && !room.Contains(pos); i++) pos = Vector3.Lerp(pos, new Vector3(c.x, floorY, c.z), 0.15f);
            }
            return pos;
        }

        async Task LoadModel(FurnitureItem item)
        {
            var p = item.Product;
            var id = p.id;
            try
            {
                // Not ready yet, or only a stand-in: ask the backend for the best model (IKEA official or AI-generated).
                if (!p.model.IsReady || p.model.kind == "standin")
                {
                    item.SetStatus("Preparing 3D model…");
                    p = await Api.EnsureModel(id, true) ?? item.Product;
                    var started = Time.realtimeSinceStartup;
                    while (item != null && p.model.status != "ready" && p.model.status != "failed" && Time.realtimeSinceStartup - started < 600)
                    {
                        item.SetStatus($"{p.model.message ?? "Preparing 3D"}  {Mathf.RoundToInt(p.model.progress * 100)}%");
                        await Task.Delay(1500);
                        if (item == null) return;
                        p = await Api.GetProduct(id) ?? p;
                    }
                    if (item == null) return;
                    VRShopApp.Instance.UpdateProduct(p);
                }
                if (!p.model.IsReady)
                {
                    item.SetStatus("3D model unavailable — showing true-size box");
                    return;
                }
                item.SetStatus("Loading 3D model…");
                var model = await ModelLoader.Instantiate(Api.Abs(p.model.url), item.transform);
                if (item == null) { if (model != null) Destroy(model); return; }
                if (model == null) { item.SetStatus("Couldn't load the 3D model"); return; }
                StartCoroutine(item.SwapInModel(model));
                ManipulationController.Instance?.CheckFit(item);
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[VRShop] model for {id}: {e.Message}");
                if (item != null) item.SetStatus("3D model error — showing true-size box");
            }
        }

        public void Remove(FurnitureItem item)
        {
            if (item == null) return;
            // Whatever stood on it drops to the floor nearby instead of disappearing with it.
            foreach (var carried in Stacking.Carried(item)) Stacking.DropToFloor(carried);
            RealFurniture.Instance?.OnItemRemoved(item);
            Items.Remove(item);
            if (ManipulationController.Instance != null && ManipulationController.Instance.Selected == item) ManipulationController.Instance.Select(null);
            Destroy(item.gameObject);
            Changed?.Invoke();
            ScheduleSync();
        }

        public void ClearAll()
        {
            RealFurniture.Instance?.KeepAll(); // the real furniture comes back too
            foreach (var i in Items.ToList()) if (i != null) Destroy(i.gameObject);
            Items.Clear();
            ManipulationController.Instance?.Select(null);
            Changed?.Invoke();
            ScheduleSync();
        }

        /// <summary>Everything standing in the room, for "Design my room" to replace or work around.</summary>
        public List<PlacedPieceDto> CurrentPieces() => Items.Where(i => i != null).Select(i => new PlacedPieceDto
        {
            instanceId = i.InstanceId,
            productId = i.Product.id,
            category = i.Product.category,
            position = new Vec3(i.transform.position),
            yawDeg = i.transform.eulerAngles.y,
            dims = i.Dims,
            replacesPieceId = i.ReplacesPieceId,
        }).ToList();

        /// <summary>
        /// "Design my room": pieces the design supersedes leave, the rest glide into the solver's placements. New pieces
        /// that stand in for the user's real furniture arrive through RealFurniture: the session now marks those pieces
        /// "replace" with the design's pick, and its sync paints them out and stands the pick in their spot.
        /// </summary>
        public void ApplyDesign(DesignResponse design, Session session)
        {
            var gone = new HashSet<string>(design.remove ?? new List<string>());
            foreach (var item in Items.Where(x => x != null && gone.Contains(x.InstanceId)).ToList()) Remove(item);
            var real = RealFurniture.Instance;
            if (real != null)
            {
                foreach (var pl in design.placements.Where(p => !string.IsNullOrEmpty(p.replacesPieceId)))
                    real.StandIn(pl.replacesPieceId, pl.productId, pl.position.ToVector3(), pl.yawDeg);
                foreach (var id in design.replacedPieces ?? new List<string>())
                    if (!design.placements.Any(p => p.replacesPieceId == id)) real.PaintOut(id);
            }
            ApplyLayout(design.placements.Where(p => string.IsNullOrEmpty(p.replacesPieceId)).ToList(), session, false);
        }

        /// <summary>"Design my room": move existing items / spawn new ones into the solver's placements, animated.
        /// A placement naming an instance moves that piece; otherwise one of the same product is reused (a replacement
        /// standing in for a real piece only when <paramref name="matchReplacements"/>).</summary>
        public void ApplyLayout(List<Placement> placements, Session session, bool matchReplacements = true)
        {
            var used = new HashSet<FurnitureItem>();
            var i = 0;
            bool Candidate(FurnitureItem x) => x != null && (matchReplacements || string.IsNullOrEmpty(x.ReplacesPieceId));
            // Things moving between tops travel on their own; they re-settle on whatever top they land on at the end.
            foreach (var it in Items) if (Candidate(it) && placements.Any(pl => pl.instanceId == it.InstanceId || pl.productId == it.Product.id)) Stacking.LiftOff(it);
            foreach (var pl in placements)
            {
                var target = pl.position.ToVector3();
                var rot = Quaternion.Euler(0, pl.yawDeg, 0);
                var item = (string.IsNullOrEmpty(pl.instanceId) ? null : Items.FirstOrDefault(x => x != null && !used.Contains(x) && x.InstanceId == pl.instanceId))
                           ?? Items.FirstOrDefault(x => Candidate(x) && !used.Contains(x) && x.Product.id == pl.productId);
                if (item == null)
                {
                    var p = session.GetProduct(pl.productId);
                    if (p == null) continue;
                    // Spawn at the user's feet-ish and fly into place.
                    var head = XRInput.Instance.Head;
                    var start = new Vector3(head.position.x, RoomService.Instance != null ? RoomService.Instance.FloorY : 0, head.position.z) + Vector3.ProjectOnPlane(head.forward, Vector3.up).normalized * 0.8f;
                    item = Place(p, start, pl.yawDeg, false);
                }
                used.Add(item);
                // Pieces already where they belong (a replacement pinned in its real piece's spot) stay still.
                if ((item.transform.position - target).sqrMagnitude < 0.0004f && Quaternion.Angle(item.transform.rotation, rot) < 2f) continue;
                StartCoroutine(Glide(item, target, rot, 0.35f + i * 0.18f));
                i++;
            }
            StartCoroutine(SettleAfter(0.35f + i * 0.18f + 1.0f));
            ScheduleSync();
        }

        /// <summary>
        /// Once everything has landed, lamps and plants placed on tables stand on them (and move with them), and every
        /// piece is fit-checked again: each was checked when its own glide ended, while others were still in the air.
        /// </summary>
        IEnumerator SettleAfter(float seconds)
        {
            yield return new WaitForSeconds(seconds);
            var floorY = RoomService.Instance != null ? RoomService.Instance.FloorY : 0f;
            foreach (var it in Items.ToList())
                if (it != null && !it.IsWallMounted && it.transform.position.y > floorY + 0.05f) Stacking.Settle(it);
            foreach (var it in Items.ToList()) if (it != null) ManipulationController.Instance?.CheckFit(it);
        }

        /// <summary>Slide an item to a new spot (making room for something), keeping its rotation unless given one.</summary>
        public void GlideTo(FurnitureItem item, Vector3 target, Quaternion? rotation = null)
        {
            if (item == null) return;
            StartCoroutine(Glide(item, target, rotation ?? item.transform.rotation, 0f));
            ScheduleSync();
        }

        IEnumerator Glide(FurnitureItem item, Vector3 target, Quaternion rot, float delay)
        {
            yield return new WaitForSeconds(delay);
            if (item == null) yield break;
            var from = item.transform.position;
            var fromRot = item.transform.rotation;
            var t = 0f;
            while (t < 1f && item != null)
            {
                t += Time.deltaTime / 0.9f;
                var e = Mathf.SmoothStep(0, 1, t);
                var pos = Vector3.Lerp(from, target, e);
                pos.y += Mathf.Sin(e * Mathf.PI) * 0.25f; // small hop
                item.transform.SetPositionAndRotation(pos, Quaternion.Slerp(fromRot, rot, e));
                yield return null;
            }
            if (item == null) yield break;
            item.transform.SetPositionAndRotation(target, rot);
            ManipulationController.Instance?.CheckFit(item);
        }

        public List<Placement> CurrentPlacements() => Items.Where(i => i != null).Select(i => new Placement
        {
            productId = i.Product.id,
            position = new Vec3(i.transform.position),
            yawDeg = i.transform.eulerAngles.y,
        }).ToList();

        public void ScheduleSync() => m_SyncAt = Time.time + 1.5f;

        async void SyncPlacements()
        {
            var app = VRShopApp.Instance;
            if (app == null || app.Session == null) return;
            try { await Api.PutPlacements(app.Session.id, CurrentPlacements()); }
            catch (Exception e) { Debug.LogWarning($"[VRShop] placement sync: {e.Message}"); }
        }
    }
}
