using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using VRShop.Input;
using VRShop.Interaction;

namespace VRShop.UI
{
    /// <summary>
    /// A laser-clickable UI button (trigger collider sized to its rect) with hover / pressed / selected / disabled
    /// looks. Cards set HoverLift so they rise toward the viewer and grow slightly when pointed at.
    /// </summary>
    public class UIButton : MonoBehaviour, IPointerTarget
    {
        public Image Background { get; private set; }
        public TextMeshProUGUI Label { get; private set; }
        /// <summary>Optional shadow drawn behind the button; it deepens while the button is lifted.</summary>
        public Image Shadow { get; set; }
        /// <summary>0 = flat, 1 = rises 3% toward the viewer on hover.</summary>
        public float HoverLift { get; set; }

        public bool Interactable
        {
            get => m_Interactable;
            set { if (m_Interactable == value) return; m_Interactable = value; if (!value) m_Hover = false; Apply(); }
        }

        public bool Selected
        {
            get => m_Selected;
            set { if (m_Selected == value) return; m_Selected = value; Apply(); }
        }

        Action m_OnClick;
        ButtonColors m_Colors;
        BoxCollider m_Col;
        bool m_Interactable = true, m_Selected, m_Hover, m_Pressed;
        float m_Lift;
        Vector2 m_BasePos;
        float m_ShadowAlpha = -1;

        public void Setup(Image bg, TextMeshProUGUI label, Action onClick, ButtonColors colors)
        {
            Background = bg;
            Label = label;
            m_OnClick = onClick;
            m_Colors = colors;
            m_Col = gameObject.AddComponent<BoxCollider>();
            m_Col.isTrigger = true;
            m_BasePos = ((RectTransform)transform).anchoredPosition;
            Resize();
            Apply();
        }

        public void Resize()
        {
            var rt = (RectTransform)transform;
            var size = rt.rect.size;
            m_Col.size = new Vector3(size.x, size.y, 12f);
            m_Col.center = new Vector3((0.5f - rt.pivot.x) * size.x, (0.5f - rt.pivot.y) * size.y, -2f);
        }

        /// <summary>Move / resize (pixels from the parent's top-left), keeping the collider and label in step.</summary>
        public void SetRect(float x, float y, float w, float h)
        {
            var rt = (RectTransform)transform;
            UIKit.Place(rt, x, y, w, h);
            m_BasePos = rt.anchoredPosition;
            if (Label != null) UIKit.Place(Label.rectTransform, 12, 0, w - 24, h);
            Resize();
        }

        public void SetOnClick(Action a) => m_OnClick = a;

        public void SetColors(ButtonColors c)
        {
            m_Colors = c;
            Apply();
        }

        public void SetLabel(string text) { if (Label != null) Label.text = text; }

        void Apply()
        {
            if (Background == null) return;
            var sel = m_Selected;
            var hot = m_Hover && m_Interactable;
            var bg = sel ? m_Colors.bgSelected : hot ? m_Colors.bgHover : m_Colors.bg;
            var fg = sel ? m_Colors.fgSelected : hot ? m_Colors.fgHover : m_Colors.fg;
            if (m_Pressed && m_Interactable) bg = Color.Lerp(bg, bg.a < 0.05f ? m_Colors.bgHover : Color.black, bg.a < 0.05f ? 1f : 0.08f);
            if (!m_Interactable)
            {
                bg.a *= 0.5f;
                fg.a *= 0.4f;
            }
            Background.color = bg;
            if (Label != null) Label.color = fg;
        }

        void Update()
        {
            if (HoverLift <= 0) return;
            var target = m_Hover && m_Interactable ? 1f : 0f;
            if (Mathf.Approximately(m_Lift, target)) return;
            m_Lift = Mathf.MoveTowards(m_Lift, target, Time.deltaTime * 7f);
            var e = Mathf.SmoothStep(0, 1, m_Lift);
            var s = 1f + 0.03f * HoverLift * e;
            var rt = (RectTransform)transform;
            // Grow around the center (the rect's pivot is its top-left corner) and rise toward the viewer.
            var size = rt.rect.size;
            rt.localScale = new Vector3(s, s, 1);
            rt.anchoredPosition3D = new Vector3(m_BasePos.x - size.x * (s - 1) / 2, m_BasePos.y + size.y * (s - 1) / 2, -14f * HoverLift * e);
            if (Shadow != null)
            {
                if (m_ShadowAlpha < 0) m_ShadowAlpha = Shadow.color.a;
                var c = Shadow.color;
                c.a = m_ShadowAlpha * (1 + 1.2f * e);
                Shadow.color = c;
            }
        }

        public void OnHoverEnter(PointerEvent e) { m_Hover = true; Apply(); }
        public void OnHoverExit(PointerEvent e) { m_Hover = false; m_Pressed = false; Apply(); }
        public void OnPress(PointerEvent e) { m_Pressed = true; Apply(); }

        public void OnRelease(PointerEvent e, bool clicked)
        {
            m_Pressed = false;
            Apply();
            if (!clicked || !m_Interactable) return;
            XRInput.Instance?.Haptic(e.hand, 0.35f, 0.04f);
            m_OnClick?.Invoke();
        }

        void OnDisable()
        {
            m_Hover = m_Pressed = false;
            m_Lift = 0;
            if (HoverLift > 0 && transform is RectTransform rt)
            {
                rt.localScale = Vector3.one;
                rt.anchoredPosition3D = new Vector3(m_BasePos.x, m_BasePos.y, 0);
                if (Shadow != null && m_ShadowAlpha >= 0) Shadow.color = Theme.WithAlpha(Shadow.color, m_ShadowAlpha);
            }
            Apply();
        }
    }
}
