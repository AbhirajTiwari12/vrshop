using System.Collections.Generic;
using System.Threading.Tasks;
using GLTFast;
using UnityEngine;
using UnityEngine.Rendering;

namespace VRShop.Furniture
{
    /// <summary>
    /// Runtime GLB loading with glTFast. Each URL is downloaded and parsed once; every placement of the same
    /// product instantiates from the cached import. The backend already normalized the file (meters,
    /// pivot at floor-center, front = +Z, JPEG/PNG textures, no Draco/WebP), so no fix-ups are needed here.
    /// </summary>
    public static class ModelLoader
    {
        static readonly Dictionary<string, Task<GltfImport>> s_Imports = new Dictionary<string, Task<GltfImport>>();

        public static async Task<GameObject> Instantiate(string url, Transform parent)
        {
            var import = await GetImport(url);
            if (import == null || parent == null) return null;
            var holder = new GameObject("Model");
            holder.transform.SetParent(parent, false);
            var ok = await import.InstantiateMainSceneAsync(holder.transform);
            if (!ok || holder == null)
            {
                if (holder != null) Object.Destroy(holder);
                return null;
            }
            foreach (var r in holder.GetComponentsInChildren<Renderer>(true))
            {
                r.shadowCastingMode = ShadowCastingMode.On;
                r.receiveShadows = true;
            }
            return holder;
        }

        static Task<GltfImport> GetImport(string url)
        {
            if (s_Imports.TryGetValue(url, out var t)) return t;
            t = Load(url);
            s_Imports[url] = t;
            return t;
        }

        static async Task<GltfImport> Load(string url)
        {
            var import = new GltfImport();
            var settings = new ImportSettings { GenerateMipMaps = true, AnisotropicFilterLevel = 4 };
            var ok = await import.Load(url, settings);
            if (!ok)
            {
                Debug.LogError($"[VRShop] glTF load failed: {url}");
                s_Imports.Remove(url);
                import.Dispose();
                return null;
            }
            return import;
        }

        /// <summary>Local-space bounds of all renderers under root (relative to root).</summary>
        public static Bounds LocalBounds(Transform root)
        {
            var rs = root.GetComponentsInChildren<Renderer>(true);
            var has = false;
            var b = new Bounds();
            foreach (var r in rs)
            {
                if (r is ParticleSystemRenderer) continue;
                // Use the renderer's own local bounds, not r.bounds: a world AABB of a rotated item mapped back into
                // root space inflates the size (a 1.2 m sofa at 45° measures ~2 m), which broke fit checks.
                var lb = r.localBounds;
                var toRoot = root.worldToLocalMatrix * r.transform.localToWorldMatrix;
                for (var i = 0; i < 8; i++)
                {
                    var c = new Vector3((i & 1) == 0 ? lb.min.x : lb.max.x, (i & 2) == 0 ? lb.min.y : lb.max.y, (i & 4) == 0 ? lb.min.z : lb.max.z);
                    var lc = toRoot.MultiplyPoint3x4(c);
                    if (!has) { b = new Bounds(lc, Vector3.zero); has = true; }
                    else b.Encapsulate(lc);
                }
            }
            return b;
        }
    }
}
