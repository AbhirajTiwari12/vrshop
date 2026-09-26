using TMPro;
using UnityEngine;
using UnityEngine.UI;
using VRShop.Input;

namespace VRShop.UI
{
    /// <summary>Head-locked (lazy-follow) status line for short messages: "Listening…", "Designing your room…".</summary>
    public class Toast : MonoBehaviour
    {
        public static Toast Instance { get; private set; }
        TextMeshProUGUI m_Text;
        Image m_Bg;
        CanvasGroup m_Group;
        float m_Until;
        bool m_Sticky;

        public static void Show(string msg, float seconds = 3f) => Instance?.Set(msg, seconds, false);
        public static void Sticky(string msg) => Instance?.Set(msg, 0, true);
        public static void Hide() { if (Instance != null) { Instance.m_Sticky = false; Instance.m_Until = 0; } }

        void Awake()
        {
            Instance = this;
            var canvas = UIKit.CreateCanvas("ToastCanvas", new Vector2(900, 90), 0.0006f);
            canvas.transform.SetParent(transform, false);
            m_Group = canvas.gameObject.AddComponent<CanvasGroup>();
            m_Bg = UIKit.Panel(canvas.transform, "Bg", 0, 0, 900, 90, new Color(0.06f, 0.07f, 0.09f, 0.92f));
            m_Text = UIKit.Text(m_Bg.transform, "Text", 28, 0, 844, 90, "", 30, UIKit.TextColor, TextAlignmentOptions.Center);
            m_Group.alpha = 0;
        }

        void Set(string msg, float seconds, bool sticky)
        {
            m_Text.text = msg;
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
            // Lazy follow: sit ~0.75 m ahead, a bit below eye level.
            var fwd = Vector3.ProjectOnPlane(head.forward, Vector3.up).normalized;
            if (fwd.sqrMagnitude < 0.01f) fwd = Vector3.forward;
            var target = head.position + fwd * 0.75f + Vector3.down * 0.28f;
            transform.position = Vector3.Lerp(transform.position, target, 1 - Mathf.Exp(-Time.deltaTime * 4));
            transform.rotation = Quaternion.Slerp(transform.rotation, Quaternion.LookRotation(fwd, Vector3.up), 1 - Mathf.Exp(-Time.deltaTime * 4));
        }
    }
}
