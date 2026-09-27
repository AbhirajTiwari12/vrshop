using TMPro;
using UnityEngine;
using UnityEngine.UI;
using VRShop.Api;
using VRShop.Furniture;
using VRShop.Input;

namespace VRShop.UI
{
    /// <summary>Floating card above a placed item: name, price, store, true dimensions, model status, fit warnings.</summary>
    public class ItemTag : MonoBehaviour
    {
        const float W = 520, H = 206;

        FurnitureItem m_Item;
        TextMeshProUGUI m_Store, m_Title, m_Price, m_Dims, m_Status;
        Image m_StatusDot;
        CanvasGroup m_Group;
        bool m_Visible = true;

        public static ItemTag Create(FurnitureItem item)
        {
            var canvas = UIKit.CreateCanvas($"Tag_{item.name}", new Vector2(W + 60, H + 60), 0.00055f);
            var tag = canvas.gameObject.AddComponent<ItemTag>();
            tag.m_Item = item;
            tag.m_Group = canvas.gameObject.AddComponent<CanvasGroup>();
            var root = UIKit.Box(canvas.transform, "Root", 30, 30, W, H);
            UIKit.Shadow(root, "Shadow", 0, 0, W, H, 24, 0.22f, 8);
            var bg = UIKit.Panel(root, "Bg", 0, 0, W, H, Theme.Surface, 22);
            var t = bg.transform;
            tag.m_Store = UIKit.Eyebrow(t, "Store", 26, 20, 300, "", Theme.Muted, 14);
            tag.m_Price = UIKit.Text(t, "Price", 300, 10, W - 326, 46, "", 30, Theme.Ink, Face.Serif, TextAlignmentOptions.TopRight);
            tag.m_Title = UIKit.Text(t, "Title", 26, 50, W - 52, 62, "", 23, Theme.Ink, Face.Medium);
            tag.m_Dims = UIKit.Text(t, "Dims", 26, 118, W - 52, 28, "", 18, Theme.Muted);
            UIKit.Hairline(t, "Line", 26, 152, W - 52);
            tag.m_StatusDot = UIKit.Dot(t, "StatusDot", 26, 172, 10, Theme.Brass);
            tag.m_Status = UIKit.Text(t, "Status", 46, 162, W - 72, 30, "", 17, Theme.Muted, Face.Medium, TextAlignmentOptions.MidlineLeft);
            return tag;
        }

        public void Refresh(Product p, Dims d, string status, string warning)
        {
            if (m_Title == null) return;
            m_Store.text = p.store;
            m_Title.text = p.title;
            m_Price.text = UIKit.Price(p);
            m_Dims.text = d != null ? $"{d.ToCmString()}   ·   {d.ToInchString()}" : "";
            string line; Color c;
            if (!string.IsNullOrEmpty(warning)) { line = warning; c = Theme.Terracotta; }
            else if (!string.IsNullOrEmpty(status)) { line = status; c = Theme.Brass; }
            else { line = p.ModelBadge; c = Theme.Sage; }
            m_Status.text = UIKit.Plain(line);
            m_Status.color = !string.IsNullOrEmpty(warning) ? Theme.Terracotta : Theme.Muted;
            m_StatusDot.color = c;
        }

        public void SetVisible(bool v) => m_Visible = v;

        void LateUpdate()
        {
            if (m_Item == null) { Destroy(gameObject); return; }
            m_Group.alpha = Mathf.MoveTowards(m_Group.alpha, m_Visible ? 1 : 0, Time.deltaTime * 5);
            var head = XRInput.Instance != null ? XRInput.Instance.Head : Camera.main.transform;
            var top = m_Item.transform.position + Vector3.up * ((m_Item.Dims?.h ?? 0.6f) + 0.17f);
            if (m_Item.IsWallMounted) top = m_Item.transform.position + m_Item.transform.forward * 0.25f + Vector3.up * ((m_Item.Dims?.h ?? 0.6f) + 0.1f);
            transform.position = top;
            var look = transform.position - head.position;
            look.y = 0;
            if (look.sqrMagnitude > 0.0001f) transform.rotation = Quaternion.LookRotation(look, Vector3.up);
        }
    }
}
