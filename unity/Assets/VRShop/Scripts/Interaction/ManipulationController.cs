using System.Linq;
using UnityEngine;
using VRShop.Furniture;
using VRShop.Input;
using VRShop.Room;

namespace VRShop.Interaction
{
    /// <summary>
    /// Select, drag, rotate, wall-snap and delete placed furniture, with a live fit check:
    ///  - trigger (or grip) on an item + move = slide it along the floor (wall art slides along walls)
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
        }

        public void EndDrag(FurnitureItem item, PointerEvent e, bool clicked)
        {
            if (m_Drag != item) return;
            if (IsDragging && !item.IsWallMounted) SnapToWall(item);
            m_Drag = null;
            IsDragging = false;
            CheckFit(item);
            FurnitureManager.Instance?.ScheduleSync();
        }

        void Update()
        {
            var input = XRInput.Instance;
            if (input == null) return;

            if (m_Drag != null)
            {
                var ray = input.GetRay(m_Hand);
                if (m_Drag.IsWallMounted) DragOnWall(m_Drag, ray);
                else
                {
                    var fp = FloorPoint(ray);
                    if (fp.HasValue)
                    {
                        m_Target = fp.Value + m_Offset;
                        if (!IsDragging && (Vector3.Distance(m_Target, m_Drag.transform.position) > 0.03f || Time.time - m_PressTime > 0.25f)) IsDragging = true;
                        if (IsDragging)
                            m_Drag.transform.position = Vector3.Lerp(m_Drag.transform.position, m_Target, 1 - Mathf.Exp(-Time.deltaTime * 18));
                    }
                }
            }

            if (Selected != null)
            {
                var stick = input.Stick(Hand.Right);
                if (Mathf.Abs(stick.x) < 0.2f) stick = input.Stick(Hand.Left);
                if (Mathf.Abs(stick.x) > 0.2f && !Selected.IsWallMounted)
                {
                    Selected.transform.Rotate(0, stick.x * 110f * Time.deltaTime, 0, Space.World);
                    FurnitureManager.Instance?.ScheduleSync();
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

            if (!item.IsWallMounted && room != null && room.Outline.Count >= 3 && box.Corners().Any(c => !room.Contains(c)))
            {
                item.SetFit(FitState.OutsideRoom, "Goes past your wall");
                return;
            }
            if (!isRug && !item.IsWallMounted)
            {
                foreach (var other in FurnitureManager.Instance.Items)
                {
                    if (other == item || other == null || other.Dims == null || other.IsWallMounted || other.Product.category == "rug") continue;
                    if (Obb.Of(other.transform, other.Dims.w, other.Dims.d).Overlaps(box))
                    {
                        item.SetFit(FitState.Overlap, $"Overlaps {Short(other.Product.title)}");
                        return;
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
                        var ob = new Obb(o.center, o.size.x / 2, o.size.z / 2, o.yawDeg);
                        if (ob.Overlaps(box))
                        {
                            item.SetFit(FitState.Overlap, $"Overlaps your {o.label.ToLower().Replace('_', ' ')}");
                            return;
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

    /// <summary>2D oriented box on the floor plane (XZ) for fit checks.</summary>
    public readonly struct Obb
    {
        readonly Vector2 m_C;
        readonly float m_Hw, m_Hd, m_Yaw;

        public Obb(Vector3 center, float halfWidth, float halfDepth, float yawDeg)
        {
            m_C = new Vector2(center.x, center.z);
            m_Hw = halfWidth;
            m_Hd = halfDepth;
            m_Yaw = yawDeg * Mathf.Deg2Rad;
        }

        public static Obb Of(Transform t, float w, float d) => new Obb(t.position, w / 2, d / 2, t.eulerAngles.y);

        Vector2 Fwd => new Vector2(Mathf.Sin(m_Yaw), Mathf.Cos(m_Yaw));
        Vector2 Right => new Vector2(Mathf.Cos(m_Yaw), -Mathf.Sin(m_Yaw));

        public Vector3[] Corners()
        {
            var f = Fwd * m_Hd; var r = Right * m_Hw;
            Vector2[] c = { m_C + r + f, m_C - r + f, m_C - r - f, m_C + r - f };
            return c.Select(p => new Vector3(p.x, 0, p.y)).ToArray();
        }

        Vector2[] Corners2() { var f = Fwd * m_Hd; var r = Right * m_Hw; return new[] { m_C + r + f, m_C - r + f, m_C - r - f, m_C + r - f }; }

        public bool Overlaps(Obb o, float tolerance = 0.015f)
        {
            var a = Corners2(); var b = o.Corners2();
            foreach (var axis in new[] { Fwd, Right, o.Fwd, o.Right })
            {
                float amin = float.MaxValue, amax = float.MinValue, bmin = float.MaxValue, bmax = float.MinValue;
                foreach (var p in a) { var v = Vector2.Dot(p, axis); amin = Mathf.Min(amin, v); amax = Mathf.Max(amax, v); }
                foreach (var p in b) { var v = Vector2.Dot(p, axis); bmin = Mathf.Min(bmin, v); bmax = Mathf.Max(bmax, v); }
                if (amax - tolerance <= bmin || bmax - tolerance <= amin) return false;
            }
            return true;
        }
    }
}
