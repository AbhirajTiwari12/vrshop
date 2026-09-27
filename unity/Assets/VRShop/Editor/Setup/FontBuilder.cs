using System.Collections.Generic;
using System.IO;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.TextCore.LowLevel;
using VRShop.UI;

namespace VRShop.EditorTools
{
    /// <summary>
    /// Builds the boutique UI fonts (Inter for text, DM Serif Display for headings and prices; both SIL OFL, in
    /// Assets/VRShop/Fonts) into static TextMeshPro SDF assets under Resources/VRShopFonts, where Theme loads them.
    /// Static atlases keep git clean (a dynamic atlas rewrites itself whenever new characters show up in Play mode).
    /// The generated assets are committed, so this only needs re-running after changing a font or the character set.
    /// </summary>
    public static class FontBuilder
    {
        const string k_SourceDir = "Assets/VRShop/Fonts";
        const string k_OutDir = ProjectConfigurator.ResourcesRoot + "/" + Theme.FontFolder;

        // Everything the app and the catalog's product names need: ASCII, Latin-1 (IKEA's ÅÄÖ, café, bouclé) and the
        // typographic marks the server and UI use. Anything else falls back to TMP's default font.
        static string Charset
        {
            get
            {
                var chars = new List<char>();
                for (var c = 32; c < 127; c++) chars.Add((char)c);
                for (var c = 160; c < 256; c++) chars.Add((char)c);
                chars.AddRange("ŁłŒœŠšŽžŸ–—‘’‚“”„•…‹›€™←→↑↓★☆✓·×±°′″½¼¾≤≥◆●○⌄");
                return new string(chars.Distinct().ToArray());
            }
        }

        static readonly (string ttf, string asset)[] k_Fonts =
        {
            ("Inter-Regular.ttf", Theme.SansName),
            ("Inter-Medium.ttf", Theme.SansMediumName),
            ("Inter-SemiBold.ttf", Theme.SansSemiBoldName),
            ("DMSerifDisplay-Regular.ttf", Theme.SerifName),
            ("DMSerifDisplay-Italic.ttf", Theme.SerifItalicName),
        };

        [MenuItem("VRShop/Rebuild UI Fonts", priority = 40)]
        public static void BuildAll()
        {
            EnsureDir(k_OutDir);
            var built = new Dictionary<string, TMP_FontAsset>();
            foreach (var (ttf, asset) in k_Fonts)
            {
                var fa = Build($"{k_SourceDir}/{ttf}", $"{k_OutDir}/{asset}.asset", asset);
                if (fa != null) built[asset] = fa;
            }
            // <b> and FontStyles.Bold use the real SemiBold face instead of faux bold.
            if (built.TryGetValue(Theme.SansSemiBoldName, out var semiBold))
            {
                foreach (var name in new[] { Theme.SansName, Theme.SansMediumName })
                {
                    if (!built.TryGetValue(name, out var fa)) continue;
                    fa.fontWeightTable[7].regularTypeface = semiBold;
                    EditorUtility.SetDirty(fa);
                }
            }
            // Serif faces lack a few symbols (★ → ✓); borrow them from Inter.
            if (built.TryGetValue(Theme.SansName, out var sans))
            {
                foreach (var serif in new[] { Theme.SerifName, Theme.SerifItalicName })
                {
                    if (!built.TryGetValue(serif, out var fa)) continue;
                    fa.fallbackFontAssetTable = new List<TMP_FontAsset> { sans };
                    EditorUtility.SetDirty(fa);
                }
            }
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log($"[VRShop] Built {built.Count} UI font assets in {k_OutDir}.");
        }

        /// <summary>Called by Configure: build only if the assets are missing (they're normally committed).</summary>
        public static void BuildIfMissing()
        {
            if (k_Fonts.All(f => File.Exists($"{k_OutDir}/{f.asset}.asset"))) return;
            BuildAll();
        }

        static TMP_FontAsset Build(string ttfPath, string outPath, string name)
        {
            var font = AssetDatabase.LoadAssetAtPath<Font>(ttfPath);
            if (font == null) { Debug.LogWarning($"[VRShop] Font not found: {ttfPath}"); return null; }

            // Populate dynamically at edit time, then freeze the atlas.
            var fa = TMP_FontAsset.CreateFontAsset(font, 64, 8, GlyphRenderMode.SDFAA, 1024, 1024, AtlasPopulationMode.Dynamic, false);
            if (fa == null) { Debug.LogWarning($"[VRShop] Couldn't load {ttfPath} (enable Include Font Data)."); return null; }
            fa.name = name;
            AssetDatabase.DeleteAsset(outPath);
            AssetDatabase.CreateAsset(fa, outPath);
            fa.material.name = name + " Material";
            fa.atlasTexture.name = name + " Atlas";
            AssetDatabase.AddObjectToAsset(fa.material, fa);
            AssetDatabase.AddObjectToAsset(fa.atlasTexture, fa);

            fa.TryAddCharacters(Charset, out var missing);
            var unexpected = new string((missing ?? "").Where(c => c > 255 && "★☆✓←→↑↓◆●○⌄′″".IndexOf(c) < 0).ToArray());
            if (unexpected.Length > 0) Debug.LogWarning($"[VRShop] {name}: atlas full or glyphs missing: {unexpected}");
            fa.atlasPopulationMode = AtlasPopulationMode.Static;
            EditorUtility.SetDirty(fa);
            return fa;
        }

        static void EnsureDir(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return;
            var parent = Path.GetDirectoryName(path)?.Replace('\\', '/');
            if (!string.IsNullOrEmpty(parent)) EnsureDir(parent);
            AssetDatabase.CreateFolder(parent, Path.GetFileName(path));
        }
    }
}
