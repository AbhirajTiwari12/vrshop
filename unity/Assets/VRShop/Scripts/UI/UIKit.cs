using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using VRShop.Input;
using VRShop.Interaction;

namespace VRShop.UI
{
    /// <summary>
    /// Code-built world-space UI (no prefabs to wire up in the editor). Coordinates are pixels from the
    /// top-left of the parent; a canvas maps pixels to meters with its scale.
    /// </summary>
    public static class UIKit
    {
        public static readonly Color Bg = new Color(0.075f, 0.08f, 0.1f, 0.94f);
        public static readonly Color Card = new Color(0.15f, 0.16f, 0.19f, 1f);
        public static readonly Color CardHover = new Color(0.22f, 0.24f, 0.29f, 1f);
        public static readonly Color ButtonBg = new Color(0.2f, 0.215f, 0.25f, 1f);
        public static readonly Color ButtonBgHover = new Color(0.3f, 0.32f, 0.37f, 1f);
        public static readonly Color Accent = new Color(0.33f, 0.6f, 1f, 1f);
        public static readonly Color AccentHover = new Color(0.45f, 0.7f, 1f, 1f);
        public static readonly Color TextColor = new Color(0.96f, 0.97f, 0.98f, 1f);
        public static readonly Color Muted = new Color(0.66f, 0.69f, 0.74f, 1f);
        public static readonly Color Good = new Color(0.4f, 0.88f, 0.58f, 1f);
        public static readonly Color Warn = new Color(1f, 0.72f, 0.3f, 1f);
        public static readonly Color Bad = new Color(1f, 0.42f, 0.38f, 1f);

        static Sprite s_Rounded;

        /// <summary>9-sliced white rounded rectangle generated at runtime (no texture assets needed).</summary>
        public static Sprite Rounded
        {
            get
            {
                if (s_Rounded != null) return s_Rounded;
                const int n = 64, r = 18;
                var tex = new Texture2D(n, n, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear, name = "Rounded" };
                var px = new Color32[n * n];
                for (var y = 0; y < n; y++)
                for (var x = 0; x < n; x++)
                {
                    var cx = Mathf.Clamp(x + 0.5f, r, n - r);
                    var cy = Mathf.Clamp(y + 0.5f, r, n - r);
                    var d = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(cx, cy));
                    var a = Mathf.Clamp01(r - d + 0.5f);
                    px[y * n + x] = new Color32(255, 255, 255, (byte)(a * 255));
                }
                tex.SetPixels32(px);
                tex.Apply(false, true);
                s_Rounded = Sprite.Create(tex, new UnityEngine.Rect(0, 0, n, n), new Vector2(0.5f, 0.5f), 100, 0, SpriteMeshType.FullRect, new Vector4(r + 2, r + 2, r + 2, r + 2));
                return s_Rounded;
            }
        }

        public static Canvas CreateCanvas(string name, Vector2 sizePx, float metersPerPx)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(Canvas));
            var canvas = go.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            var rt = (RectTransform)go.transform;
            rt.sizeDelta = sizePx;
            rt.pivot = new Vector2(0.5f, 0.5f);
            go.transform.localScale = Vector3.one * metersPerPx;
            var scaler = go.AddComponent<CanvasScaler>();
            scaler.dynamicPixelsPerUnit = 2;
            return canvas;
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

        public static Image Panel(Transform parent, string name, float x, float y, float w, float h, Color color, bool rounded = true)
        {
            var rt = Box(parent, name, x, y, w, h);
            var img = rt.gameObject.AddComponent<Image>();
            img.color = color;
            img.raycastTarget = false;
            if (rounded)
            {
                img.sprite = Rounded;
                img.type = UnityEngine.UI.Image.Type.Sliced;
            }
            return img;
        }

        public static TextMeshProUGUI Text(Transform parent, string name, float x, float y, float w, float h, string text, float size, Color color,
            TextAlignmentOptions align = TextAlignmentOptions.TopLeft, FontStyles style = FontStyles.Normal)
        {
            var rt = Box(parent, name, x, y, w, h);
            var t = rt.gameObject.AddComponent<TextMeshProUGUI>();
            t.text = text;
            t.fontSize = size;
            t.color = color;
            t.alignment = align;
            t.fontStyle = style;
            t.textWrappingMode = TextWrappingModes.Normal;
            t.overflowMode = TextOverflowModes.Ellipsis;
            t.raycastTarget = false;
            return t;
        }

        public static RawImage Picture(Transform parent, string name, float x, float y, float w, float h)
        {
            var rt = Box(parent, name, x, y, w, h);
            var img = rt.gameObject.AddComponent<RawImage>();
            img.color = new Color(1, 1, 1, 0.08f); // placeholder until the texture arrives
            img.raycastTarget = false;
            return img;
        }

        public static UIButton Button(Transform parent, string name, float x, float y, float w, float h, string label, float fontSize, Action onClick, bool accent = false)
        {
            var bg = Panel(parent, name, x, y, w, h, accent ? Accent : ButtonBg);
            var btn = bg.gameObject.AddComponent<UIButton>();
            var txt = Text(bg.transform, "Label", 8, 0, w - 16, h, label, fontSize, TextColor, TextAlignmentOptions.Center, FontStyles.Bold);
            btn.Setup(bg, txt, onClick, accent ? Accent : ButtonBg, accent ? AccentHover : ButtonBgHover);
            return btn;
        }

        /// <summary>Show a texture in a RawImage, cropped to fill (like CSS object-fit: cover... but "contain" for product shots).</summary>
        public static void SetPicture(RawImage img, Texture2D tex, bool contain = true)
        {
            if (img == null) return;
            if (tex == null) { img.texture = null; img.color = new Color(1, 1, 1, 0.08f); return; }
            img.texture = tex;
            img.color = Color.white;
            var rt = img.rectTransform;
            var boxAspect = rt.rect.width / Mathf.Max(1, rt.rect.height);
            var texAspect = tex.width / (float)Mathf.Max(1, tex.height);
            if (contain)
            {
                // Fit inside by adjusting uvRect beyond 0..1 (clamped texture shows edge color: studio shots are white).
                if (texAspect > boxAspect) { var s = texAspect / boxAspect; img.uvRect = new UnityEngine.Rect(0, (1 - s) / 2, 1, s); }
                else { var s = boxAspect / texAspect; img.uvRect = new UnityEngine.Rect((1 - s) / 2, 0, s, 1); }
            }
            else
            {
                if (texAspect > boxAspect) { var s = boxAspect / texAspect; img.uvRect = new UnityEngine.Rect((1 - s) / 2, 0, s, 1); }
                else { var s = texAspect / boxAspect; img.uvRect = new UnityEngine.Rect(0, (1 - s) / 2, 1, s); }
            }
        }

        public static string Money(float? v) => v.HasValue ? (v.Value % 1 == 0 ? $"${v.Value:N0}" : $"${v.Value:N2}") : "";

        /// <summary>Place a panel in front of the head, pulled closer if a real wall is in the way.</summary>
        public static void PlaceInFront(Transform panel, float distance, float drop, float maxWallGap = 0.12f)
        {
            var head = XRInput.Instance != null ? XRInput.Instance.Head : Camera.main.transform;
            var fwd = Vector3.ProjectOnPlane(head.forward, Vector3.up);
            if (fwd.sqrMagnitude < 0.01f) fwd = Vector3.forward;
            fwd.Normalize();
            var hits = Physics.RaycastAll(new Ray(head.position, fwd), distance + 0.3f, ~0, QueryTriggerInteraction.Ignore);
            foreach (var h in hits)
            {
                if (h.collider.TryGetComponent<RoomSurface>(out var s) && s.kind == SurfaceKind.Wall)
                    distance = Mathf.Min(distance, Mathf.Max(0.45f, h.distance - maxWallGap));
            }
            panel.position = head.position + fwd * distance + Vector3.down * drop;
            panel.rotation = Quaternion.LookRotation(fwd, Vector3.up);
        }
    }
}
