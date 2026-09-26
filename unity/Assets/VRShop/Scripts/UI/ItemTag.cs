using TMPro;
using UnityEngine;
using UnityEngine.UI;
using VRShop.Api;
using VRShop.Furniture;
using VRShop.Input;

namespace VRShop.UI
{
    /// <summary>Floating label above a placed item: name, price, store, true dimensions, model source, fit warnings.</summary>
    public class ItemTag : MonoBehaviour
    {
        FurnitureItem m_Item;
        TextMeshProUGUI m_Title, m_Line, m_Dims, m_Status;
        Image m_Bg;
        CanvasGroup m_Group;
        bool m_Visible = true;

        public static ItemTag Create(FurnitureItem item)
        {
            var canvas = UIKit.CreateCanvas($"Tag_{item.name}", new Vector2(520, 200), 0.00055f);
            var tag = canvas.gameObject.AddComponent<ItemTag>();
            tag.m_Item = item;
            tag.m_Group = canvas.gameObject.AddComponent<CanvasGroup>();
            tag.m_Bg = UIKit.Panel(canvas.transform, "Bg", 0, 0, 520, 200, new Color(0.06f, 0.07f, 0.09f, 0.9f));
            tag.m_Title = UIKit.Text(tag.m_Bg.transform, "Title", 22, 14, 476, 64, "", 26, UIKit.TextColor, TextAlignmentOptions.TopLeft, FontStyles.Bold);
            tag.m_Line = UIKit.Text(tag.m_Bg.transform, "Line", 22, 80, 476, 34, "", 24, UIKit.Good);
            tag.m_Dims = UIKit.Text(tag.m_Bg.transform, "Dims", 22, 116, 476, 30, "", 20, UIKit.Muted);
            tag.m_Status = UIKit.Text(tag.m_Bg.transform, "Status", 22, 150, 476, 40, "", 19, UIKit.Accent);
            return tag;
        }

        public void Refresh(Product p, Dims d, string status, string warning)
        {
            if (m_Title == null) return;
            m_Title.text = p.title;
            m_Line.text = $"{(string.IsNullOrEmpty(p.priceText) ? UIKit.Money(p.price) : p.priceText)}  •  {p.store}";
            m_Dims.text = d != null ? $"{d.ToCmString()}   ({d.ToInchString()})" : "";
            if (!string.IsNullOrEmpty(warning)) { m_Status.text = warning; m_Status.color = UIKit.Bad; }
            else if (!string.IsNullOrEmpty(status)) { m_Status.text = status; m_Status.color = UIKit.Accent; }
            else { m_Status.text = p.ModelBadge; m_Status.color = UIKit.Muted; }
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
