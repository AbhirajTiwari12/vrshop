using TMPro;
using UnityEngine;

namespace VRShop.UI
{
    /// <summary>
    /// The boutique look, in one place: warm ivory surfaces, charcoal ink, brass accents; DM Serif Display for
    /// headings and prices, Inter for everything else. Every panel takes its colors and type from here so the
    /// headset UI stays consistent. Fonts are TMP assets built by VRShop > Rebuild UI Fonts (committed in
    /// Resources/VRShopFonts); if they're missing the UI falls back to TMP's default font.
    /// </summary>
    public static class Theme
    {
        // ---- surfaces
        public static readonly Color Canvas = Hex("#F5F0E8");        // panels: warm ivory
        public static readonly Color Surface = Hex("#FFFFFF");       // cards (product shots are on white)
        public static readonly Color SurfaceHover = Hex("#FFFCF7");
        public static readonly Color Sunken = Hex("#ECE5DA");        // chips, secondary buttons
        public static readonly Color SunkenHover = Hex("#E1D7C8");
        public static readonly Color Line = Hex("#E2D9CB");          // hairlines, empty bars
        public static readonly Color Clear = new Color(1, 1, 1, 0);

        // ---- ink
        public static readonly Color Ink = Hex("#2B2621");           // primary text + primary buttons
        public static readonly Color InkHover = Hex("#463E36");
        public static readonly Color Muted = Hex("#857A6E");         // secondary text
        public static readonly Color Faint = Hex("#B0A596");
        public static readonly Color OnInk = Hex("#F7F2EA");         // text on ink

        // ---- accents
        public static readonly Color Brass = Hex("#A8834F");
        public static readonly Color BrassSoft = Hex("#F1E6D3");
        public static readonly Color Sage = Hex("#5E7B5A");          // good / fits
        public static readonly Color Ochre = Hex("#B27A2C");         // caution
        public static readonly Color Terracotta = Hex("#B14C3A");    // problems
        public static readonly Color VisaNavy = Hex("#1A1F71");
        public static readonly Color VisaNavyHover = Hex("#2B3292");

        // Rich-text versions for inline <color=...> tags.
        public const string InkHex = "#2B2621", MutedHex = "#857A6E", FaintHex = "#B0A596", BrassHex = "#A8834F",
            SageHex = "#5E7B5A", OchreHex = "#B27A2C", TerracottaHex = "#B14C3A";

        // ---- type
        public const string FontFolder = "VRShopFonts";
        public const string SansName = "Inter-Regular SDF", SansMediumName = "Inter-Medium SDF", SansSemiBoldName = "Inter-SemiBold SDF",
            SerifName = "DMSerifDisplay-Regular SDF", SerifItalicName = "DMSerifDisplay-Italic SDF";

        static TMP_FontAsset s_Sans, s_SansMedium, s_SansSemiBold, s_Serif, s_SerifItalic;
        public static TMP_FontAsset Sans => Load(ref s_Sans, SansName);
        public static TMP_FontAsset SansMedium => Load(ref s_SansMedium, SansMediumName);
        public static TMP_FontAsset SansSemiBold => Load(ref s_SansSemiBold, SansSemiBoldName);
        public static TMP_FontAsset Serif => Load(ref s_Serif, SerifName);
        public static TMP_FontAsset SerifItalic => Load(ref s_SerifItalic, SerifItalicName);

        public static TMP_FontAsset FontFor(Face face) => face switch
        {
            Face.Medium => SansMedium,
            Face.SemiBold => SansSemiBold,
            Face.Serif => Serif,
            Face.SerifItalic => SerifItalic,
            _ => Sans,
        };

        static TMP_FontAsset Load(ref TMP_FontAsset cache, string name)
        {
            if (cache != null) return cache;
            cache = Resources.Load<TMP_FontAsset>($"{FontFolder}/{name}");
            if (cache == null)
            {
                Debug.LogWarning($"[VRShop] UI font '{name}' missing; run VRShop > Rebuild UI Fonts. Using the TMP default.");
                cache = TMP_Settings.defaultFontAsset;
            }
            return cache;
        }

        /// <summary>"#RRGGBB" / "#RRGGBBAA" → Color. Plain C# (no engine call) so it's safe in static initializers.</summary>
        public static Color Hex(string hex)
        {
            var s = (hex ?? "").TrimStart('#');
            if ((s.Length != 6 && s.Length != 8) || !uint.TryParse(s, System.Globalization.NumberStyles.HexNumber, null, out var v)) return Color.magenta;
            if (s.Length == 6) v = (v << 8) | 0xFF;
            return new Color(((v >> 24) & 0xFF) / 255f, ((v >> 16) & 0xFF) / 255f, ((v >> 8) & 0xFF) / 255f, (v & 0xFF) / 255f);
        }

        public static Color WithAlpha(Color c, float a) { c.a = a; return c; }
    }

    /// <summary>Typeface roles: body text, emphasis, labels, and the serif for headings and prices.</summary>
    public enum Face { Regular, Medium, SemiBold, Serif, SerifItalic }
}
