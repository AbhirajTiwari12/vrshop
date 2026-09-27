using System.Collections.Generic;
using UnityEngine;

namespace VRShop.Room
{
    /// <summary>
    /// Where a replacement product stands so it reads as "the new one in the old one's place": its long side runs along
    /// the real piece's long side (a sofa's width, a bed's length); if the piece backs onto a wall, the product's back goes against that same wall and it faces
    /// into the room; otherwise it's centered on the piece, facing the room. Pieces raised off the floor (a lamp on a
    /// table) keep their height. Mirrors replacementPose() in backend/src/realPose.ts; keep the two in step.
    /// </summary>
    public static class ReplacementPose
    {
        public struct Pose
        {
            public Vector3 position;
            public float yawDeg;
            public bool againstWall;
        }

        /// <param name="center">Box center (world).</param>
        /// <param name="size">x = width along the box's right axis, y = height, z = depth along its forward axis.</param>
        /// <param name="productW">Product width (m).</param>
        /// <param name="productD">Product depth (m).</param>
        public static Pose For(Vector3 center, Vector3 size, float yawDeg, float productW, float productD,
            IReadOnlyList<WallInfo> walls, float floorY, Vector3 roomCentroid)
        {
            var yaw = yawDeg * Mathf.Deg2Rad;
            var f = new Vector2(Mathf.Sin(yaw), Mathf.Cos(yaw));
            var r = new Vector2(Mathf.Cos(yaw), -Mathf.Sin(yaw));
            var c = new Vector2(center.x, center.z);
            var centroid = new Vector2(roomCentroid.x, roomCentroid.z);
            var longIsX = size.x >= size.z;
            var ratio = Mathf.Max(size.x, size.z) / Mathf.Max(Mathf.Min(size.x, size.z), 0.01f);

            // Front/back axis = across the short side for a wide piece (a sofa), along the long side for a deep one (a bed
            // runs head to foot); square-ish pieces may face either way, so try both axes.
            var across = (n: longIsX ? f : r, half: (longIsX ? size.z : size.x) / 2);
            var along = (n: longIsX ? r : f, half: (longIsX ? size.x : size.z) / 2);
            var deep = productD > productW * 1.1f;
            var axes = new List<(Vector2 n, float half)> { deep && ratio >= 1.15f ? along : across };
            if (ratio < 1.15f) axes.Add(along);

            Vector2? front = null;
            var half = axes[0].half;
            var best = float.MaxValue;
            foreach (var ax in axes)
            {
                foreach (var s in new[] { 1f, -1f })
                {
                    var dir = ax.n * s;
                    var back = c - dir * ax.half;
                    if (walls == null) continue;
                    foreach (var w in walls)
                    {
                        var wc = new Vector2(w.center.x, w.center.z);
                        var wn = new Vector2(w.normal.x, w.normal.z).normalized;
                        if (Vector2.Dot(wn, centroid - wc) < 0) wn = -wn; // into the room
                        if (Vector2.Dot(wn, dir) < 0.7f) continue;
                        var t = new Vector2(wn.y, -wn.x);
                        if (Mathf.Abs(Vector2.Dot(back - wc, t)) > w.width / 2 + 0.1f) continue;
                        var dist = Vector2.Dot(back - wc, wn);
                        if (dist > -0.15f && dist < 0.35f && dist < best) { best = dist; front = dir; half = ax.half; }
                    }
                }
            }
            var against = front.HasValue;
            var fr = front ?? (Vector2.Dot(axes[0].n, centroid - c) >= 0 ? axes[0].n : -axes[0].n);
            var pos = against ? c - fr * half + fr * (productD / 2) : c;
            var bottom = center.y - size.y / 2;
            var y = bottom > floorY + 0.12f ? bottom : floorY;
            var yawOut = Mathf.Repeat(Mathf.Atan2(fr.x, fr.y) * Mathf.Rad2Deg, 360f);
            return new Pose { position = new Vector3(pos.x, y, pos.y), yawDeg = yawOut, againstWall = against };
        }
    }
}
