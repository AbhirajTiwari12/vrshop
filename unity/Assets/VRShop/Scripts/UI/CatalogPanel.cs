using System.Collections.Generic;
using System.Linq;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using VRShop.Api;
using VRShop.Core;
using VRShop.Furniture;
using VRShop.Input;
using VRShop.Rendering;

namespace VRShop.UI
{
    /// <summary>
    /// The in-headset store: room summary, AI-recommended categories as tabs, a 3x2 grid of real products
    /// (photo, store, price, rating, 3D-model source), a detail view with Place / Add to cart, and the cart
    /// with budget tracking. Summon / hide with A.
    /// </summary>
    public class CatalogPanel : MonoBehaviour
    {
        public static CatalogPanel Instance { get; private set; }

        const float W = 1280, H = 820, Scale = 0.00075f; // 0.96 m x 0.62 m
        const int PerPage = 6, TabsPerPage = 5;

        Canvas m_Canvas;
        CanvasGroup m_Group;
        TextMeshProUGUI m_Title, m_Summary, m_CartSummary, m_Stage, m_Tags, m_PageLabel, m_Hint;
        readonly List<Image> m_Swatches = new List<Image>();
        readonly List<UIButton> m_Tabs = new List<UIButton>();
        UIButton m_TabPrev, m_TabNext, m_CartTab, m_Prev, m_Next, m_Design, m_Mode;
        RectTransform m_Grid, m_Detail, m_CartView, m_Message;
        TextMeshProUGUI m_MessageText;
        readonly List<Card> m_Cards = new List<Card>();
        readonly List<CartRow> m_CartRows = new List<CartRow>();

        // detail widgets
        RawImage m_DImage;
        TextMeshProUGUI m_DTitle, m_DStore, m_DPrice, m_DRating, m_DDims, m_DBadge, m_DWhy;
        UIButton m_DPlace, m_DCart;
        TextMeshProUGUI m_CartTotal, m_CartNote;
        Image m_BudgetBar, m_BudgetFill;

        string m_Category;           // selected category key, or "__cart"
        int m_TabPage, m_Page;
        Product m_DetailProduct;
        bool m_Visible = true;

        Session S => VRShopApp.Instance != null ? VRShopApp.Instance.Session : null;
        ApiClient Api => VRShopApp.Instance.Api;

        class Card
        {
            public UIButton button;
            public RawImage image;
            public TextMeshProUGUI title, store, price, rating, badge;
            public string productId;
        }

        class CartRow
        {
            public RectTransform root;
            public RawImage image;
            public TextMeshProUGUI title, meta;
            public UIButton place, remove;
            public string productId;
        }

        void Awake()
        {
            Instance = this;
            Build();
            ShowMessage("Connecting to VRShop…");
        }

        void Start()
        {
            UIKit.PlaceInFront(transform, 0.95f, 0.12f);
            if (VRShopApp.Instance != null) VRShopApp.Instance.SessionChanged += _ => Refresh();
            if (PassthroughController.Instance != null) PassthroughController.Instance.ModeChanged += _ => RefreshFooter();
        }

        void Update()
        {
            var input = XRInput.Instance;
            if (input != null && input.Down(Btn.A)) Toggle();
            m_Group.alpha = Mathf.MoveTowards(m_Group.alpha, m_Visible ? 1 : 0, Time.deltaTime * 6);
            // live model progress on the detail view / cards
            if (m_Visible && Time.frameCount % 20 == 0) RefreshBadges();
        }

        public void Toggle()
        {
            if (m_Visible && IsInView()) Hide();
            else Show();
        }

        public void Show()
        {
            m_Visible = true;
            m_Canvas.gameObject.SetActive(true);
            UIKit.PlaceInFront(transform, 0.95f, 0.12f);
        }

        public void Hide()
        {
            m_Visible = false;
            m_Canvas.gameObject.SetActive(false);
        }

        bool IsInView()
        {
            var head = XRInput.Instance.Head;
            var to = (transform.position - head.position).normalized;
            return Vector3.Dot(head.forward, to) > 0.6f;
        }

        // ------------------------------------------------------------------ build
        void Build()
        {
            m_Canvas = UIKit.CreateCanvas("CatalogCanvas", new Vector2(W, H), Scale);
            m_Canvas.transform.SetParent(transform, false);
            m_Group = m_Canvas.gameObject.AddComponent<CanvasGroup>();
            var root = m_Canvas.transform;
            UIKit.Panel(root, "Background", 0, 0, W, H, UIKit.Bg);

            // Header
            m_Title = UIKit.Text(root, "Title", 36, 26, 820, 52, "VRShop", 40, UIKit.TextColor, TextAlignmentOptions.TopLeft, FontStyles.Bold);
            m_Summary = UIKit.Text(root, "Summary", 36, 80, 820, 58, "", 21, UIKit.Muted);
            m_CartSummary = UIKit.Text(root, "CartSummary", 880, 28, 364, 40, "", 26, UIKit.TextColor, TextAlignmentOptions.TopRight, FontStyles.Bold);
            m_Stage = UIKit.Text(root, "Stage", 880, 72, 364, 60, "", 20, UIKit.Accent, TextAlignmentOptions.TopRight);
            for (var i = 0; i < 6; i++)
            {
                var sw = UIKit.Panel(root, $"Swatch{i}", 36 + i * 34, 142, 26, 26, Color.clear);
                m_Swatches.Add(sw);
            }
            m_Tags = UIKit.Text(root, "Tags", 250, 142, 900, 30, "", 19, UIKit.Muted);

            // Tabs
            m_TabPrev = UIKit.Button(root, "TabPrev", 36, 186, 56, 52, "<", 26, () => { m_TabPage = Mathf.Max(0, m_TabPage - 1); RefreshTabs(); });
            for (var i = 0; i < TabsPerPage; i++)
            {
                var idx = i;
                m_Tabs.Add(UIKit.Button(root, $"Tab{i}", 100 + i * 188, 186, 180, 52, "", 20, () => SelectTab(idx)));
            }
            m_TabNext = UIKit.Button(root, "TabNext", 1044, 186, 56, 52, ">", 26, () => { m_TabPage++; RefreshTabs(); });
            m_CartTab = UIKit.Button(root, "CartTab", 1108, 186, 136, 52, "Cart", 21, () => { m_Category = "__cart"; m_Page = 0; m_DetailProduct = null; RefreshContent(); RefreshTabs(); });

            // Content: grid
            m_Grid = UIKit.Box(root, "Grid", 0, 0, W, H);
            for (var i = 0; i < PerPage; i++)
            {
                var col = i % 3; var row = i / 3;
                var x = 36 + col * (392 + 16); var y = 254 + row * (222 + 14);
                var idx = i;
                var btn = UIKit.Button(m_Grid, $"Card{i}", x, y, 392, 222, "", 1, () => OpenCard(idx));
                btn.SetColors(UIKit.Card, UIKit.CardHover);
                btn.Label.gameObject.SetActive(false);
                var c = new Card { button = btn };
                var t = btn.transform;
                c.image = UIKit.Picture(t, "Image", 12, 12, 190, 198);
                c.title = UIKit.Text(t, "Title", 214, 12, 166, 84, "", 20, UIKit.TextColor, TextAlignmentOptions.TopLeft, FontStyles.Bold);
                c.store = UIKit.Text(t, "Store", 214, 98, 166, 26, "", 17, UIKit.Muted);
                c.price = UIKit.Text(t, "Price", 214, 124, 166, 38, "", 28, UIKit.TextColor, TextAlignmentOptions.TopLeft, FontStyles.Bold);
                c.rating = UIKit.Text(t, "Rating", 214, 162, 166, 24, "", 16, UIKit.Muted);
                c.badge = UIKit.Text(t, "Badge", 214, 186, 166, 26, "", 15, UIKit.Accent);
                m_Cards.Add(c);
            }

            // Content: detail
            m_Detail = UIKit.Box(root, "Detail", 36, 254, 1208, 458);
            UIKit.Panel(m_Detail, "Bg", 0, 0, 1208, 458, UIKit.Card);
            m_DImage = UIKit.Picture(m_Detail, "Image", 16, 16, 426, 426);
            m_DTitle = UIKit.Text(m_Detail, "Title", 466, 18, 720, 92, "", 32, UIKit.TextColor, TextAlignmentOptions.TopLeft, FontStyles.Bold);
            m_DStore = UIKit.Text(m_Detail, "Store", 466, 112, 720, 30, "", 22, UIKit.Muted);
            m_DPrice = UIKit.Text(m_Detail, "Price", 466, 146, 360, 58, "", 46, UIKit.TextColor, TextAlignmentOptions.TopLeft, FontStyles.Bold);
            m_DRating = UIKit.Text(m_Detail, "Rating", 830, 160, 356, 36, "", 22, UIKit.Muted, TextAlignmentOptions.TopRight);
            m_DDims = UIKit.Text(m_Detail, "Dims", 466, 210, 720, 30, "", 21, UIKit.TextColor);
            m_DBadge = UIKit.Text(m_Detail, "Badge", 466, 244, 720, 28, "", 19, UIKit.Accent);
            m_DWhy = UIKit.Text(m_Detail, "Why", 466, 276, 720, 76, "", 20, UIKit.Muted, TextAlignmentOptions.TopLeft, FontStyles.Italic);
            m_DPlace = UIKit.Button(m_Detail, "Place", 466, 366, 290, 72, "Place in my room", 24, PlaceDetail, true);
            m_DCart = UIKit.Button(m_Detail, "Cart", 770, 366, 230, 72, "Add to cart", 22, ToggleDetailCart);
            UIKit.Button(m_Detail, "Back", 1014, 366, 172, 72, "Back", 22, () => { m_DetailProduct = null; RefreshContent(); });

            // Content: cart
            m_CartView = UIKit.Box(root, "CartView", 36, 254, 1208, 458);
            for (var i = 0; i < 5; i++)
            {
                var y = i * 90;
                var r = new CartRow { root = UIKit.Box(m_CartView, $"Row{i}", 0, y, 800, 84) };
                UIKit.Panel(r.root, "Bg", 0, 0, 800, 84, UIKit.Card);
                r.image = UIKit.Picture(r.root, "Image", 8, 6, 72, 72);
                r.title = UIKit.Text(r.root, "Title", 94, 8, 440, 34, "", 20, UIKit.TextColor, TextAlignmentOptions.TopLeft, FontStyles.Bold);
                r.meta = UIKit.Text(r.root, "Meta", 94, 44, 440, 30, "", 18, UIKit.Muted);
                var row = r;
                r.place = UIKit.Button(r.root, "Place", 546, 14, 120, 56, "Place", 18, () => PlaceProduct(row.productId));
                r.remove = UIKit.Button(r.root, "Remove", 674, 14, 118, 56, "Remove", 18, () => SetCart(row.productId, 0));
                m_CartRows.Add(r);
            }
            UIKit.Panel(m_CartView, "SummaryBg", 820, 0, 388, 444, UIKit.Card);
            m_CartTotal = UIKit.Text(m_CartView, "Total", 844, 22, 344, 110, "", 30, UIKit.TextColor, TextAlignmentOptions.TopLeft, FontStyles.Bold);
            m_BudgetBar = UIKit.Panel(m_CartView, "BudgetBar", 844, 142, 340, 18, new Color(1, 1, 1, 0.12f));
            m_BudgetFill = UIKit.Panel(m_BudgetBar.transform, "Fill", 0, 0, 0, 18, UIKit.Good);
            m_CartNote = UIKit.Text(m_CartView, "Note", 844, 176, 344, 250, "", 18, UIKit.Muted);

            // Content: message (loading / errors)
            m_Message = UIKit.Box(root, "Message", 36, 254, 1208, 458);
            UIKit.Panel(m_Message, "Bg", 0, 0, 1208, 458, UIKit.Card);
            m_MessageText = UIKit.Text(m_Message, "Text", 60, 60, 1088, 338, "", 34, UIKit.TextColor, TextAlignmentOptions.Center);

            // Footer
            m_Prev = UIKit.Button(root, "Prev", 36, 730, 120, 60, "< Prev", 20, () => { m_Page = Mathf.Max(0, m_Page - 1); RefreshContent(); });
            m_PageLabel = UIKit.Text(root, "Page", 160, 730, 110, 60, "", 20, UIKit.Muted, TextAlignmentOptions.Center);
            m_Next = UIKit.Button(root, "Next", 274, 730, 120, 60, "Next >", 20, () => { m_Page++; RefreshContent(); });
            m_Design = UIKit.Button(root, "Design", 470, 730, 330, 60, "Design my room", 24, () => VRShopApp.Instance.DesignMyRoom(), true);
            m_Mode = UIKit.Button(root, "Mode", 816, 730, 220, 60, "Virtual room", 20, () => PassthroughController.Instance?.Toggle());
            UIKit.Button(root, "Hide", 1052, 730, 192, 60, "Hide  (A)", 20, Hide);
            m_Hint = UIKit.Text(root, "Hint", 36, 794, 1208, 24, "Hold X and say what you want  •  Trigger: select / drag  •  Stick: rotate  •  B: delete  •  Y: passthrough / virtual room", 16, UIKit.Muted, TextAlignmentOptions.Center);

            SetContent(m_Message);
        }

        void SetContent(RectTransform which)
        {
            m_Grid.gameObject.SetActive(which == m_Grid);
            m_Detail.gameObject.SetActive(which == m_Detail);
            m_CartView.gameObject.SetActive(which == m_CartView);
            m_Message.gameObject.SetActive(which == m_Message);
            var paged = which == m_Grid || which == m_CartView;
            m_Prev.gameObject.SetActive(paged);
            m_Next.gameObject.SetActive(paged);
            m_PageLabel.gameObject.SetActive(paged);
        }

        public void ShowMessage(string text)
        {
            if (m_MessageText == null) return;
            m_MessageText.text = text;
            SetContent(m_Message);
        }

        // ------------------------------------------------------------------ refresh
        public void Refresh()
        {
            var s = S;
            if (s == null) return;
            var room = s.room;
            m_Title.text = room != null ? $"Your {room.roomType}" : "Your room";
            m_Summary.text = room?.summary ?? (string.IsNullOrEmpty(s.prompt) ? "" : s.prompt);
            m_Tags.text = room != null ? string.Join("  •  ", room.styleTags.Take(5)) : "";
            for (var i = 0; i < m_Swatches.Count; i++)
            {
                var has = room?.palette != null && i < room.palette.Count;
                m_Swatches[i].color = has ? VRShopMaterials.Hex(room.palette[i].hex, Color.clear) : Color.clear;
            }
            var cartCount = s.cart?.Sum(c => c.qty) ?? 0;
            m_CartSummary.text = s.budget.HasValue ? $"Cart {cartCount}  •  {UIKit.Money(s.cartTotal)} / {UIKit.Money(s.budget)}" : $"Cart {cartCount}  •  {UIKit.Money(s.cartTotal)}";
            m_Stage.text = s.status == "ready" ? "" : s.status == "error" ? $"Error: {s.error}" : s.stage;

            if (s.categories == null || s.categories.Count == 0)
            {
                ShowMessage(s.status == "error" ? $"Something went wrong:\n{s.error}" : $"{s.stage}\n\n<size=24><color=#A9B0BC>Finding real furniture that fits your room…</color></size>");
                RefreshTabs();
                RefreshFooter();
                return;
            }
            if (m_Category == null || (m_Category != "__cart" && s.categories.All(c => c.category != m_Category)))
            {
                m_Category = s.categories[0].category;
                m_Page = 0;
            }
            RefreshTabs();
            RefreshContent();
            RefreshFooter();
        }

        void RefreshTabs()
        {
            var cats = S?.categories ?? new List<CategoryResult>();
            var pages = Mathf.Max(1, Mathf.CeilToInt(cats.Count / (float)TabsPerPage));
            m_TabPage = Mathf.Clamp(m_TabPage, 0, pages - 1);
            for (var i = 0; i < TabsPerPage; i++)
            {
                var ci = m_TabPage * TabsPerPage + i;
                var tab = m_Tabs[i];
                tab.gameObject.SetActive(ci < cats.Count);
                if (ci >= cats.Count) continue;
                var c = cats[ci];
                tab.SetLabel(c.origin == "voice" ? $"\"{c.label}\"" : c.label);
                var sel = c.category == m_Category;
                tab.SetColors(sel ? UIKit.Accent : UIKit.ButtonBg, sel ? UIKit.AccentHover : UIKit.ButtonBgHover);
            }
            m_TabPrev.gameObject.SetActive(m_TabPage > 0);
            m_TabNext.gameObject.SetActive(m_TabPage < pages - 1);
            var cartSel = m_Category == "__cart";
            m_CartTab.SetLabel($"Cart ({S?.cart?.Sum(c => c.qty) ?? 0})");
            m_CartTab.SetColors(cartSel ? UIKit.Accent : UIKit.ButtonBg, cartSel ? UIKit.AccentHover : UIKit.ButtonBgHover);
        }

        void SelectTab(int i)
        {
            var cats = S?.categories;
            var ci = m_TabPage * TabsPerPage + i;
            if (cats == null || ci >= cats.Count) return;
            m_Category = cats[ci].category;
            m_Page = 0;
            m_DetailProduct = null;
            RefreshTabs();
            RefreshContent();
        }

        /// <summary>Jump to a category (e.g. after a voice search).</summary>
        public void Focus(string category)
        {
            var cats = S?.categories;
            if (cats == null) return;
            var idx = cats.FindIndex(c => c.category == category);
            if (idx < 0) return;
            m_Category = category;
            m_TabPage = idx / TabsPerPage;
            m_Page = 0;
            m_DetailProduct = null;
            Show();
            RefreshTabs();
            RefreshContent();
        }

        void RefreshContent()
        {
            var s = S;
            if (s == null) return;
            if (m_DetailProduct != null) { ShowDetail(m_DetailProduct); return; }
            if (m_Category == "__cart") { ShowCart(); return; }
            var cat = s.categories.FirstOrDefault(c => c.category == m_Category);
            if (cat == null) return;
            SetContent(m_Grid);
            var ids = cat.productIds;
            var pages = Mathf.Max(1, Mathf.CeilToInt(ids.Count / (float)PerPage));
            m_Page = Mathf.Clamp(m_Page, 0, pages - 1);
            m_PageLabel.text = $"{m_Page + 1} / {pages}";
            m_Prev.Interactable = m_Page > 0;
            m_Next.Interactable = m_Page < pages - 1;
            for (var i = 0; i < PerPage; i++)
            {
                var idx = m_Page * PerPage + i;
                var card = m_Cards[i];
                var p = idx < ids.Count ? s.GetProduct(ids[idx]) : null;
                card.button.gameObject.SetActive(p != null);
                if (p == null) continue;
                var changed = card.productId != p.id;
                card.productId = p.id;
                card.title.text = p.title;
                card.store.text = p.store;
                card.price.text = string.IsNullOrEmpty(p.priceText) ? UIKit.Money(p.price) : p.priceText;
                card.rating.text = p.rating.HasValue ? $"{p.rating:0.0} / 5  ({(p.reviews ?? 0):N0})" : "";
                card.badge.text = (s.InCart(p.id) ? "In cart  •  " : "") + p.ModelBadge;
                if (changed) LoadImage(card.image, p, () => card.productId == p.id);
            }
        }

        void RefreshBadges()
        {
            var s = S;
            if (s == null) return;
            if (m_DetailProduct != null && m_Detail.gameObject.activeSelf)
            {
                var p = s.GetProduct(m_DetailProduct.id) ?? m_DetailProduct;
                m_DBadge.text = p.ModelBadge;
            }
        }

        async void LoadImage(RawImage img, Product p, System.Func<bool> stillValid)
        {
            UIKit.SetPicture(img, null);
            var tex = await TextureCache.Get(Api.ImageUrl(p.imageUrl, 384));
            if (img != null && stillValid()) UIKit.SetPicture(img, tex);
        }

        // ------------------------------------------------------------------ detail
        void OpenCard(int i)
        {
            var id = m_Cards[i].productId;
            var p = S?.GetProduct(id);
            if (p == null) return;
            m_DetailProduct = p;
            ShowDetail(p);
            // Warm up the 3D model as soon as the user looks at a product (IKEA models are free & fast).
            if (!p.model.IsReady && !p.model.IsBusy) _ = Api.EnsureModel(p.id, p.source == "ikea");
        }

        void ShowDetail(Product p)
        {
            p = S?.GetProduct(p.id) ?? p;
            SetContent(m_Detail);
            m_DTitle.text = p.title;
            m_DStore.text = string.IsNullOrEmpty(p.brand) || p.brand == p.store ? p.store : $"{p.brand}  •  {p.store}";
            m_DPrice.text = string.IsNullOrEmpty(p.priceText) ? UIKit.Money(p.price) : p.priceText;
            m_DRating.text = p.rating.HasValue ? $"{p.rating:0.0} / 5  ({(p.reviews ?? 0):N0} reviews)" : "";
            m_DDims.text = p.dims != null ? $"{p.dims.ToCmString()}   ({p.dims.ToInchString()})" + (p.dimsSource == "estimated" ? "  • estimated" : "") : "Size: measured when the 3D model loads";
            m_DBadge.text = p.ModelBadge;
            m_DWhy.text = string.IsNullOrEmpty(p.why) ? "" : $"Why it fits: {p.why}";
            var inCart = S != null && S.InCart(p.id);
            m_DCart.SetLabel(inCart ? "Remove from cart" : "Add to cart");
            LoadImage(m_DImage, p, () => m_DetailProduct != null && m_DetailProduct.id == p.id);
        }

        void PlaceDetail()
        {
            if (m_DetailProduct == null) return;
            PlaceProduct(m_DetailProduct.id);
        }

        void PlaceProduct(string productId)
        {
            var p = S?.GetProduct(productId);
            if (p == null) return;
            FurnitureManager.Instance.Place(p);
            Hide();
        }

        void ToggleDetailCart()
        {
            if (m_DetailProduct == null || S == null) return;
            SetCart(m_DetailProduct.id, S.InCart(m_DetailProduct.id) ? 0 : 1);
        }

        async void SetCart(string productId, int qty)
        {
            if (S == null || string.IsNullOrEmpty(productId)) return;
            try
            {
                var s = await Api.SetCart(S.id, productId, qty);
                VRShopApp.Instance.SetSession(s);
                Toast.Show(qty > 0 ? "Added to cart — checkout links are on your phone" : "Removed from cart", 2.5f);
            }
            catch (System.Exception e) { Toast.Show($"Cart update failed: {e.Message}"); }
        }

        // ------------------------------------------------------------------ cart
        void ShowCart()
        {
            var s = S;
            SetContent(m_CartView);
            var items = s.cart ?? new List<CartItem>();
            var pages = Mathf.Max(1, Mathf.CeilToInt(items.Count / 5f));
            m_Page = Mathf.Clamp(m_Page, 0, pages - 1);
            m_PageLabel.text = $"{m_Page + 1} / {pages}";
            m_Prev.Interactable = m_Page > 0;
            m_Next.Interactable = m_Page < pages - 1;
            for (var i = 0; i < m_CartRows.Count; i++)
            {
                var row = m_CartRows[i];
                var idx = m_Page * 5 + i;
                var p = idx < items.Count ? s.GetProduct(items[idx].productId) : null;
                row.root.gameObject.SetActive(p != null);
                if (p == null) continue;
                var changed = row.productId != p.id;
                row.productId = p.id;
                row.title.text = p.title;
                row.meta.text = $"{p.store}  •  {(string.IsNullOrEmpty(p.priceText) ? UIKit.Money(p.price) : p.priceText)}  x {items[idx].qty}";
                if (changed) LoadImage(row.image, p, () => row.productId == p.id);
            }
            var total = s.cartTotal;
            var budget = s.budget ?? 0;
            m_CartTotal.text = budget > 0 ? $"{UIKit.Money(total)}\n<size=22><color=#A9B0BC>of {UIKit.Money(budget)} budget</color></size>" : $"{UIKit.Money(total)}\n<size=22><color=#A9B0BC>{items.Count} items</color></size>";
            var frac = budget > 0 ? Mathf.Clamp01(total / budget) : 0;
            var fillRt = m_BudgetFill.rectTransform;
            fillRt.sizeDelta = new Vector2(340 * frac, 18);
            m_BudgetFill.color = total > budget && budget > 0 ? UIKit.Bad : UIKit.Good;
            var stores = items.Select(c => s.GetProduct(c.productId)?.store).Where(x => x != null).Distinct().ToList();
            m_CartNote.text = items.Count == 0
                ? "Your cart is empty. Open a product and choose Add to cart."
                : $"{stores.Count} store{(stores.Count == 1 ? "" : "s")}: {string.Join(", ", stores)}\n\nCheckout links are waiting in the phone app:\n<color=#8FB8FF>{Api.BaseUrl}/#/s/{s.id}/cart</color>";
        }

        void RefreshFooter()
        {
            var vr = PassthroughController.Instance != null && PassthroughController.Instance.Mode == ViewMode.VirtualRoom;
            m_Mode?.SetLabel(vr ? "Passthrough" : "Virtual room");
            if (m_Design != null) m_Design.Interactable = S != null && S.categories != null && S.categories.Count > 0;
        }
    }
}
