using TMPro;
using UnityEngine;
using UnityEngine.UI;
using VRShop.Input;

namespace VRShop.UI
{
    /// <summary>
    /// Small lazy-follow notice for quick confirmations ("Added to your bag", "Cleared 3 items"). Conversation
    /// with the designer goes through the AssistantOrb instead; this sits low and slightly right so the two never
    /// cover each other.
    /// </summary>
    public class Toast : MonoBehaviour
    {
        public static Toast Instance { get; private set; }
        const float W = 640, CanvasH = 260, MinH = 64, MinW = 260;

        TextMeshProUGUI m_Text;
        Image m_Bg, m_Shadow, m_Dot;
        CanvasGroup m_Group;
        float m_Until;
        bool m_Sticky;

        public static void Show(string msg, float seconds = 3f) => Instance?.Set(msg, seconds, false);
        public static void Sticky(string msg) => Instance?.Set(msg, 0, true);
        public static void Hide() { if (Instance != null) { Instance.m_Sticky = false; Instance.m_Until = 0; } }

        void Awake()
        {
            Instance = this;
            var canvas = UIKit.CreateCanvas("ToastCanvas", new Vector2(W, CanvasH), 0.0005f);
            canvas.transform.SetParent(transform, false);
            m_Group = canvas.gameObject.AddComponent<CanvasGroup>();
            m_Shadow = UIKit.Shadow(canvas.transform, "Shadow", 0, 0, W, MinH, 22, 0.2f, 6);
            m_Bg = UIKit.Panel(canvas.transform, "Bg", 0, 0, W, MinH, Theme.Surface, MinH / 2);
            m_Dot = UIKit.Dot(m_Bg.transform, "Dot", 30, 0, 12, Theme.Brass);
            m_Text = UIKit.Text(m_Bg.transform, "Text", 58, 0, W - 92, MinH, "", 22, Theme.Ink, Face.Medium, TextAlignmentOptions.MidlineLeft);
            m_Text.overflowMode = TextOverflowModes.Truncate;
            m_Group.alpha = 0;
        }

        void Set(string msg, float seconds, bool sticky)
        {
            m_Text.text = msg;
            // Hug the message: as wide as one line needs (up to W), taller for longer messages; centered on the anchor.
            var w = Mathf.Clamp(UIKit.MeasureWidth(m_Text, msg) + 92, MinW, W);
            var h = Mathf.Clamp(m_Text.GetPreferredValues(msg, w - 92, 0).y + 30, MinH, CanvasH - 20);
            var x = (W - w) / 2;
            var y = (CanvasH - h) / 2;
            UIKit.Place(m_Bg.rectTransform, x, y, w, h);
            UIKit.Place(m_Shadow.rectTransform, x - 22, y - 22 + 6, w + 44, h + 44);
            UIKit.Place(m_Text.rectTransform, 58, 0, w - 92, h);
            UIKit.Place(m_Dot.rectTransform, 30, h / 2 - 6, 12, 12);
            UIKit.SetRadius(m_Bg, Mathf.Min(h / 2, 28));
            m_Sticky = sticky;
            m_Until = Time.time + seconds;
            Debug.Log($"[VRShop] {msg}");
        }

        void LateUpdate()
        {
            var visible = m_Sticky || Time.time < m_Until;
            m_Group.alpha = Mathf.MoveTowards(m_Group.alpha, visible ? 1 : 0, Time.deltaTime * 4);
            var head = XRInput.Instance != null ? XRInput.Instance.Head : (Camera.main != null ? Camera.main.transform : null);
            if (head == null) return;
            // Lazy follow: ~0.8 m ahead, low and a little right of center.
            var fwd = Vector3.ProjectOnPlane(head.forward, Vector3.up).normalized;
            if (fwd.sqrMagnitude < 0.01f) fwd = Vector3.forward;
            var right = Vector3.Cross(Vector3.up, fwd);
            var target = head.position + fwd * 0.78f + right * 0.12f + Vector3.down * 0.27f;
            var k = 1 - Mathf.Exp(-Time.deltaTime * 4);
            transform.position = Vector3.Lerp(transform.position, target, k);
            transform.rotation = Quaternion.Slerp(transform.rotation, Quaternion.LookRotation(transform.position - head.position, Vector3.up), k);
        }
    }
}
