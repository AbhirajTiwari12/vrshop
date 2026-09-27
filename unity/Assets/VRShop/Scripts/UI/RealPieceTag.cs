using System.Linq;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using VRShop.Api;
using VRShop.Core;
using VRShop.Input;
using VRShop.Interaction;
using VRShop.Room;

namespace VRShop.UI
{
    /// <summary>
    /// Floating card over one of the user's real pieces of furniture: Keep / Replace, its type, Adjust (fix the box);
    /// when replaced, the product standing in for it with ‹ › to try others, add to bag, and "match your room" tones for
    /// the painted-out cover. Shows while the piece (or its replacement) is pointed at, or once it's clicked (pinned).
    /// </summary>
    public class RealPieceTag : MonoBehaviour
    {
        const float W = 620, Pad = 28, CanvasH = 560;

        RealPiece m_Piece;
        CanvasGroup m_Group;
        RectTransform m_Root;
        Image m_Bg, m_Shadow;
        BoxCollider m_Blocker;
        TextMeshProUGUI m_Kicker, m_Title, m_Info;
        UIButton m_Close, m_Keep, m_Replace, m_Adjust, m_Type, m_Prev, m_Next, m_Bag, m_FloorMinus, m_FloorPlus, m_WallMinus, m_WallPlus, m_Done, m_Reset;
        TextMeshProUGUI m_BlendLabel;
        Image m_Line;
        float m_VisibleUntil;
        bool m_Shown = true;
        LaserPointer[] m_Lasers;

        RealFurniture RF => RealFurniture.Instance;

        public static RealPieceTag Create(RealPiece piece)
        {
            var canvas = UIKit.CreateCanvas($"RealTag_{piece.Id}", new Vector2(W + 60, CanvasH), 0.0006f);
            var tag = canvas.gameObject.AddComponent<RealPieceTag>();
            tag.m_Piece = piece;
            tag.m_Group = canvas.gameObject.AddComponent<CanvasGroup>();
            tag.Build(canvas.transform);
            tag.m_Group.alpha = 0;
            tag.SetShown(false);
            tag.Refresh();
            return tag;
        }

        void Build(Transform canvas)
        {
            m_Root = UIKit.Box(canvas, "Root", 30, 30, W, 400);
            m_Shadow = UIKit.Shadow(m_Root, "Shadow", 0, 0, W, 400, 24, 0.22f, 8);
            m_Bg = UIKit.Panel(m_Root, "Bg", 0, 0, W, 400, Theme.Surface, 24);
            PanelBlocker.Add(m_Bg.gameObject, W, 400);
            m_Blocker = m_Bg.GetComponent<BoxCollider>();
            var t = m_Bg.transform;

            m_Kicker = UIKit.Eyebrow(t, "Kicker", Pad, 22, W - 120, "", Theme.Brass, 14);
            m_Close = UIKit.Button(t, "Close", W - 62, 14, 44, 44, "×", 24, () => RF?.Select(null), ButtonStyle.Round);
            m_Title = UIKit.Text(t, "Title", Pad, 48, W - Pad * 2, 72, "", 26, Theme.Ink, Face.Serif);
            m_Info = UIKit.Text(t, "Info", Pad, 124, W - Pad * 2, 50, "", 18, Theme.Muted, Face.Regular);

            m_Keep = UIKit.Button(t, "Keep", Pad, 0, 112, 50, "Keep", 19, () => RF?.Keep(m_Piece), ButtonStyle.Chip);
            m_Replace = UIKit.Button(t, "Replace", Pad + 120, 0, 132, 50, "Replace", 19, () => RF?.Replace(m_Piece), ButtonStyle.Chip);
            m_Adjust = UIKit.Button(t, "Adjust", Pad + 262, 0, 104, 50, "Adjust", 18, () => RF?.BeginAdjust(m_Piece), ButtonStyle.Ghost);
            m_Type = UIKit.Button(t, "Type", W - Pad - 196, 0, 196, 50, "", 17, () => RF?.NextCategory(m_Piece), ButtonStyle.Secondary);

            m_Prev = UIKit.Button(t, "Prev", Pad, 0, 56, 56, "‹", 30, () => RF?.Cycle(m_Piece, -1), ButtonStyle.Round);
            m_Next = UIKit.Button(t, "Next", Pad + 66, 0, 56, 56, "›", 30, () => RF?.Cycle(m_Piece, 1), ButtonStyle.Round);
            m_Bag = UIKit.Button(t, "Bag", Pad + 138, 3, 190, 50, "Add to bag", 18, () => RF?.AddReplacementToBag(m_Piece), ButtonStyle.Secondary);

            m_Line = UIKit.Hairline(t, "Line", Pad, 0, W - Pad * 2);
            m_BlendLabel = UIKit.Eyebrow(t, "BlendLabel", Pad, 0, 220, "Match your room", Theme.Muted, 13);
            m_FloorMinus = UIKit.Button(t, "FloorMinus", Pad, 0, 128, 44, "Floor darker", 15, () => RF?.NudgeTone(true, -0.04f), ButtonStyle.Ghost);
            m_FloorPlus = UIKit.Button(t, "FloorPlus", Pad + 134, 0, 132, 44, "Floor lighter", 15, () => RF?.NudgeTone(true, 0.04f), ButtonStyle.Ghost);
            m_WallMinus = UIKit.Button(t, "WallMinus", Pad + 282, 0, 124, 44, "Wall darker", 15, () => RF?.NudgeTone(false, -0.04f), ButtonStyle.Ghost);
            m_WallPlus = UIKit.Button(t, "WallPlus", Pad + 412, 0, 128, 44, "Wall lighter", 15, () => RF?.NudgeTone(false, 0.04f), ButtonStyle.Ghost);

            m_Done = UIKit.Button(t, "Done", Pad, 0, 150, 50, "Done", 19, () => RF?.EndAdjust(m_Piece, true), ButtonStyle.Primary);
            m_Reset = UIKit.Button(t, "Reset", Pad + 160, 0, 190, 50, "Reset to scan", 18, () => RF?.ResetBox(m_Piece), ButtonStyle.Ghost);
        }

        /// <summary>Re-read the piece's state into the card.</summary>
        public void Refresh()
        {
            if (m_Title == null || m_Piece == null) return;
            var p = m_Piece;
            var item = p.Replacement;
            var product = item != null ? item.Product : null;
            m_Kicker.text = $"Your {p.Name}";

            string title, info;
            if (p.Adjusting)
            {
                title = "Fit the box to your " + p.Name;
                info = "Drag the dots to its edges and top, the dark disc to move it, the thumbstick to turn it.";
            }
            else if (p.Searching)
            {
                title = "Finding replacements…";
                info = $"{UIKit.Pretty(p.Category)} · about the size of your {p.Name}";
            }
            else if (p.IsReplaced && product != null)
            {
                title = product.title;
                var n = p.CandidateIds.Count;
                info = $"{UIKit.Price(product)}  ·  {product.store}" + (n > 1 ? $"  ·  {p.CandidateIndex + 1} of {n}  ·  thumbstick ↑↓" : "");
                if (item.Fit != Furniture.FitState.Ok && !string.IsNullOrEmpty(item.FitMessage)) info = $"<color={Theme.TerracottaHex}>{UIKit.Plain(item.FitMessage)}</color>  ·  {info}";
                else if (!item.ModelLoaded) info = $"Loading the 3D model…  ·  {info}";
            }
            else if (p.IsReplaced)
            {
                title = $"Your {p.Name} is painted out";
                info = p.Message ?? "Try a replacement with ‹ ›, or Keep to bring it back.";
            }
            else
            {
                title = $"Keeping your {p.Name}";
                info = p.Message ?? "New pieces won't overlap it. Replace it to see something new in its place.";
            }
            m_Title.text = UIKit.Plain(title);
            m_Info.text = info;

            m_Keep.Selected = !p.IsReplaced;
            m_Replace.Selected = p.IsReplaced;
            m_Replace.Interactable = !p.Searching;
            m_Type.SetLabel(string.IsNullOrEmpty(p.Category) ? "Pick a type  ›" : $"As {UIKit.Pretty(p.Category).ToLowerInvariant()}  ›");
            m_Type.Interactable = p.Choices != null && p.Choices.Count > 1 && !p.Searching;
            var inBag = product != null && VRShopApp.Instance?.Session != null && VRShopApp.Instance.Session.InCart(product.id);
            m_Bag.SetLabel(inBag ? "In your bag" : "Add to bag");
            m_Bag.Interactable = product != null && !inBag;
            m_Prev.Interactable = m_Next.Interactable = p.CandidateIds.Count > 1 || (p.IsReplaced && product == null && p.CandidateIds.Count > 0);
            Layout();
        }

        void Layout()
        {
            var p = m_Piece;
            float y = 48;
            var titleH = Mathf.Clamp(m_Title.GetPreferredValues(m_Title.text, W - Pad * 2, 0).y, 34, 72);
            UIKit.Place(m_Title.rectTransform, Pad, y, W - Pad * 2, titleH);
            y += titleH + 6;
            var infoH = Mathf.Clamp(m_Info.GetPreferredValues(m_Info.text, W - Pad * 2, 0).y, 24, 76);
            UIKit.Place(m_Info.rectTransform, Pad, y, W - Pad * 2, infoH);
            y += infoH + 18;

            var main = !p.Adjusting;
            foreach (var b in new[] { m_Keep, m_Replace, m_Adjust, m_Type }) b.gameObject.SetActive(main);
            if (main)
            {
                m_Keep.SetRect(Pad, y, 112, 50);
                m_Replace.SetRect(Pad + 120, y, 132, 50);
                m_Adjust.SetRect(Pad + 262, y, 104, 50);
                m_Type.SetRect(W - Pad - 196, y, 196, 50);
                y += 50 + 16;
            }

            var replaced = main && p.IsReplaced && !p.Searching;
            foreach (var b in new[] { m_Prev, m_Next, m_Bag, m_FloorMinus, m_FloorPlus, m_WallMinus, m_WallPlus }) b.gameObject.SetActive(replaced);
            m_BlendLabel.gameObject.SetActive(replaced);
            m_Line.gameObject.SetActive(replaced);
            if (replaced)
            {
                m_Prev.SetRect(Pad, y, 56, 56);
                m_Next.SetRect(Pad + 66, y, 56, 56);
                m_Bag.SetRect(Pad + 138, y + 3, 190, 50);
                y += 56 + 18;
                UIKit.Place(m_Line.rectTransform, Pad, y - 8, W - Pad * 2, 2);
                UIKit.Place(m_BlendLabel.rectTransform, Pad, y + 4, 240, 22);
                y += 28;
                m_FloorMinus.SetRect(Pad, y, 128, 44);
                m_FloorPlus.SetRect(Pad + 134, y, 132, 44);
                m_WallMinus.SetRect(Pad + 282, y, 124, 44);
                m_WallPlus.SetRect(Pad + 412, y, 128, 44);
                y += 44 + 12;
            }

            m_Done.gameObject.SetActive(p.Adjusting);
            m_Reset.gameObject.SetActive(p.Adjusting);
            if (p.Adjusting)
            {
                m_Done.SetRect(Pad, y, 150, 50);
                m_Reset.SetRect(Pad + 160, y, 190, 50);
                m_Reset.Interactable = p.Adjusted;
                y += 50 + 12;
            }

            var h = y + 12;
            UIKit.Place(m_Bg.rectTransform, 0, 0, W, h);
            UIKit.Place(m_Shadow.rectTransform, -24, -24 + 8, W + 48, h + 48);
            m_Blocker.center = new Vector3(W / 2, -h / 2, 4f);
            m_Blocker.size = new Vector3(W, h, 2f);
        }

        void SetShown(bool on)
        {
            m_Shown = on;
            m_Root.gameObject.SetActive(on); // hidden cards must not catch the laser
        }

        void LateUpdate()
        {
            var p = m_Piece;
            if (p == null) { Destroy(gameObject); return; }
            if (m_Lasers == null || m_Lasers.Length == 0) m_Lasers = FindObjectsByType<LaserPointer>(FindObjectsSortMode.None);

            var pointed = p.Hovered;
            foreach (var l in m_Lasers)
            {
                if (l == null || l.Hovered == null) continue;
                if (l.Hovered is Component c && c != null && (c.transform.IsChildOf(transform) || (p.Replacement != null && c.gameObject == p.Replacement.gameObject))) pointed = true;
            }
            if (pointed || p.Pinned || p.Adjusting) m_VisibleUntil = Time.time + 0.45f; // grace to move the laser onto the card
            var visible = Time.time < m_VisibleUntil;
            if (visible && !m_Shown) SetShown(true);
            m_Group.alpha = Mathf.MoveTowards(m_Group.alpha, visible ? 1 : 0, Time.deltaTime * 6);
            if (!visible && m_Shown && m_Group.alpha <= 0.01f) SetShown(false);
            if (!m_Shown) return;

            // Above the piece (or its replacement, whichever is taller), turned toward the user.
            var head = XRInput.Instance != null ? XRInput.Instance.Head : Camera.main.transform;
            var top = p.Top;
            if (p.Replacement != null && p.Replacement.Dims != null) top = Mathf.Max(top, p.Replacement.transform.position.y + p.Replacement.Dims.h);
            var anchor = p.Replacement != null ? p.Replacement.transform.position : p.Center;
            transform.position = new Vector3(anchor.x, top + 0.34f, anchor.z);
            var look = transform.position - head.position;
            look.y = 0;
            if (look.sqrMagnitude > 0.0001f) transform.rotation = Quaternion.LookRotation(look, Vector3.up);
        }
    }
}
