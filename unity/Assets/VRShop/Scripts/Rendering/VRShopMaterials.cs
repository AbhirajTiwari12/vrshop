using System.Collections.Generic;
using UnityEngine;

namespace VRShop.Rendering
{
    /// <summary>
    /// Materials used at runtime. The editor setup (VRShop > Setup Window > Configure) writes them to
    /// Assets/VRShop/Resources/VRShopMaterials so their shaders are guaranteed to be in the Quest build.
    /// If they're missing (e.g. setup not run yet) we fall back to Shader.Find, which works in the editor.
    /// </summary>
    public static class VRShopMaterials
    {
        public const string ResourceFolder = "VRShopMaterials";
        static readonly Dictionary<string, Material> s_Cache = new Dictionary<string, Material>();

        public static Material ShadowCatcher => Get("ShadowCatcher", "VRShop/ShadowCatcher");
        public static Material DepthOccluder => Get("DepthOccluder", "VRShop/DepthOccluder");
        public static Material RoomCover => Get("RoomCover", "VRShop/RoomCover");
        public static Material BlobShadow => Get("BlobShadow", "VRShop/BlobShadow");
        public static Material UnlitColor => Get("UnlitColor", "Universal Render Pipeline/Unlit");
        public static Material UnlitTransparent => Get("UnlitTransparent", "VRShop/UnlitTransparent");
        public static Material Lit => Get("Lit", "Universal Render Pipeline/Lit");
        public static Material Skybox => Get("Skybox", "Skybox/Procedural");

        static Material Get(string name, string shaderName)
        {
            if (s_Cache.TryGetValue(name, out var m) && m != null) return m;
            m = Resources.Load<Material>($"{ResourceFolder}/{name}");
            if (m == null)
            {
                var shader = Shader.Find(shaderName);
                if (shader == null)
                {
                    Debug.LogWarning($"[VRShop] Shader '{shaderName}' not found; run VRShop > Setup Window > Configure Project.");
                    shader = Shader.Find("Universal Render Pipeline/Unlit") ?? Shader.Find("Unlit/Color");
                }
                m = new Material(shader) { name = name };
            }
            s_Cache[name] = m;
            return m;
        }

        /// <summary>New instance of a base material with a color applied (works for URP Lit/Unlit and our shaders).</summary>
        public static Material Instance(Material source, Color color)
        {
            var m = new Material(source);
            SetColor(m, color);
            return m;
        }

        public static void SetColor(Material m, Color c)
        {
            if (m.HasProperty("_BaseColor")) m.SetColor("_BaseColor", c);
            if (m.HasProperty("_Color")) m.SetColor("_Color", c);
        }

        public static Color Hex(string hex, Color fallback)
        {
            if (!string.IsNullOrEmpty(hex) && ColorUtility.TryParseHtmlString(hex.StartsWith("#") ? hex : "#" + hex, out var c)) return c;
            return fallback;
        }

        /// <summary>Approximate blackbody color for a color temperature (Tanner Helland's fit).</summary>
        public static Color Kelvin(float kelvin)
        {
            var t = Mathf.Clamp(kelvin, 1500f, 12000f) / 100f;
            float r, g, b;
            if (t <= 66) { r = 255; g = 99.4708025861f * Mathf.Log(t) - 161.1195681661f; }
            else { r = 329.698727446f * Mathf.Pow(t - 60, -0.1332047592f); g = 288.1221695283f * Mathf.Pow(t - 60, -0.0755148492f); }
            b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231f * Mathf.Log(t - 10) - 305.0447927307f;
            return new Color(Mathf.Clamp01(r / 255f), Mathf.Clamp01(g / 255f), Mathf.Clamp01(b / 255f));
        }
    }

    public static class ProceduralTextures
    {
        static Texture2D s_Blob;

        /// <summary>Soft rounded-rectangle falloff used for contact shadows under furniture.</summary>
        public static Texture2D Blob
        {
            get
            {
                if (s_Blob != null) return s_Blob;
                const int n = 64;
                s_Blob = new Texture2D(n, n, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp, name = "BlobShadow" };
                var px = new Color32[n * n];
                for (var y = 0; y < n; y++)
                for (var x = 0; x < n; x++)
                {
                    var u = Mathf.Abs(x / (n - 1f) * 2f - 1f);
                    var v = Mathf.Abs(y / (n - 1f) * 2f - 1f);
                    // superellipse distance: square-ish footprint with soft edge
                    var dist = Mathf.Pow(Mathf.Pow(u, 4) + Mathf.Pow(v, 4), 0.25f);
                    var a = 1f - Mathf.SmoothStep(0.55f, 1f, dist);
                    px[y * n + x] = new Color32(0, 0, 0, (byte)(a * 255));
                }
                s_Blob.SetPixels32(px);
                s_Blob.Apply(false, true);
                return s_Blob;
            }
        }
    }
}
