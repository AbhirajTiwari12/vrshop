using System.Collections.Generic;
using UnityEngine;

namespace VRShop.Room
{
    /// <summary>The 12 edges of a box as thin square beams (one mesh), for outlining a real piece of furniture.</summary>
    public static class WireBox
    {
        static readonly int[] k_CubeTris =
        {
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
            1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
        };

        /// <summary>Build (or refill) a wireframe mesh for a box of <paramref name="size"/> centered on the local origin.</summary>
        public static Mesh Build(Vector3 size, float thickness, Mesh mesh = null)
        {
            if (mesh == null) mesh = new Mesh { name = "WireBox" };
            var h = size / 2;
            var c = new Vector3[8];
            for (var i = 0; i < 8; i++) c[i] = new Vector3((i & 1) == 0 ? -h.x : h.x, (i & 2) == 0 ? -h.y : h.y, (i & 4) == 0 ? -h.z : h.z);
            int[,] edges = { { 0, 1 }, { 2, 3 }, { 4, 5 }, { 6, 7 }, { 0, 2 }, { 1, 3 }, { 4, 6 }, { 5, 7 }, { 0, 4 }, { 1, 5 }, { 2, 6 }, { 3, 7 } };
            var verts = new List<Vector3>(96);
            var tris = new List<int>(432);
            var t = thickness / 2;
            for (var e = 0; e < 12; e++)
            {
                var a = c[edges[e, 0]]; var b = c[edges[e, 1]];
                var min = Vector3.Min(a, b) - Vector3.one * t;
                var max = Vector3.Max(a, b) + Vector3.one * t;
                var baseIndex = verts.Count;
                verts.Add(new Vector3(min.x, min.y, min.z)); verts.Add(new Vector3(max.x, min.y, min.z));
                verts.Add(new Vector3(max.x, max.y, min.z)); verts.Add(new Vector3(min.x, max.y, min.z));
                verts.Add(new Vector3(min.x, min.y, max.z)); verts.Add(new Vector3(max.x, min.y, max.z));
                verts.Add(new Vector3(max.x, max.y, max.z)); verts.Add(new Vector3(min.x, max.y, max.z));
                foreach (var i in k_CubeTris) tris.Add(baseIndex + i);
            }
            mesh.Clear();
            mesh.SetVertices(verts);
            mesh.SetTriangles(tris, 0);
            mesh.RecalculateBounds();
            return mesh;
        }
    }
}
