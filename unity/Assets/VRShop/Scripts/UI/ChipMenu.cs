using System;
using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using VRShop.Interaction;

namespace VRShop.UI
{
    /// <summary>
    /// Drop-down list that opens under a filter chip ("Price ⌄" → Under $200 / Under $500 / …). It floats a few
    /// centimeters in front of the panel so the laser hits it first; a transparent scrim behind it closes it when
    /// the user clicks anywhere else on the panel.
    /// </summary>
    public class ChipMenu : MonoBehaviour
    {
        public struct Option
        {
            public string label;
            public string count;     // muted, right after the label ("42")
            public Color? swatch;    // color filters show a dot
            public bool selected;
            public Action pick;
        }

        const int MaxOptions = 14;
        const float ColW = 270, RowH = 46, Pad = 10;

        RectTransform m_Root;
        Image m_Bg, m_Shadow;
        GameObject m_Scrim;
        readonly List<Row> m_Rows = new List<Row>();
        float m_CanvasW, m_CanvasH;

        class Row
        {
            public UIButton button;
            public Image swatch, swatchRing;
            public TextMeshProUGUI check;
            public Action pick;
        }

        public bool IsOpen => m_Root != null && m_Root.gameObject.activeSelf;

        public static ChipMenu Create(Transform canvasRoot, float canvasW, float canvasH)
        {
            var go = new GameObject("ChipMenu", typeof(RectTransform));
            go.transform.SetParent(canvasRoot, false);
            var menu = go.AddComponent<ChipMenu>();
            menu.Build(canvasW, canvasH);
            return menu;
        }

        void Build(float canvasW, float canvasH)
        {
            m_CanvasW = canvasW;
            m_CanvasH = canvasH;
            var rt = (RectTransform)transform;
            rt.anchorMin = rt.anchorMax = new Vector2(0, 1);
            rt.pivot = new Vector2(0, 1);
            rt.anchoredPosition = Vector2.zero;
            rt.sizeDelta = new Vector2(canvasW, canvasH);

            // Scrim: catches clicks on the rest of the panel (in front of the cards, behind the menu).
            m_Scrim = new GameObject("Scrim", typeof(RectTransform));
            m_Scrim.transform.SetParent(transform, false);
            var srt = (RectTransform)m_Scrim.transform;
            srt.anchorMin = srt.anchorMax = new Vector2(0, 1);
            srt.pivot = new Vector2(0, 1);
            srt.anchoredPosition = Vector2.zero;
            var col = m_Scrim.AddComponent<BoxCollider>();
            col.isTrigger = true;
            col.center = new Vector3(canvasW / 2, -canvasH / 2, -24f);
            col.size = new Vector3(canvasW, canvasH, 2f);
            m_Scrim.AddComponent<Scrim>().Menu = this;

            m_Root = UIKit.Box(transform, "Menu", 0, 0, ColW, 100);
            m_Root.anchoredPosition3D = new Vector3(0, 0, -34f);
            m_Shadow = UIKit.Shadow(m_Root, "Shadow", 0, 0, ColW, 100, 26, 0.24f, 10);
            m_Bg = UIKit.Panel(m_Root, "Bg", 0, 0, ColW, 100, Theme.Surface, 18);
            for (var i = 0; i < MaxOptions; i++)
            {
                var r = new Row();
                var row = r;
                r.button = UIKit.Button(m_Root, $"Option{i}", 0, 0, ColW - 2 * Pad, RowH, "", 18, () => Pick(row), ButtonStyle.Ghost);
                r.button.SetColors(new ButtonColors(Theme.Clear, Theme.Sunken, Theme.Ink, Theme.Ink));
                r.button.Label.alignment = TextAlignmentOptions.MidlineLeft;
                r.swatchRing = UIKit.Dot(r.button.transform, "Ring", 14, 13, 20, Theme.Line);
                r.swatch = UIKit.Dot(r.button.transform, "Swatch", 16, 15, 16, Color.white);
                r.check = UIKit.Text(r.button.transform, "Check", 0, 0, 30, RowH, "✓", 20, Theme.Brass, Face.SemiBold, TextAlignmentOptions.Center);
                m_Rows.Add(r);
            }
            Close();
        }

        /// <summary>Open with its top-left at (x, y) canvas pixels, kept inside the canvas.</summary>
        public void Open(float x, float y, IList<Option> options)
        {
            var n = Mathf.Min(options.Count, MaxOptions);
            var cols = n > 7 ? 2 : 1;
            var rows = Mathf.CeilToInt(n / (float)cols);
            var w = cols * ColW;
            var h = rows * RowH + 2 * Pad;
            x = Mathf.Clamp(x, 16, m_CanvasW - w - 16);
            y = Mathf.Min(y, m_CanvasH - h - 16);
            m_Root.anchoredPosition3D = new Vector3(x, -y, -34f);
            m_Root.sizeDelta = new Vector2(w, h);
            UIKit.Place(m_Bg.rectTransform, 0, 0, w, h);
            UIKit.Place(m_Shadow.rectTransform, -26, -26 + 10, w + 52, h + 52);

            for (var i = 0; i < m_Rows.Count; i++)
            {
                var r = m_Rows[i];
                var on = i < n;
                r.button.gameObject.SetActive(on);
                if (!on) continue;
                var o = options[i];
                var col = i / rows;
                var bw = ColW - 2 * Pad;
                r.button.SetRect(Pad + col * ColW, Pad + (i % rows) * RowH, bw, RowH);
                var hasSwatch = o.swatch.HasValue;
                var labelX = hasSwatch ? 46f : 16f;
                UIKit.Place(r.button.Label.rectTransform, labelX, 0, bw - labelX - 36, RowH);
                r.button.SetLabel(string.IsNullOrEmpty(o.count) ? o.label : $"{o.label}  <color={Theme.FaintHex}><size=15>{o.count}</size></color>");
                r.button.Label.font = Theme.FontFor(o.selected ? Face.SemiBold : Face.Regular);
                r.swatch.gameObject.SetActive(hasSwatch);
                r.swatchRing.gameObject.SetActive(hasSwatch);
                if (hasSwatch) r.swatch.color = o.swatch.Value;
                r.check.gameObject.SetActive(o.selected);
                UIKit.Place(r.check.rectTransform, bw - 38, 0, 30, RowH);
                r.pick = o.pick;
            }
            m_Scrim.SetActive(true);
            m_Root.gameObject.SetActive(true);
            m_Root.SetAsLastSibling();
        }

        public void Close()
        {
            if (m_Scrim != null) m_Scrim.SetActive(false);
            if (m_Root != null) m_Root.gameObject.SetActive(false);
        }

        void Pick(Row r)
        {
            Close();
            r.pick?.Invoke();
        }

        class Scrim : MonoBehaviour, IPointerTarget
        {
            public ChipMenu Menu;
            public void OnHoverEnter(PointerEvent e) { }
            public void OnHoverExit(PointerEvent e) { }
            public void OnPress(PointerEvent e) { }
            public void OnRelease(PointerEvent e, bool clicked) { if (clicked) Menu.Close(); }
        }
    }
}
