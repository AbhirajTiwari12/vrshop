using System;
using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.UI;
using VRShop.Input;
using VRShop.Interaction;

namespace VRShop.UI
{
    public enum ButtonStyle
    {
        Primary,    // charcoal, the one main action on a view
        Secondary,  // warm stone
        Ghost,      // text only until hovered
        Chip,       // pill; ink when selected
        Nav,        // top navigation; ink text + brass underline when selected
        Visa,       // payment approval
        Card,       // white product card that lifts on hover
        Round,      // circular white arrow button
    }

    /// <summary>
    /// Code-built world-space UI (no prefabs to wire up in the editor). Coordinates are pixels from the
    /// top-left of the parent; a canvas maps pixels to meters with its scale. Colors and fonts come from Theme.
    /// </summary>
    public static class UIKit
    {
        const int k_SpriteRadius = 48;   // corner radius baked into the Rounded sprite (px); Image scales it
        const int k_ShadowInset = 44;    // falloff width baked into the Shadow sprite (px)

        static Sprite s_Rounded, s_Shadow, s_Circle;

        /// <summary>9-sliced white rounded rectangle generated at runtime (radius set per Image).</summary>
        public static Sprite Rounded => s_Rounded != null ? s_Rounded : s_Rounded = MakeSprite("Rounded", 128, k_SpriteRadius + 2, (x, y, n) =>
        {
            var c = Mathf.Clamp(x, k_SpriteRadius, n - k_SpriteRadius);
            var d = Mathf.Clamp(y, k_SpriteRadius, n - k_SpriteRadius);
            return Mathf.Clamp01(k_SpriteRadius - Vector2.Distance(new Vector2(x, y), new Vector2(c, d)) + 0.5f);
        });

        /// <summary>Soft drop shadow: a blurred rounded rectangle whose inner edge is k_ShadowInset px in.</summary>
        public static Sprite ShadowSprite => s_Shadow != null ? s_Shadow : s_Shadow = MakeSprite("Shadow", 128, 60, (x, y, n) =>
        {
            const float r = 12f, half = 64 - k_ShadowInset;
            var q = new Vector2(Mathf.Max(Mathf.Abs(x - 64) - (half - r), 0), Mathf.Max(Mathf.Abs(y - 64) - (half - r), 0));
            var d = q.magnitude - r;
            var t = Mathf.Max(d, 0) / 20f;
            return Mathf.Exp(-t * t);
        });

        /// <summary>Anti-aliased disc.</summary>
        public static Sprite Circle => s_Circle != null ? s_Circle : s_Circle = MakeSprite("Circle", 128, 0, (x, y, n) =>
            Mathf.Clamp01(n / 2f - 1 - Vector2.Distance(new Vector2(x, y), new Vector2(n / 2f, n / 2f)) + 0.5f));

        /// <summary>White sprite from an alpha function of pixel center (x, y) in an n×n texture; mipmapped for VR.</summary>
        public static Sprite MakeSprite(string name, int n, int border, Func<float, float, int, float> alpha)
        {
            var tex = new Texture2D(n, n, TextureFormat.RGBA32, true) { wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Trilinear, name = name };
            var px = new Color32[n * n];
            for (var y = 0; y < n; y++)
            for (var x = 0; x < n; x++)
                px[y * n + x] = new Color32(255, 255, 255, (byte)(Mathf.Clamp01(alpha(x + 0.5f, y + 0.5f, n)) * 255));
            tex.SetPixels32(px);
            tex.Apply(true, true);
            return Sprite.Create(tex, new Rect(0, 0, n, n), new Vector2(0.5f, 0.5f), 100, 0, SpriteMeshType.FullRect, new Vector4(border, border, border, border));
        }

        // Draw order between canvases (all UI ignores depth, see Overlay): furniture cards under the catalog, the
        // designer and its speech bubble over it, toasts on top.
        public const int OrderCard = 0, OrderCatalog = 10, OrderOrb = 20, OrderToast = 30;

        public static Canvas CreateCanvas(string name, Vector2 sizePx, float metersPerPx, int sortingOrder = OrderCard)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(Canvas));
            var canvas = go.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            canvas.sortingOrder = sortingOrder;
            var rt = (RectTransform)go.transform;
            rt.sizeDelta = sizePx;
            rt.pivot = new Vector2(0.5f, 0.5f);
            go.transform.localScale = Vector3.one * metersPerPx;
            var scaler = go.AddComponent<CanvasScaler>();
            scaler.dynamicPixelsPerUnit = 2;
            return canvas;
        }

        static Material s_OverlayUI;
        static readonly Dictionary<Material, Material> s_OverlayText = new Dictionary<Material, Material>();

        /// <summary>
        /// UI draws over the room instead of being depth-tested against it. The walls and the user's real furniture are
        /// invisible depth-only occluders, so a panel that follows the head used to vanish (often in one eye first) as
        /// soon as the user stood near a wall or a tall piece, or walked up to a piece of virtual furniture.
        /// </summary>
        public static void Overlay(Graphic g)
        {
            if (g == null) return;
            if (g is TMP_Text t) { OverlayText(t); return; }
            if (s_OverlayUI == null)
            {
                s_OverlayUI = new Material(Canvas.GetDefaultCanvasMaterial()) { name = "UI (overlay)" };
                s_OverlayUI.SetInt("unity_GUIZTestMode", (int)CompareFunction.Always);
            }
            g.material = s_OverlayUI;
        }

        /// <summary>Overlay for text; call again after changing a label's font.</summary>
        public static void OverlayText(TMP_Text t)
        {
            var src = t != null ? t.fontSharedMaterial : null;
            if (src == null) return;
            if (!s_OverlayText.TryGetValue(src, out var m))
            {
                m = new Material(src) { name = src.name + " (overlay)" };
                m.SetInt("unity_GUIZTestMode", (int)CompareFunction.Always);
                s_OverlayText[src] = m;
                s_OverlayText[m] = m;
            }
            if (t.fontSharedMaterial != m) t.fontSharedMaterial = m;
        }

        /// <summary>Create a child RectTransform positioned in pixels from the parent's top-left corner.</summary>
        public static RectTransform Box(Transform parent, string name, float x, float y, float w, float h)
        {
            var go = new GameObject(name, typeof(RectTransform));
            var rt = (RectTransform)go.transform;
            rt.SetParent(parent, false);
            rt.anchorMin = rt.anchorMax = new Vector2(0, 1);
            rt.pivot = new Vector2(0, 1);
            rt.anchoredPosition = new Vector2(x, -y);
            rt.sizeDelta = new Vector2(w, h);
            return rt;
        }

        public static void Place(RectTransform rt, float x, float y, float w, float h)
        {
            rt.anchoredPosition = new Vector2(x, -y);
            rt.sizeDelta = new Vector2(w, h);
        }

        /// <summary>Stretch to fill the parent.</summary>
        public static RectTransform Fill(Transform parent, string name)
        {
            var go = new GameObject(name, typeof(RectTransform));
            var rt = (RectTransform)go.transform;
            rt.SetParent(parent, false);
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.offsetMin = rt.offsetMax = Vector2.zero;
            return rt;
        }

        /// <summary>Rounded rectangle (radius in px; 0 = square corners).</summary>
        public static Image Panel(Transform parent, string name, float x, float y, float w, float h, Color color, float radius = 16)
        {
            var rt = Box(parent, name, x, y, w, h);
            var img = rt.gameObject.AddComponent<Image>();
            img.color = color;
            img.raycastTarget = false;
            Overlay(img);
            SetRadius(img, radius);
            return img;
        }

        public static void SetRadius(Image img, float radius)
        {
            if (radius <= 0) { img.sprite = null; img.type = Image.Type.Simple; return; }
            img.sprite = Rounded;
            img.type = Image.Type.Sliced;
            img.pixelsPerUnitMultiplier = k_SpriteRadius / radius;
        }

        /// <summary>Soft shadow behind a rect (add it before the rect so it draws underneath).</summary>
        public static Image Shadow(Transform parent, string name, float x, float y, float w, float h, float spread = 24, float alpha = 0.14f, float offsetY = 8)
        {
            var rt = Box(parent, name, x - spread, y - spread + offsetY, w + 2 * spread, h + 2 * spread);
            var img = rt.gameObject.AddComponent<Image>();
            img.sprite = ShadowSprite;
            img.type = Image.Type.Sliced;
            img.pixelsPerUnitMultiplier = k_ShadowInset / spread;
            img.color = new Color(0.16f, 0.12f, 0.08f, alpha);
            img.raycastTarget = false;
            Overlay(img);
            return img;
        }

        public static Image Dot(Transform parent, string name, float x, float y, float size, Color color)
        {
            var rt = Box(parent, name, x, y, size, size);
            var img = rt.gameObject.AddComponent<Image>();
            img.sprite = Circle;
            img.color = color;
            img.raycastTarget = false;
            Overlay(img);
            return img;
        }

        public static Image Hairline(Transform parent, string name, float x, float y, float w) => Panel(parent, name, x, y, w, 2, Theme.Line, 0);

        public static TextMeshProUGUI Text(Transform parent, string name, float x, float y, float w, float h, string text, float size, Color color,
            Face face = Face.Regular, TextAlignmentOptions align = TextAlignmentOptions.TopLeft)
        {
            // TMP hides a line that doesn't fit its box (ellipsis mode), so never make a box shorter than one line.
            // DM Serif's line box is 1.37 em, Inter's 1.21 em.
            h = Mathf.Max(h, size * (face == Face.Serif || face == Face.SerifItalic ? 1.38f : 1.22f) + 1);
            var rt = Box(parent, name, x, y, w, h);
            var t = rt.gameObject.AddComponent<TextMeshProUGUI>();
            t.font = Theme.FontFor(face);
            t.text = text;
            t.fontSize = size;
            t.color = color;
            t.alignment = align;
            t.textWrappingMode = TextWrappingModes.Normal;
            t.overflowMode = TextOverflowModes.Ellipsis;
            t.raycastTarget = false;
            OverlayText(t);
            return t;
        }

        /// <summary>Small letter-spaced capitals above a heading ("CURATED FOR YOUR ROOM").</summary>
        public static TextMeshProUGUI Eyebrow(Transform parent, string name, float x, float y, float w, string text, Color? color = null, float size = 15,
            TextAlignmentOptions align = TextAlignmentOptions.TopLeft)
        {
            var t = Text(parent, name, x, y, w, size + 8, text, size, color ?? Theme.Brass, Face.SemiBold, align);
            t.fontStyle = FontStyles.UpperCase;
            t.characterSpacing = 12;
            t.textWrappingMode = TextWrappingModes.NoWrap;
            return t;
        }

        public static RawImage Picture(Transform parent, string name, float x, float y, float w, float h)
        {
            var rt = Box(parent, name, x, y, w, h);
            var img = rt.gameObject.AddComponent<RawImage>();
            img.color = Theme.Canvas; // placeholder until the texture arrives
            img.raycastTarget = false;
            Overlay(img);
            return img;
        }

        public static UIButton Button(Transform parent, string name, float x, float y, float w, float h, string label, float fontSize, Action onClick,
            ButtonStyle style = ButtonStyle.Secondary)
        {
            var radius = style switch
            {
                ButtonStyle.Card => 18f,
                ButtonStyle.Nav => 12f,
                ButtonStyle.Ghost => 14f,
                _ => h / 2, // pills
            };
            var bg = Panel(parent, name, x, y, w, h, Color.clear, radius);
            if (style == ButtonStyle.Round) { bg.sprite = Circle; bg.type = Image.Type.Simple; }
            var btn = bg.gameObject.AddComponent<UIButton>();
            var face = style == ButtonStyle.Primary || style == ButtonStyle.Visa || style == ButtonStyle.Round ? Face.SemiBold : Face.Medium;
            var txt = Text(bg.transform, "Label", 12, 0, w - 24, h, label, fontSize, Theme.Ink, face, TextAlignmentOptions.Center);
            txt.textWrappingMode = TextWrappingModes.NoWrap;
            btn.Setup(bg, txt, onClick, ColorsFor(style));
            if (style == ButtonStyle.Card) btn.HoverLift = 1;
            return btn;
        }

        public static ButtonColors ColorsFor(ButtonStyle style) => style switch
        {
            ButtonStyle.Primary => new ButtonColors(Theme.Ink, Theme.InkHover, Theme.OnInk, Theme.OnInk),
            ButtonStyle.Visa => new ButtonColors(Theme.VisaNavy, Theme.VisaNavyHover, Color.white, Color.white),
            ButtonStyle.Ghost => new ButtonColors(Theme.Clear, Theme.Sunken, Theme.Muted, Theme.Ink),
            ButtonStyle.Chip => new ButtonColors(Theme.Sunken, Theme.SunkenHover, Theme.Ink, Theme.Ink, Theme.Ink, Theme.OnInk),
            ButtonStyle.Nav => new ButtonColors(Theme.Clear, Theme.WithAlpha(Theme.Sunken, 0.7f), Theme.Muted, Theme.Ink, Theme.Clear, Theme.Ink),
            ButtonStyle.Card => new ButtonColors(Theme.Surface, Theme.SurfaceHover, Theme.Ink, Theme.Ink),
            ButtonStyle.Round => new ButtonColors(Theme.Surface, Theme.Sunken, Theme.Ink, Theme.Ink),
            _ => new ButtonColors(Theme.Sunken, Theme.SunkenHover, Theme.Ink, Theme.Ink),
        };

        /// <summary>Width a single line of text needs in a given face and size (for chips sized to their label).</summary>
        public static float MeasureWidth(TextMeshProUGUI probe, string text)
        {
            var wrap = probe.textWrappingMode;
            probe.textWrappingMode = TextWrappingModes.NoWrap;
            var w = probe.GetPreferredValues(text, 4000, 100).x;
            probe.textWrappingMode = wrap;
            return w;
        }

        /// <summary>Show a texture in a RawImage, fit inside ("contain": studio shots are on white, like the cards).</summary>
        public static void SetPicture(RawImage img, Texture2D tex, bool contain = true)
        {
            if (img == null) return;
            if (tex == null) { img.texture = null; img.color = Theme.Canvas; img.uvRect = new Rect(0, 0, 1, 1); return; }
            img.texture = tex;
            img.color = Color.white;
            var rt = img.rectTransform;
            var boxAspect = rt.rect.width / Mathf.Max(1, rt.rect.height);
            var texAspect = tex.width / (float)Mathf.Max(1, tex.height);
            if (contain)
            {
                // Fit inside by extending uvRect beyond 0..1 (the clamped white edge fills the rest).
                if (texAspect > boxAspect) { var s = texAspect / boxAspect; img.uvRect = new Rect(0, (1 - s) / 2, 1, s); }
                else { var s = boxAspect / texAspect; img.uvRect = new Rect((1 - s) / 2, 0, s, 1); }
            }
            else
            {
                if (texAspect > boxAspect) { var s = boxAspect / texAspect; img.uvRect = new Rect((1 - s) / 2, 0, s, 1); }
                else { var s = texAspect / boxAspect; img.uvRect = new Rect(0, (1 - s) / 2, 1, s); }
            }
        }

        public static string Money(float? v) => v.HasValue ? (v.Value % 1 == 0 ? $"${v.Value:N0}" : $"${v.Value:N2}") : "";

        public static string Price(Api.Product p) => string.IsNullOrEmpty(p.priceText) ? Money(p.price) : p.priceText;

        /// <summary>"living_room" → "Living room".</summary>
        public static string Pretty(string key) => string.IsNullOrEmpty(key) ? "" : char.ToUpper(key[0]) + key.Substring(1).Replace('_', ' ');

        /// <summary>"living room" → "Living Room".</summary>
        public static string TitleCase(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var words = s.Replace('_', ' ').Split(' ');
            for (var i = 0; i < words.Length; i++)
                if (words[i].Length > 0) words[i] = char.ToUpper(words[i][0]) + words[i].Substring(1);
            return string.Join(" ", words);
        }

        /// <summary>"Living room (assumed; no photos provided)" → "living room": the room type as a person would say it.</summary>
        public static string RoomName(string roomType)
        {
            if (string.IsNullOrWhiteSpace(roomType)) return "";
            var s = System.Text.RegularExpressions.Regex.Replace(roomType, @"\s*[\(\[].*?[\)\]]", "").Replace('_', ' ').Trim();
            return s.ToLowerInvariant();
        }

        /// <summary>Server text may contain '&lt;' (e.g. "&lt;= budget"): keep TMP from reading it as a tag.</summary>
        public static string Plain(string t) => string.IsNullOrEmpty(t) ? "" : t.Replace("<", "‹").Replace(">", "›");

        /// <summary>
        /// Place a panel in front of the head, pulled closer if a wall or a piece of real furniture is in the way (checked
        /// across the panel's width, so a corner doesn't slice its edge). With too little room ahead it turns toward the
        /// most open direction instead of sitting inside the wall, where the laser couldn't reach it.
        /// </summary>
        public static void PlaceInFront(Transform panel, float distance, float drop, float maxWallGap = 0.12f, float halfWidth = 0.5f)
        {
            var head = XRInput.Instance != null ? XRInput.Instance.Head : Camera.main.transform;
            var fwd = Vector3.ProjectOnPlane(head.forward, Vector3.up);
            if (fwd.sqrMagnitude < 0.01f) fwd = Vector3.forward;
            fwd.Normalize();
            const float minDistance = 0.4f;
            var room = Clearance(head.position, fwd, distance, halfWidth);
            if (room < minDistance + maxWallGap)
            {
                // Facing a wall up close: the most open direction within ±70 degrees.
                var bestRoom = room;
                for (var a = -70; a <= 70; a += 10)
                {
                    if (a == 0) continue;
                    var dir = Quaternion.Euler(0, a, 0) * fwd;
                    var r = Clearance(head.position, dir, distance, halfWidth) - Mathf.Abs(a) * 0.002f;
                    if (r > bestRoom + 0.05f) { bestRoom = r; fwd = dir; }
                }
                room = Clearance(head.position, fwd, distance, halfWidth);
            }
            distance = Mathf.Clamp(room - maxWallGap, minDistance, distance);
            panel.position = head.position + fwd * distance + Vector3.down * drop;
            panel.rotation = Quaternion.LookRotation(fwd, Vector3.up);
        }

        /// <summary>Free distance ahead (up to <paramref name="distance"/>) before a wall or real furniture, across a panel's width.</summary>
        static float Clearance(Vector3 from, Vector3 fwd, float distance, float halfWidth)
        {
            var right = Vector3.Cross(Vector3.up, fwd).normalized;
            var free = distance + 1f;
            foreach (var side in new[] { 0f, -1f, 1f })
            {
                var origin = from + right * (side * halfWidth * 0.9f);
                foreach (var h in Physics.RaycastAll(new Ray(origin, fwd), distance + 0.3f, ~0, QueryTriggerInteraction.Ignore))
                {
                    if (!h.collider.TryGetComponent<RoomSurface>(out var s) || s.kind == SurfaceKind.Floor) continue;
                    // Real furniture only blocks if it reaches up to the panel (a coffee table doesn't).
                    if (s.kind == SurfaceKind.Object && h.collider.bounds.max.y < from.y - 0.55f) continue;
                    free = Mathf.Min(free, h.distance);
                }
            }
            return free;
        }
    }

    /// <summary>Background / label colors for a button's normal, hovered and selected states.</summary>
    public struct ButtonColors
    {
        public Color bg, bgHover, fg, fgHover, bgSelected, fgSelected;

        public ButtonColors(Color bg, Color bgHover, Color fg, Color fgHover, Color? bgSelected = null, Color? fgSelected = null)
        {
            this.bg = bg; this.bgHover = bgHover; this.fg = fg; this.fgHover = fgHover;
            this.bgSelected = bgSelected ?? bgHover;
            this.fgSelected = fgSelected ?? fgHover;
        }
    }
}
