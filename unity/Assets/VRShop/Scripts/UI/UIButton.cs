using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using VRShop.Input;
using VRShop.Interaction;

namespace VRShop.UI
{
    /// <summary>A laser-clickable UI button (trigger collider sized to its rect).</summary>
    public class UIButton : MonoBehaviour, IPointerTarget
    {
        public Image Background { get; private set; }
        public TextMeshProUGUI Label { get; private set; }
        public bool Interactable { get; set; } = true;
        Action m_OnClick;
        Color m_Normal, m_Hover;
        BoxCollider m_Col;

        public void Setup(Image bg, TextMeshProUGUI label, Action onClick, Color normal, Color hover)
        {
            Background = bg;
            Label = label;
            m_OnClick = onClick;
            m_Normal = normal;
            m_Hover = hover;
            m_Col = gameObject.AddComponent<BoxCollider>();
            m_Col.isTrigger = true;
            Resize();
        }

        public void Resize()
        {
            var rt = (RectTransform)transform;
            var size = rt.rect.size;
            m_Col.size = new Vector3(size.x, size.y, 12f);
            m_Col.center = new Vector3((0.5f - rt.pivot.x) * size.x, (0.5f - rt.pivot.y) * size.y, -2f);
        }

        public void SetOnClick(Action a) => m_OnClick = a;

        public void SetColors(Color normal, Color hover)
        {
            m_Normal = normal;
            m_Hover = hover;
            if (Background != null) Background.color = normal;
        }

        public void SetLabel(string text) { if (Label != null) Label.text = text; }

        public void OnHoverEnter(PointerEvent e) { if (Interactable) Background.color = m_Hover; }
        public void OnHoverExit(PointerEvent e) => Background.color = m_Normal;
        public void OnPress(PointerEvent e) { if (Interactable) Background.color = Color.Lerp(m_Hover, Color.white, 0.25f); }

        public void OnRelease(PointerEvent e, bool clicked)
        {
            Background.color = m_Normal;
            if (!clicked || !Interactable) return;
            XRInput.Instance?.Haptic(e.hand, 0.35f, 0.04f);
            m_OnClick?.Invoke();
        }

        void OnDisable()
        {
            if (Background != null) Background.color = m_Normal;
        }
    }
}
