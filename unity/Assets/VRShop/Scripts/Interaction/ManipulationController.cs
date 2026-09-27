using System.Linq;
using UnityEngine;
using System.Collections.Generic;
using VRShop.Furniture;
using VRShop.Input;
using VRShop.Room;

namespace VRShop.Interaction
{
    /// <summary>
    /// Select, drag, rotate, wall-snap and delete placed furniture, with a live fit check:
    ///  - trigger (or grip) on an item + move = slide it along the floor (wall art slides along walls). It can pass
    ///    through the user's real furniture while moving (red outline + a small buzz); let go inside it and it glides
    ///    to the nearest free spot. Walls stop it.
    ///  - right thumbstick left/right = rotate the selected item
    ///  - release near a wall = snaps flush with its back to the wall
    ///  - B = delete selected
    /// Fit check flags overlaps with other items and with your real furniture (Space Setup boxes),
    /// items outside the room outline, items blocking a door, and pieces too big for your doorway.
    /// </summary>
    public class ManipulationController : MonoBehaviour
    {
        public static ManipulationController Instance { get; private set; }

        public FurnitureItem Selected { get; private set; }
        public bool IsDragging { get; private set; }

        FurnitureItem m_Drag;
        Hand m_Hand;
        Vector3 m_Offset;
        Vector3 m_Target;
        float m_PressTime;
        float m_NextFit;
        bool m_Blocked;
        bool m_InReal;        // currently overlapping a real piece (for the entry buzz)
        bool m_Turning;       // the stick is turning the selected item
        bool m_Stackable;     // a table lamp / small plant: can go on tops
        Top? m_OnTop;         // the top it's being dragged across, if any

        void Awake() => Instance = this;

        void OnEnable() => LaserPointer.FloorClicked += OnFloorClicked;
        void OnDisable() => LaserPointer.FloorClicked -= OnFloorClicked;

        void OnFloorClicked(LaserPointer p, RaycastHit hit)
        {
            if (!IsDragging) Select(null);
        }

        public void Select(FurnitureItem item)
        {
            if (Selected == item) return;
            if (Selected != null) Selected.SetSelected(false);
            Selected = item;
            if (Selected != null) { Selected.SetSelected(true); CheckFit(Selected); }
            // A replacement's card is its real piece's card; anything else closes a real piece's card.
            if (item != null) RealFurniture.Instance?.Select(RealFurniture.Instance.PieceOf(item));
        }

        public void BeginDrag(FurnitureItem item, PointerEvent e)
        {
            Select(item);
            m_Drag = item;
            m_Hand = e.hand;
            m_PressTime = Time.time;
            IsDragging = false;
            var fp = FloorPoint(e.ray);
            m_Offset = fp.HasValue ? item.transform.position - fp.Value : Vector3.zero;
            m_Offset.y = 0;
            m_Target = item.transform.position;
            // Lamps and small plants follow the pointer exactly (so they can hop onto the top you point at).
            m_Stackable = StackRules.IsStackable(item.Product.category, item.Dims);
            if (m_Stackable) m_Offset = Vector3.zero;
            m_OnTop = null;
        }

        public void EndDrag(FurnitureItem item, PointerEvent e, bool clicked)
        {
            if (item == null) { m_Drag = null; IsDragging = false; return; }
            if (m_Drag != item) return;
            if (IsDragging && !item.IsWallMounted)
            {
                var p = item.transform.position;
                if (m_OnTop.HasValue && Stacking.RestOn(item, m_OnTop.Value, new Vector2(p.x, p.z))) { /* stays on the top, moves with it */ }
                else
                {
                    if (m_Stackable) item.transform.position = new Vector3(p.x, RoomService.Instance != null ? RoomService.Instance.FloorY : p.y, p.z);
                    SnapToWall(item);
                    SlideClearOfRealFurniture(item);
                }
                item.SetStatusNote(null);
            }
            if (IsDragging) item.UserMoved = true;
            m_OnTop = null;
            m_Drag = null;
            IsDragging = false;
            CheckFit(item);
            FurnitureManager.Instance?.ScheduleSync();
        }

        void Update()
        {
            var input = XRInput.Instance;
            if (input == null) return;
            if (m_Drag == null) IsDragging = false;

            if (m_Drag != null)
            {
                var ray = input.GetRay(m_Hand);
                if (m_Drag.IsWallMounted) DragOnWall(m_Drag, ray);
                else
                {
                    var target = DragTarget(ray, out var top, out var note);
                    if (target.HasValue)
                    {
                        m_Target = target.Value;
                        if (!IsDragging && (Vector3.Distance(m_Target, m_Drag.transform.position) > 0.03f || Time.time - m_PressTime > 0.25f))
                        {
                            IsDragging = true;
                            Stacking.LiftOff(m_Drag); // off the table it stood on; whatever it carries comes along
                        }
                        if (IsDragging)
                        {
                            m_OnTop = top;
                            var from = m_Drag.transform.position;
                            var next = Vector3.Lerp(from, m_Target, 1 - Mathf.Exp(-Time.deltaTime * 18));
                            // On the floor the walls stop it; real furniture doesn't (red outline, sorted out on release).
                            if (!top.HasValue) next = Walls(m_Drag, from, next);
                            m_Drag.transform.position = next;
                            m_Drag.SetStatusNote(note);
                            BuzzOnEnteringRealFurniture(m_Drag);
                        }
                    }
                }
            }

            if (Selected != null)
            {
                var stick = input.Stick(Hand.Right);
                if (Mathf.Abs(stick.x) < 0.2f) stick = input.Stick(Hand.Left);
                if (Mathf.Abs(stick.x) > 0.2f && Mathf.Abs(stick.x) >= Mathf.Abs(stick.y) && !Selected.IsWallMounted)
                {
                    Selected.transform.Rotate(0, stick.x * 110f * Time.deltaTime, 0, Space.World);
                    Selected.UserMoved = true;
                    m_Turning = true;
                    if (Selected.IsResting) Stacking.Settle(Selected); // stay within the top's edges
                    FurnitureManager.Instance?.ScheduleSync();
                }
                else if (m_Turning && Mathf.Abs(stick.x) < 0.15f)
                {
                    // Let go of the stick: if the turn swung it into real furniture, it slides clear now.
                    m_Turning = false;
                    if (m_Drag == null) SlideClearOfRealFurniture(Selected);
                }
                if (input.Down(Btn.B))
                {
                    FurnitureManager.Instance.Remove(Selected);
                    return;
                }
                if (Time.time > m_NextFit)
                {
                    m_NextFit = Time.time + 0.12f;
                    CheckFit(Selected);
                }
            }
        }

        /// <summary>
        /// Where the dragged item should go: onto the top the pointer is on (lamps, small plants), kept inside its edges,
        /// or the floor point under the pointer. <paramref name="note"/> explains a top it can't go on.
        /// </summary>
        Vector3? DragTarget(Ray ray, out Top? top, out string note)
        {
            top = null;
            note = null;
            if (m_Stackable)
            {
                var t = Stacking.UnderRay(ray, m_Drag, out _, out var refused);
                if (t.HasValue && ray.direction.y < -0.01f)
                {
                    var d = (t.Value.y - ray.origin.y) / ray.direction.y;
                    var hit = ray.GetPoint(Mathf.Max(0, d));
                    var shape = Obb.Of(m_Drag.transform, m_Drag.Dims.w, m_Drag.Dims.d);
                    if (StackRules.TryClampOnto(t.Value.footprint, shape, new Vector2(hit.x, hit.z), out var c))
                    {
                        top = t;
                        return new Vector3(c.x, t.Value.y, c.y);
                    }
                    note = $"Too big for the {t.Value.Name.Replace("your ", "")}";
                }
                else if (refused.item != null || refused.piece != null) note = $"Doesn't go on the {refused.Name.Replace("your ", "")}";
            }
            var fp = FloorPoint(ray);
            return fp.HasValue ? fp.Value + m_Offset : (Vector3?)null;
        }

        /// <summary>The walls stop a dragged item: it slides along them instead of leaving the room.</summary>
        Vector3 Walls(FurnitureItem item, Vector3 from, Vector3 to)
        {
            var rf = RealFurniture.Instance;
            if (rf == null || item.Dims == null || item.IsWallMounted) return to;
            var shape = Obb.Of(item.transform, item.Dims.w, item.Dims.d);
            var p = FootprintSolver.Sweep(from, to, shape, k_NoSolids, rf.Walls);
            var blocked = (p - to).sqrMagnitude > 0.0004f;
            if (blocked && !m_Blocked) XRInput.Instance?.Haptic(m_Hand, 0.25f, 0.03f); // a soft bump at the wall
            m_Blocked = blocked;
            return p;
        }

        static readonly List<Obb> k_NoSolids = new List<Obb>();

        /// <summary>A light buzz as a dragged item starts to overlap real furniture (it's outlined red while it does).</summary>
        void BuzzOnEnteringRealFurniture(FurnitureItem item)
        {
            var rf = RealFurniture.Instance;
            if (rf == null || item.Dims == null || item.IsWallMounted || item.IsFloorLayer) { m_InReal = false; return; }
            var box = Obb.Of(item.transform, item.Dims.w, item.Dims.d);
            var inReal = rf.Solids().Any(s => box.Overlaps(s));
            if (inReal && !m_InReal) XRInput.Instance?.Haptic(m_Hand, 0.18f, 0.025f);
            m_InReal = inReal;
        }

        /// <summary>Let go inside the user's real furniture: glide to the nearest spot that's clear of it.</summary>
        public void SlideClearOfRealFurniture(FurnitureItem item)
        {
            m_InReal = false;
            var rf = RealFurniture.Instance;
            if (rf == null || item == null || item.Dims == null || item.IsWallMounted || item.IsFloorLayer || item.IsResting) return;
            var pos = item.transform.position;
            var yaw = item.transform.eulerAngles.y;
            var box = Obb.Of(item.transform, item.Dims.w, item.Dims.d);
            if (!rf.Solids().Any(s => box.Overlaps(s))) return;
            var spot = rf.FreeSpot(pos, item.Dims.w, item.Dims.d, yaw, item);
            if ((spot - pos).sqrMagnitude < 0.0001f) return;
            FurnitureManager.Instance?.GlideTo(item, spot);
            XRInput.Instance?.Haptic(m_Hand, 0.3f, 0.05f);
        }

        public static Vector3? FloorPoint(Ray r)
        {
            var floorY = RoomService.Instance != null ? RoomService.Instance.FloorY : 0f;
            if (r.direction.y > -0.02f) return null;
            var t = (floorY - r.origin.y) / r.direction.y;
            if (t < 0 || t > 15f) return null;
            return r.GetPoint(t);
        }

        void DragOnWall(FurnitureItem item, Ray ray)
        {
            var hits = Physics.RaycastAll(ray, 12f, ~0, QueryTriggerInteraction.Ignore).OrderBy(h => h.distance);
            foreach (var h in hits)
            {
                if (!h.collider.TryGetComponent<RoomSurface>(out var s) || s.kind != SurfaceKind.Wall) continue;
                IsDragging = true;
                var d = item.Dims?.d ?? 0.03f;
                var hgt = item.Dims?.h ?? 0.6f;
                var floorY = RoomService.Instance != null ? RoomService.Instance.FloorY : 0f;
                var pos = h.point + h.normal * (d / 2 + 0.01f);
                pos.y = Mathf.Max(floorY, h.point.y - hgt / 2);
                item.transform.position = Vector3.Lerp(item.transform.position, pos, 1 - Mathf.Exp(-Time.deltaTime * 18));
                item.transform.rotation = Quaternion.LookRotation(Vector3.ProjectOnPlane(h.normal, Vector3.up).normalized, Vector3.up);
                return;
            }
        }

        /// <summary>If the item's back is close to a wall and roughly facing away from it, make it flush.</summary>
        void SnapToWall(FurnitureItem item)
        {
            var room = RoomService.Instance;
            if (room == null || item.Dims == null) return;
            var fwd = item.transform.forward;
            var back = item.transform.position - fwd * (item.Dims.d / 2);
            var wall = room.NearestWall(back, out var dist);
            if (wall == null || dist > 0.3f) return;
            if (Vector3.Angle(Vector3.ProjectOnPlane(fwd, Vector3.up), wall.normal) > 40f) return;
            var tangent = Vector3.Cross(Vector3.up, wall.normal);
            var rel = item.transform.position - wall.center;
            var along = Vector3.Dot(rel, tangent);
            var pos = wall.center + tangent * along + wall.normal * (item.Dims.d / 2 + 0.01f);
            pos.y = item.transform.position.y;
            item.transform.SetPositionAndRotation(pos, Quaternion.LookRotation(wall.normal, Vector3.up));
            XRInput.Instance?.Haptic(m_Hand, 0.4f, 0.06f);
        }

        // ------------------------------------------------------------------ fit check
        public void CheckFit(FurnitureItem item)
        {
            if (item == null || item.Dims == null) return;
            var room = RoomService.Instance;
            var isRug = item.Product.category == "rug";
            var box = Obb.Of(item.transform, item.Dims.w, item.Dims.d);

            if (item.IsResting)
            {
                // On a top: only its neighbours on the same top can get in the way.
                foreach (var other in FurnitureManager.Instance.Items)
                {
                    if (other == item || other == null || other.Dims == null || !other.IsResting) continue;
                    var sameTop = (other.Carrier != null && other.Carrier == item.Carrier) || (!string.IsNullOrEmpty(other.RestingOnPieceId) && other.RestingOnPieceId == item.RestingOnPieceId);
                    if (sameTop && Obb.Of(other.transform, other.Dims.w, other.Dims.d).Overlaps(box))
                    {
                        item.SetFit(FitState.Overlap, $"Overlaps {Short(other.Product.title)}");
                        return;
                    }
                }
                item.SetFit(FitState.Ok, "");
                return;
            }

            if (!item.IsWallMounted && room != null && room.Outline.Count >= 3 && box.Corners().Any(c => !room.Contains(c)))
            {
                item.SetFit(FitState.OutsideRoom, "Goes past your wall");
                return;
            }
            if (!isRug && !item.IsWallMounted)
            {
                foreach (var other in FurnitureManager.Instance.Items)
                {
                    if (other == item || other == null || other.Dims == null || other.IsWallMounted || other.Product.category == "rug" || other.IsResting) continue;
                    if (Obb.Of(other.transform, other.Dims.w, other.Dims.d).Overlaps(box))
                    {
                        item.SetFit(FitState.Overlap, $"Overlaps {Short(other.Product.title)}");
                        return;
                    }
                }
                var rf = RealFurniture.Instance;
                if (rf != null)
                {
                    foreach (var piece in rf.Pieces)
                    {
                        if (piece == null || piece.IsReplaced) continue;
                        if (box.Penetration(piece.Footprint, out var push) && push.magnitude > 0.015f)
                        {
                            item.SetFit(FitState.Overlap, $"Overlaps your {piece.Name} by {Mathf.Max(1, Mathf.RoundToInt(push.magnitude * 100))} cm");
                            return;
                        }
                    }
                }
                if (room != null)
                {
                    foreach (var o in room.Objects)
                    {
                        if (o.isOpening)
                        {
                            if (!o.label.Contains("DOOR")) continue;
                            // Keep ~0.9 m clear in front of doors (check both sides; the plane normal may face out).
                            var n = Quaternion.Euler(0, o.yawDeg, 0) * Vector3.forward;
                            foreach (var side in new[] { 1f, -1f })
                            {
                                var zone = new Obb(o.center + n * (0.45f * side), o.size.x / 2, 0.45f, o.yawDeg);
                                if (zone.Overlaps(box)) { item.SetFit(FitState.BlocksDoor, "Blocks your door"); return; }
                            }
                            continue;
                        }
                    }
                }
            }
            // Delivery check: will it fit through the narrowest door the user marked in Space Setup?
            string note = null;
            var door = room != null ? room.Objects.Where(o => o.label.Contains("DOOR")).OrderBy(o => o.size.x).FirstOrDefault() : null;
            if (door != null && !item.IsWallMounted)
            {
                var d = item.Dims;
                var sorted = new[] { d.w, d.d, d.h }.OrderBy(v => v).ToArray();
                if (sorted[0] > door.size.x - 0.02f || sorted[1] > door.size.y - 0.02f)
                    note = $"Delivery check: may not fit your {Mathf.RoundToInt(door.size.x * 100)} cm door";
            }
            item.SetFit(FitState.Ok, "");
            item.SetStatusNote(note);
        }

        static string Short(string s) => string.IsNullOrEmpty(s) ? "another item" : (s.Length > 28 ? s.Substring(0, 28) + "…" : s);
    }
}
