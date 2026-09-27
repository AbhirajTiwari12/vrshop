using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace VRShop.Interaction
{
    /// <summary>2D oriented box on the floor plane (XZ) for fit checks. Yaw rotates +Z toward +X (Unity's convention).</summary>
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

        public Vector2 Center => m_C;
        public float HalfWidth => m_Hw;
        public float HalfDepth => m_Hd;
        public float YawDeg => m_Yaw * Mathf.Rad2Deg;

        /// <summary>Unit axes on the floor: forward (depth) and right (width).</summary>
        public Vector2 Fwd => new Vector2(Mathf.Sin(m_Yaw), Mathf.Cos(m_Yaw));
        public Vector2 Right => new Vector2(Mathf.Cos(m_Yaw), -Mathf.Sin(m_Yaw));

        /// <summary>Same shape, centered elsewhere on the floor.</summary>
        public Obb At(Vector2 center) => new Obb(new Vector3(center.x, 0, center.y), m_Hw, m_Hd, YawDeg);

        public Vector3[] Corners() => Corners2D().Select(p => new Vector3(p.x, 0, p.y)).ToArray();

        public Vector2[] Corners2D() { var f = Fwd * m_Hd; var r = Right * m_Hw; return new[] { m_C + r + f, m_C - r + f, m_C - r - f, m_C + r - f }; }

        public bool Overlaps(Obb o, float tolerance = 0.015f)
        {
            var a = Corners2D(); var b = o.Corners2D();
            foreach (var axis in new[] { Fwd, Right, o.Fwd, o.Right })
            {
                Project(a, axis, out var amin, out var amax);
                Project(b, axis, out var bmin, out var bmax);
                if (amax - tolerance <= bmin || bmax - tolerance <= amin) return false;
            }
            return true;
        }

        /// <summary>
        /// The smallest move of this box (on the floor) that gets it out of <paramref name="o"/>: separating-axis test,
        /// shortest overlapping axis, pointing away from o's center. False if they don't overlap.
        /// </summary>
        public bool Penetration(Obb o, out Vector2 push)
        {
            push = Vector2.zero;
            var a = Corners2D(); var b = o.Corners2D();
            var best = float.MaxValue;
            foreach (var axis in new[] { Fwd, Right, o.Fwd, o.Right })
            {
                Project(a, axis, out var amin, out var amax);
                Project(b, axis, out var bmin, out var bmax);
                var overlap = Mathf.Min(amax - bmin, bmax - amin);
                if (overlap <= 0) return false;
                if (overlap < best)
                {
                    best = overlap;
                    var away = Vector2.Dot(m_C - o.m_C, axis) >= 0 ? 1f : -1f;
                    push = axis * (away * overlap);
                }
            }
            return true;
        }

        static void Project(Vector2[] pts, Vector2 axis, out float min, out float max)
        {
            min = float.MaxValue; max = float.MinValue;
            foreach (var p in pts) { var v = Vector2.Dot(p, axis); if (v < min) min = v; if (v > max) max = v; }
        }
    }

    /// <summary>A wall as a floor-plane line segment with a normal pointing into the room.</summary>
    public readonly struct WallPlane
    {
        public readonly Vector2 Point, Normal, Tangent;
        public readonly float HalfWidth;

        public WallPlane(Vector3 center, Vector3 normalIntoRoom, float width)
        {
            Point = new Vector2(center.x, center.z);
            Normal = new Vector2(normalIntoRoom.x, normalIntoRoom.z).normalized;
            Tangent = new Vector2(Normal.y, -Normal.x);
            HalfWidth = width / 2;
        }
    }

    /// <summary>
    /// Keeps furniture out of the user's real furniture and inside the room: push-out resolution (so a dragged piece
    /// slides along a real couch instead of going into it), swept moves (no tunnelling through thin pieces), and a
    /// spiral search for the nearest free spot. Pure math, no scene access.
    /// </summary>
    public static class FootprintSolver
    {
        public const float Gap = 0.01f;

        /// <summary>Move a footprint out of every solid and back inside the walls. Returns the corrected center (y kept).</summary>
        public static Vector3 Resolve(Vector3 center, Obb shape, IReadOnlyList<Obb> solids, IReadOnlyList<WallPlane> walls, int iterations = 8)
        {
            var c = new Vector2(center.x, center.z);
            for (var it = 0; it < iterations; it++)
            {
                var moved = false;
                if (solids != null)
                {
                    foreach (var s in solids)
                    {
                        if (!shape.At(c).Penetration(s, out var push)) continue;
                        c += push + push.normalized * Gap;
                        moved = true;
                    }
                }
                var wp = WallPush(shape.At(c), walls);
                if (wp.sqrMagnitude > 1e-10f) { c += wp; moved = true; }
                if (!moved) break;
            }
            return new Vector3(c.x, center.y, c.y);
        }

        /// <summary>Walk from a valid spot toward a target in small steps, resolving each, so the footprint slides along solids.</summary>
        public static Vector3 Sweep(Vector3 from, Vector3 to, Obb shape, IReadOnlyList<Obb> solids, IReadOnlyList<WallPlane> walls, float step = 0.04f)
        {
            var p = Resolve(from, shape, solids, walls);
            var delta = to - from; delta.y = 0;
            var n = Mathf.Clamp(Mathf.CeilToInt(delta.magnitude / step), 1, 60);
            for (var i = 0; i < n; i++) p = Resolve(p + delta / n, shape, solids, walls);
            p.y = to.y;
            return p;
        }

        /// <summary>How far a footprint must move to get back inside the walls it crosses (zero if it's inside).</summary>
        public static Vector2 WallPush(Obb box, IReadOnlyList<WallPlane> walls)
        {
            var total = Vector2.zero;
            if (walls == null) return total;
            var corners = box.Corners2D();
            foreach (var w in walls)
            {
                var need = 0f;
                foreach (var p in corners)
                {
                    var rel = p - w.Point;
                    if (Mathf.Abs(Vector2.Dot(rel, w.Tangent)) > w.HalfWidth + 0.05f) continue;
                    var d = Vector2.Dot(rel, w.Normal);
                    if (d < -0.6f) continue; // far behind this wall: another part of the room, not this wall's business
                    if (d < Gap) need = Mathf.Max(need, Gap - d);
                }
                total += w.Normal * need;
            }
            return total;
        }

        public static bool IsFree(Obb box, IReadOnlyList<Obb> solids, IReadOnlyList<WallPlane> walls, Func<Vector2, bool> insideRoom = null)
        {
            if (solids != null) foreach (var s in solids) if (box.Overlaps(s, 0.005f)) return false;
            if (WallPush(box, walls).sqrMagnitude > 1e-8f) return false;
            return insideRoom == null || box.Corners2D().All(insideRoom);
        }

        /// <summary>Nearest spot to <paramref name="desired"/> (spiral search, 10 cm rings) where the footprint is free.</summary>
        public static bool TryFindFreeSpot(Vector3 desired, Obb shape, IReadOnlyList<Obb> solids, IReadOnlyList<WallPlane> walls,
            Func<Vector2, bool> insideRoom, out Vector3 spot, float maxRadius = 3f, float step = 0.1f)
        {
            for (var r = 0f; r <= maxRadius + 1e-4f; r += step)
            {
                var count = r < 1e-4f ? 1 : Mathf.Max(8, Mathf.CeilToInt(2 * Mathf.PI * r / step));
                for (var k = 0; k < count; k++)
                {
                    var a = k * 2 * Mathf.PI / count;
                    var c = new Vector2(desired.x + Mathf.Cos(a) * r, desired.z + Mathf.Sin(a) * r);
                    if (!IsFree(shape.At(c), solids, walls, insideRoom)) continue;
                    spot = new Vector3(c.x, desired.y, c.y);
                    return true;
                }
            }
            spot = desired;
            return false;
        }
    }
}
