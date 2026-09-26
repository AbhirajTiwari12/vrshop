using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.PackageManager;
using UnityEngine;

namespace VRShop.Installer
{
    /// <summary>
    /// Step 1 of the setup. Lives in its own assembly with no dependencies so it compiles in a fresh
    /// Unity project before the Meta / glTFast packages exist (the rest of VRShop is compiled only once
    /// they are installed, via define constraints in the asmdefs).
    /// </summary>
    public static class VRShopPackageInstaller
    {
        // Versions verified against the package registries (2026-09). Meta XR v207 requires Unity 6000.0.66f2+.
        static readonly (string name, string version)[] k_Packages =
        {
            ("com.meta.xr.sdk.core", "207.0.0"),
            ("com.meta.xr.mrutilitykit", "207.0.0"),
            ("com.unity.xr.openxr", "1.18.0"),
            ("com.unity.cloud.gltfast", "6.20.0"),
            ("com.unity.nuget.newtonsoft-json", "3.2.2"),
        };

        const string k_ManifestPath = "Packages/manifest.json";
        const string k_MetaRegistryUrl = "https://npm.developer.oculus.com";
        const string k_PromptKey = "VRShop.Installer.Prompted";

        [MenuItem("VRShop/1. Install Packages", priority = 1)]
        public static void Install()
        {
            if (!File.Exists(k_ManifestPath))
            {
                EditorUtility.DisplayDialog("VRShop", "Packages/manifest.json not found. Open this from a Unity project.", "OK");
                return;
            }

            var text = File.ReadAllText(k_ManifestPath);
            var original = text;

            // 1) Meta's scoped registry (Meta XR packages are published there, not on Unity's registry).
            if (!text.Contains(k_MetaRegistryUrl))
            {
                const string registry =
                    "    {\n      \"name\": \"Meta XR\",\n      \"url\": \"" + k_MetaRegistryUrl + "\",\n      \"scopes\": [\n        \"com.meta.xr\"\n      ]\n    }";
                var idx = text.IndexOf("\"scopedRegistries\"", System.StringComparison.Ordinal);
                if (idx >= 0)
                {
                    var bracket = text.IndexOf('[', idx);
                    var nextNonWs = text.Skip(bracket + 1).FirstOrDefault(c => !char.IsWhiteSpace(c));
                    text = text.Insert(bracket + 1, "\n" + registry + (nextNonWs == ']' ? "\n  " : ","));
                }
                else
                {
                    var brace = text.IndexOf('{');
                    text = text.Insert(brace + 1, "\n  \"scopedRegistries\": [\n" + registry + "\n  ],");
                }
            }

            // 2) Dependencies we need (never downgrade something already present).
            var missing = k_Packages.Where(p => !text.Contains("\"" + p.name + "\"")).ToArray();
            if (missing.Length > 0)
            {
                var depIdx = text.IndexOf("\"dependencies\"", System.StringComparison.Ordinal);
                var open = text.IndexOf('{', depIdx);
                var nextNonWs = text.Skip(open + 1).FirstOrDefault(c => !char.IsWhiteSpace(c));
                var sb = new StringBuilder();
                for (var i = 0; i < missing.Length; i++)
                {
                    sb.Append("\n    \"").Append(missing[i].name).Append("\": \"").Append(missing[i].version).Append('"');
                    if (i < missing.Length - 1 || nextNonWs != '}') sb.Append(',');
                }
                text = text.Insert(open + 1, sb.ToString());
            }

            if (text == original)
            {
                Debug.Log("[VRShop] All packages already listed in manifest.json. Resolving…");
            }
            else
            {
                File.WriteAllText(k_ManifestPath, text);
                Debug.Log("[VRShop] Added to manifest.json: " + string.Join(", ", missing.Select(m => m.name + "@" + m.version)));
            }
            Client.Resolve();
            EditorUtility.DisplayDialog("VRShop",
                "Packages are installing. Unity will import them and recompile (a few minutes the first time).\n\n" +
                "If Unity asks to enable the new Input System backend or to restart, click Yes.\n\n" +
                "When it's done, open  VRShop > Setup Window  and run steps 2 and 3.", "OK");
        }

        [InitializeOnLoadMethod]
        static void PromptOnFirstImport()
        {
            // Offer to install once per editor session if the core packages are missing.
            if (SessionState.GetBool(k_PromptKey, false)) return;
            SessionState.SetBool(k_PromptKey, true);
            EditorApplication.delayCall += () =>
            {
                if (!File.Exists(k_ManifestPath)) return;
                var text = File.ReadAllText(k_ManifestPath);
                if (k_Packages.All(p => text.Contains("\"" + p.name + "\""))) return;
                if (EditorUtility.DisplayDialog("VRShop",
                        "VRShop needs the Meta XR SDK, MR Utility Kit, OpenXR and glTFast packages.\nInstall them now?",
                        "Install", "Later"))
                {
                    Install();
                }
            };
        }
    }
}
