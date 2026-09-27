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
    /// The in-headset boutique. Three places, one tap apart:
    ///   For you — the designer's picks for this room, one category chip at a time;
    ///   Browse  — the whole pulled catalog, narrowed by voice or by filter chips with drop-down menus;
    ///   Bag     — what you're buying, the budget, and "Buy the room with Visa" (agent checkout).
    /// Products sit on a shelf of four large cards; a card opens a detail view with Place / Add to bag.
    /// Summon / hide with A.
    /// </summary>
    public class CatalogPanel : MonoBehaviour
    {
        public static CatalogPanel Instance { get; private set; }

        const float W = 1280, H = 800, Scale = 0.00075f; // 0.96 m x 0.60 m
        const float M = 56;                              // side margin
        const int PerPage = 4, BagPerPage = 4, MaxChips = 12, MaxDots = 12;
        const float CardW = 262, CardH = 392, CardGap = 24, CardX = 80, CardY = 256;
        const float ChipY = 184, ChipH = 48;

        enum View { ForYou, Browse, Bag, Visa }

        static readonly (float min, float max, string label)[] k_PricePresets =
            { (0, 0, "Any price"), (0, 200, "Under $200"), (0, 500, "Under $500"), (0, 1000, "Under $1,000"), (0, 2000, "Under $2,000"), (1000, 0, "$1,000 and up") };
        static readonly (string key, string label)[] k_Sorts = { ("relevance", "Best match"), ("price_asc", "Price: low to high"), ("price_desc", "Price: high to low"), ("rating", "Top rated") };
        static readonly Dictionary<string, string> k_Swatches = new Dictionary<string, string>
        {
            { "black", "#222222" }, { "white", "#FFFFFF" }, { "gray", "#9A9A9A" }, { "beige", "#D8C6A6" }, { "brown", "#7A5234" },
            { "blue", "#3F5E8C" }, { "green", "#5E7B5A" }, { "red", "#A63A2E" }, { "pink", "#D9A0A6" }, { "yellow", "#D9B44A" },
            { "orange", "#C9762F" }, { "purple", "#6E4E86" }, { "gold", "#B8934A" }, { "silver", "#C4C7CB" }, { "multicolor", "#A8834F" },
        };

        Canvas m_Canvas;
        CanvasGroup m_Group;
        ChipMenu m_Menu;

        // header
        TextMeshProUGUI m_Eyebrow, m_Title, m_Subtitle;
        readonly List<Image> m_Swatches = new List<Image>();
        UIButton m_NavForYou, m_NavBrowse, m_NavBag;
        Image m_NavUnderline;

        // chip row
        RectTransform m_CategoryRow, m_FilterRow;
        readonly List<UIButton> m_CatChips = new List<UIButton>();
        UIButton m_ChipPrev, m_ChipNext;
        readonly List<int> m_ChipPageStarts = new List<int>();
        UIButton m_FCategory, m_FPrice, m_FColor, m_FMaterial, m_FSort, m_F3d, m_FReset;
        bool m_FilterBusy;

        // shelf
        RectTransform m_Grid;
        readonly List<Card> m_Cards = new List<Card>();
        UIButton m_PrevPage, m_NextPage;
        readonly List<Image> m_Dots = new List<Image>();
        TextMeshProUGUI m_PageText;

        // detail
        RectTransform m_Detail;
        UIButton m_DBack, m_DPlace, m_DCart;
        RawImage m_DImage;
        TextMeshProUGUI m_DStore, m_DTitle, m_DPrice, m_DRating, m_DDims, m_DModel, m_DWhy;

        // bag
        RectTransform m_BagView;
        readonly List<BagRow> m_BagRows = new List<BagRow>();
        UIButton m_BagPrev, m_BagNext, m_BagBuy;
        TextMeshProUGUI m_BagPage, m_BagTotal, m_BagOf, m_BagLeft, m_BagStores, m_BagNote;
        Image m_BudgetFill;

        // visa
        RectTransform m_VisaView;
        TextMeshProUGUI m_VSteps, m_VTitle, m_VInfo;
        UIButton m_VApprove, m_VSecondary;
        Quote m_Quote;
        string m_QuoteKey;
        bool m_VisaBusy;

        // message
        RectTransform m_Message;
        TextMeshProUGUI m_MessageTitle, m_MessageBody;
        readonly List<Image> m_Loader = new List<Image>();
        bool m_Loading;

        // footer
        UIButton m_Design, m_More, m_Clear;
        float m_ClearArmedUntil;

        View m_View = View.ForYou;
        string m_Category;
        int m_Page, m_ChipPage;
        Product m_DetailProduct;
        string m_BackTo;             // "Back to sofas" — where the open product came from
        bool m_Visible = true;
        bool m_PlacedWithSession;

        Session S => VRShopApp.Instance != null ? VRShopApp.Instance.Session : null;
        ApiClient Api => VRShopApp.Instance.Api;

        class Card
        {
            public UIButton button;
            public RawImage image;
            public TextMeshProUGUI store, title, price, rating, bagText, badgeText;
            public Image bagPill, badgePill;
            public string productId;
        }

        class BagRow
        {
            public RectTransform root;
            public RawImage image;
            public TextMeshProUGUI title, meta, price;
            public string productId;
        }

        public bool IsOpen => m_Visible;
        public string FocusedProductId => m_DetailProduct?.id;

        void Awake()
        {
            Instance = this;
            Build();
            ShowMessage("Opening the showroom…", "Connecting to VRShop", true);
        }

        void Start()
        {
            UIKit.PlaceInFront(transform, 0.95f, 0.12f);
            if (VRShopApp.Instance != null) VRShopApp.Instance.SessionChanged += _ => Refresh();
        }

        void Update()
        {
            var input = XRInput.Instance;
            if (input != null && input.Down(Btn.A)) Toggle();
            m_Group.alpha = Mathf.MoveTowards(m_Group.alpha, m_Visible ? 1 : 0, Time.deltaTime * 6);
            if (m_Visible && Time.frameCount % 20 == 0) RefreshLiveBadges();
            if (m_Loading && m_Message.gameObject.activeSelf)
                for (var i = 0; i < m_Loader.Count; i++)
                    m_Loader[i].color = Theme.WithAlpha(Theme.Brass, 0.25f + 0.75f * Mathf.Pow(Mathf.Max(0, Mathf.Sin(Time.time * 3.2f - i * 0.7f)), 2));
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
            m_Menu.Close();
            m_Canvas.gameObject.SetActive(false);
        }

        bool IsInView()
        {
            var head = XRInput.Instance.Head;
            var to = (transform.position - head.position).normalized;
            return Vector3.Dot(head.forward, to) > 0.6f;
        }

        // ================================================================== build
        void Build()
        {
            m_Canvas = UIKit.CreateCanvas("CatalogCanvas", new Vector2(W + 120, H + 120), Scale);
            m_Canvas.transform.SetParent(transform, false);
            m_Group = m_Canvas.gameObject.AddComponent<CanvasGroup>();
            // Everything lives in a W x H root centered in a slightly larger canvas (room for the soft shadow).
            var root = UIKit.Box(m_Canvas.transform, "Root", 60, 60, W, H);
            UIKit.Shadow(root, "Shadow", 0, 0, W, H, 48, 0.28f, 16);
            var bg = UIKit.Panel(root, "Background", 0, 0, W, H, Theme.Canvas, 30);
            PanelBlocker.Add(bg.gameObject, W, H); // clicks on empty panel space must not hit the room behind

            BuildHeader(root);
            BuildChipRows(root);
            BuildGrid(root);
            BuildDetail(root);
            BuildBag(root);
            BuildVisa(root);
            BuildMessage(root);
            BuildFooter(root);
            m_Menu = ChipMenu.Create(root, W, H); // last: draws on top

            SetContent(m_Message);
        }

        void BuildHeader(Transform root)
        {
            m_Eyebrow = UIKit.Eyebrow(root, "Eyebrow", M, 40, 620, "");
            for (var i = 0; i < 6; i++)
            {
                var ring = UIKit.Dot(root, $"SwatchRing{i}", 0, 0, 18, Theme.Line);
                var sw = UIKit.Dot(ring.transform, "Swatch", 2, 2, 14, Color.clear);
                m_Swatches.Add(sw);
            }
            m_Title = UIKit.Text(root, "Title", M, 60, 740, 68, "", 46, Theme.Ink, Face.Serif);
            m_Title.textWrappingMode = TextWrappingModes.NoWrap;
            m_Subtitle = UIKit.Text(root, "Subtitle", M, 128, 760, 50, "", 19, Theme.Muted);

            m_NavForYou = UIKit.Button(root, "NavForYou", 804, 42, 136, 52, "For you", 20, () => Go(View.ForYou), ButtonStyle.Nav);
            m_NavBrowse = UIKit.Button(root, "NavBrowse", 948, 42, 128, 52, "Browse", 20, () => Go(View.Browse), ButtonStyle.Nav);
            m_NavBag = UIKit.Button(root, "NavBag", 1084, 42, 140, 52, "Bag", 20, () => Go(View.Bag), ButtonStyle.Nav);
            m_NavUnderline = UIKit.Panel(root, "NavUnderline", 0, 94, 40, 3, Theme.Brass, 1.5f);
        }

        void BuildChipRows(Transform root)
        {
            m_CategoryRow = UIKit.Box(root, "CategoryRow", 0, ChipY, W, ChipH);
            for (var i = 0; i < MaxChips; i++)
            {
                var idx = i;
                m_CatChips.Add(UIKit.Button(m_CategoryRow, $"Chip{i}", M, 0, 120, ChipH, "", 18, () => SelectChip(idx), ButtonStyle.Chip));
            }
            m_ChipPrev = UIKit.Button(m_CategoryRow, "ChipPrev", W - M - 100, 2, 44, 44, "‹", 26, () => { m_ChipPage--; RefreshCategoryChips(); }, ButtonStyle.Round);
            m_ChipNext = UIKit.Button(m_CategoryRow, "ChipNext", W - M - 44, 2, 44, 44, "›", 26, () => { m_ChipPage++; RefreshCategoryChips(); }, ButtonStyle.Round);

            m_FilterRow = UIKit.Box(root, "FilterRow", 0, ChipY, W, ChipH);
            m_FCategory = UIKit.Button(m_FilterRow, "Category", 0, 0, 160, ChipH, "", 18, () => OpenMenu(m_FCategory, CategoryOptions()), ButtonStyle.Chip);
            m_FPrice = UIKit.Button(m_FilterRow, "Price", 0, 0, 160, ChipH, "", 18, () => OpenMenu(m_FPrice, PriceOptions()), ButtonStyle.Chip);
            m_FColor = UIKit.Button(m_FilterRow, "Color", 0, 0, 140, ChipH, "", 18, () => OpenMenu(m_FColor, ColorOptions()), ButtonStyle.Chip);
            m_FMaterial = UIKit.Button(m_FilterRow, "Material", 0, 0, 160, ChipH, "", 18, () => OpenMenu(m_FMaterial, MaterialOptions()), ButtonStyle.Chip);
            m_FSort = UIKit.Button(m_FilterRow, "Sort", 0, 0, 160, ChipH, "", 18, () => OpenMenu(m_FSort, SortOptions()), ButtonStyle.Chip);
            m_F3d = UIKit.Button(m_FilterRow, "Only3d", 0, 0, 120, ChipH, "3D only", 18, Toggle3d, ButtonStyle.Chip);
            m_FReset = UIKit.Button(m_FilterRow, "Reset", 0, 0, 96, ChipH, "Reset", 18, () => ApplyFilters(new Filters()), ButtonStyle.Ghost);
        }

        void BuildGrid(Transform root)
        {
            m_Grid = UIKit.Box(root, "Grid", 0, 0, W, H);
            for (var i = 0; i < PerPage; i++)
            {
                var idx = i;
                var x = CardX + i * (CardW + CardGap);
                var shadow = UIKit.Shadow(m_Grid, $"CardShadow{i}", x, CardY, CardW, CardH, 20, 0.08f, 8);
                var btn = UIKit.Button(m_Grid, $"Card{i}", x, CardY, CardW, CardH, "", 1, () => OpenCard(idx), ButtonStyle.Card);
                btn.Shadow = shadow;
                btn.Label.gameObject.SetActive(false);
                var t = btn.transform;
                var c = new Card { button = btn };
                c.image = UIKit.Picture(t, "Image", 14, 14, CardW - 28, 214);
                c.bagPill = UIKit.Panel(t, "BagPill", 24, 24, 78, 28, Theme.Ink, 14);
                c.bagText = UIKit.Text(c.bagPill.transform, "Text", 0, 0, 78, 28, "In bag", 13, Theme.OnInk, Face.SemiBold, TextAlignmentOptions.Center);
                c.badgePill = UIKit.Panel(t, "BadgePill", 24, 194, 90, 28, Theme.BrassSoft, 14);
                c.badgeText = UIKit.Text(c.badgePill.transform, "Text", 0, 0, 90, 28, "", 13, Theme.Brass, Face.SemiBold, TextAlignmentOptions.Center);
                c.store = UIKit.Eyebrow(t, "Store", 18, 244, CardW - 36, "", Theme.Muted, 13);
                c.title = UIKit.Text(t, "Title", 18, 268, CardW - 36, 50, "", 18, Theme.Ink, Face.Medium);
                c.price = UIKit.Text(t, "Price", 18, 326, 150, 42, "", 28, Theme.Ink, Face.Serif);
                c.rating = UIKit.Text(t, "Rating", 140, 334, CardW - 158, 28, "", 15, Theme.Muted, Face.Regular, TextAlignmentOptions.TopRight);
                m_Cards.Add(c);
            }
            m_PrevPage = UIKit.Button(m_Grid, "PrevPage", 14, CardY + CardH / 2 - 26, 52, 52, "‹", 30, () => { m_Page--; RefreshContent(); }, ButtonStyle.Round);
            m_NextPage = UIKit.Button(m_Grid, "NextPage", W - 66, CardY + CardH / 2 - 26, 52, 52, "›", 30, () => { m_Page++; RefreshContent(); }, ButtonStyle.Round);
            for (var i = 0; i < MaxDots; i++) m_Dots.Add(UIKit.Dot(m_Grid, $"Dot{i}", 0, CardY + CardH + 22, 9, Theme.Line));
            m_PageText = UIKit.Text(m_Grid, "PageText", 0, CardY + CardH + 12, W, 28, "", 16, Theme.Muted, Face.Medium, TextAlignmentOptions.Top);
        }

        void BuildDetail(Transform root)
        {
            m_Detail = UIKit.Box(root, "Detail", 0, 0, W, H);
            m_DBack = UIKit.Button(m_Detail, "Back", M - 14, ChipY, 240, 44, "‹  Back", 18, CloseDetail, ButtonStyle.Ghost);
            UIKit.Shadow(m_Detail, "ImageShadow", M, 244, 440, 440, 24, 0.1f, 8);
            var frame = UIKit.Panel(m_Detail, "ImageFrame", M, 244, 440, 440, Theme.Surface, 22);
            m_DImage = UIKit.Picture(frame.transform, "Image", 20, 20, 400, 400);

            const float x = 536, w = W - M - 536;
            m_DStore = UIKit.Eyebrow(m_Detail, "Store", x, 250, w, "");
            m_DTitle = UIKit.Text(m_Detail, "Title", x, 274, w, 102, "", 36, Theme.Ink, Face.Serif);
            m_DPrice = UIKit.Text(m_Detail, "Price", x, 380, 360, 64, "", 44, Theme.Ink, Face.Serif);
            m_DRating = UIKit.Text(m_Detail, "Rating", x + 360, 400, w - 360, 30, "", 18, Theme.Muted, Face.Regular, TextAlignmentOptions.TopRight);
            UIKit.Hairline(m_Detail, "Line", x, 452, w);
            UIKit.Eyebrow(m_Detail, "SizeLabel", x, 474, 140, "Size", Theme.Muted, 13);
            m_DDims = UIKit.Text(m_Detail, "Dims", x + 140, 470, w - 140, 28, "", 19, Theme.Ink);
            UIKit.Eyebrow(m_Detail, "ModelLabel", x, 510, 140, "In your room", Theme.Muted, 13);
            m_DModel = UIKit.Text(m_Detail, "Model", x + 140, 506, w - 140, 28, "", 19, Theme.Ink);
            m_DWhy = UIKit.Text(m_Detail, "Why", x, 548, w, 64, "", 22, Theme.Muted, Face.SerifItalic);
            m_DPlace = UIKit.Button(m_Detail, "Place", x, 626, 300, 60, "Place in my room", 21, PlaceDetail, ButtonStyle.Primary);
            m_DCart = UIKit.Button(m_Detail, "Cart", x + 316, 626, 230, 60, "Add to bag", 20, ToggleDetailCart, ButtonStyle.Secondary);
        }

        void BuildBag(Transform root)
        {
            m_BagView = UIKit.Box(root, "Bag", 0, 0, W, H);
            const float rowW = 728;
            for (var i = 0; i < BagPerPage; i++)
            {
                var r = new BagRow { root = UIKit.Box(m_BagView, $"Row{i}", M, 192 + i * 108, rowW, 96) };
                UIKit.Panel(r.root, "Bg", 0, 0, rowW, 96, Theme.Surface, 18);
                r.image = UIKit.Picture(r.root, "Image", 14, 12, 72, 72);
                r.title = UIKit.Text(r.root, "Title", 104, 18, 290, 28, "", 19, Theme.Ink, Face.Medium);
                r.title.textWrappingMode = TextWrappingModes.NoWrap;
                r.meta = UIKit.Text(r.root, "Meta", 104, 52, 290, 26, "", 16, Theme.Muted);
                r.price = UIKit.Text(r.root, "Price", 404, 26, 116, 40, "", 24, Theme.Ink, Face.Serif, TextAlignmentOptions.TopRight);
                var row = r;
                UIKit.Button(r.root, "Place", 532, 24, 88, 48, "Place", 17, () => PlaceProduct(row.productId), ButtonStyle.Secondary);
                UIKit.Button(r.root, "Remove", 624, 24, 98, 48, "Remove", 16, () => SetCart(row.productId, 0), ButtonStyle.Ghost);
                m_BagRows.Add(r);
            }
            m_BagPrev = UIKit.Button(m_BagView, "Prev", M, 630, 44, 44, "‹", 26, () => { m_Page--; RefreshContent(); }, ButtonStyle.Round);
            m_BagPage = UIKit.Text(m_BagView, "Page", M + 52, 630, 80, 44, "", 16, Theme.Muted, Face.Medium, TextAlignmentOptions.Center);
            m_BagNext = UIKit.Button(m_BagView, "Next", M + 140, 630, 44, 44, "›", 26, () => { m_Page++; RefreshContent(); }, ButtonStyle.Round);

            const float sx = 808, sw = W - M - sx;
            UIKit.Shadow(m_BagView, "SummaryShadow", sx, 192, sw, 476, 22, 0.08f, 8);
            var card = UIKit.Panel(m_BagView, "Summary", sx, 192, sw, 476, Theme.Surface, 22).transform;
            UIKit.Eyebrow(card, "Label", 30, 30, sw - 60, "Room total");
            m_BagTotal = UIKit.Text(card, "Total", 30, 54, sw - 60, 78, "", 54, Theme.Ink, Face.Serif);
            m_BagOf = UIKit.Text(card, "Of", 30, 132, sw - 60, 26, "", 18, Theme.Muted);
            UIKit.Panel(card, "BudgetBar", 30, 170, sw - 60, 8, Theme.Line, 4);
            m_BudgetFill = UIKit.Panel(card, "BudgetFill", 30, 170, 0, 8, Theme.Brass, 4);
            m_BagLeft = UIKit.Text(card, "Left", 30, 186, sw - 60, 26, "", 16, Theme.Muted, Face.Medium);
            m_BagStores = UIKit.Text(card, "Stores", 30, 232, sw - 60, 120, "", 17, Theme.Muted);
            m_BagBuy = UIKit.Button(card, "BuyWithVisa", 30, 370, sw - 60, 60, "Buy the room with Visa", 20, ShowVisa, ButtonStyle.Visa);
            m_BagNote = UIKit.Text(card, "Note", 30, 438, sw - 60, 26, "One approval — your agent checks out for you.", 14, Theme.Muted, Face.Regular, TextAlignmentOptions.Top);
        }

        void BuildVisa(Transform root)
        {
            m_VisaView = UIKit.Box(root, "Visa", 0, 0, W, H);
            const float lw = 704, rx = M + lw + 24, rw = W - M - (M + lw + 24);
            UIKit.Shadow(m_VisaView, "StepsShadow", M, 192, lw, 476, 22, 0.08f, 8);
            var left = UIKit.Panel(m_VisaView, "Steps", M, 192, lw, 476, Theme.Surface, 22).transform;
            m_VSteps = UIKit.Text(left, "Text", 30, 26, lw - 60, 424, "", 17, Theme.Ink);
            m_VSteps.overflowMode = TextOverflowModes.Truncate;
            UIKit.Shadow(m_VisaView, "SideShadow", rx, 192, rw, 476, 22, 0.08f, 8);
            var side = UIKit.Panel(m_VisaView, "Side", rx, 192, rw, 476, Theme.Surface, 22).transform;
            var logo = UIKit.Panel(side, "VisaLogo", 28, 28, 92, 46, Theme.VisaNavy, 10);
            var mark = UIKit.Text(logo.transform, "Text", 0, 0, 92, 46, "VISA", 26, Color.white, Face.SemiBold, TextAlignmentOptions.Center);
            mark.fontStyle = FontStyles.Italic;
            m_VTitle = UIKit.Text(side, "Title", 136, 30, rw - 160, 46, "Buy the room", 30, Theme.Ink, Face.Serif, TextAlignmentOptions.MidlineLeft);
            m_VInfo = UIKit.Text(side, "Info", 28, 96, rw - 56, 210, "", 17, Theme.Muted);
            m_VApprove = UIKit.Button(side, "Approve", 28, 318, rw - 56, 60, "Approve with Visa", 20, () => ApproveVisa(m_Quote != null && m_Quote.overBy > 0), ButtonStyle.Visa);
            m_VSecondary = UIKit.Button(side, "Secondary", 28, 392, rw - 56 - 128, 52, "", 17, ApplyTopSwap, ButtonStyle.Secondary);
            UIKit.Button(side, "Back", rw - 28 - 120, 392, 120, 52, "Back", 17, () => Go(View.Bag), ButtonStyle.Ghost);
        }

        void BuildMessage(Transform root)
        {
            m_Message = UIKit.Box(root, "Message", 0, 0, W, H);
            m_MessageTitle = UIKit.Text(m_Message, "Title", 140, 300, W - 280, 110, "", 38, Theme.Ink, Face.Serif, TextAlignmentOptions.Bottom);
            m_MessageBody = UIKit.Text(m_Message, "Body", 160, 424, W - 320, 150, "", 20, Theme.Muted, Face.Regular, TextAlignmentOptions.Top);
            for (var i = 0; i < 3; i++) m_Loader.Add(UIKit.Dot(m_Message, $"Loader{i}", W / 2 - 30 + i * 24, 262, 12, Theme.Brass));
        }

        void BuildFooter(Transform root)
        {
            UIKit.Hairline(root, "FooterLine", M, 710, W - 2 * M);
            UIKit.Dot(root, "OrbGlow", M - 5, 743, 26, Theme.WithAlpha(Theme.Brass, 0.25f));
            UIKit.Dot(root, "OrbDot", M + 1, 749, 14, Theme.Brass);
            UIKit.Text(root, "Hint", M + 30, 732, 600, 36, "Talk to your designer: hold X, or point at the orb and pull the trigger", 16, Theme.Muted, Face.Regular, TextAlignmentOptions.MidlineLeft);
            UIKit.Button(root, "Close", 716, 728, 112, 52, "Close", 18, Hide, ButtonStyle.Ghost);
            m_Clear = UIKit.Button(root, "Clear", 832, 728, 140, 52, "Clear room", 18, ClearRoom, ButtonStyle.Ghost);
            m_Design = UIKit.Button(root, "Design", 980, 728, W - M - 980, 52, "Design my room", 19, () => VRShopApp.Instance.DesignMyRoom(), ButtonStyle.Primary);
            m_More = UIKit.Button(root, "More", 980, 728, W - M - 980, 52, "Search stores for more", 17, SearchStores, ButtonStyle.Primary);
            m_More.gameObject.SetActive(false);
        }

        /// <summary>Removes every placed item; needs a second press within 3 s so it can't happen by accident.</summary>
        void ClearRoom()
        {
            var fm = FurnitureManager.Instance;
            if (fm == null || fm.Items.Count == 0) { Toast.Show("The room is already empty", 2); return; }
            if (Time.time > m_ClearArmedUntil)
            {
                m_ClearArmedUntil = Time.time + 3f;
                m_Clear.SetLabel("Confirm?");
                m_Clear.Selected = true;
                Invoke(nameof(DisarmClear), 3f);
                return;
            }
            CancelInvoke(nameof(DisarmClear));
            DisarmClear();
            var n = fm.Items.Count;
            fm.ClearAll();
            Toast.Show($"Cleared {n} piece{(n == 1 ? "" : "s")} from your room", 2);
        }

        void DisarmClear()
        {
            m_ClearArmedUntil = 0;
            m_Clear.SetLabel("Clear room");
            m_Clear.Selected = false;
        }

        void SetContent(RectTransform which)
        {
            m_Menu?.Close();
            m_Grid.gameObject.SetActive(which == m_Grid);
            m_Detail.gameObject.SetActive(which == m_Detail);
            m_BagView.gameObject.SetActive(which == m_BagView);
            m_Message.gameObject.SetActive(which == m_Message);
            m_VisaView.gameObject.SetActive(which == m_VisaView);
            // The chip row belongs to the shelf; the detail view puts its Back link there instead.
            var chips = which == m_Grid || (which == m_Message && m_View == View.Browse);
            m_CategoryRow.gameObject.SetActive(chips && m_View == View.ForYou);
            m_FilterRow.gameObject.SetActive(chips && m_View == View.Browse);
        }

        /// <summary>Loading / empty / error states: a serif line, a muted explanation, optional loading dots.</summary>
        public void ShowMessage(string title, string body = null, bool loading = false)
        {
            if (m_MessageTitle == null) return;
            m_MessageTitle.text = title;
            m_MessageBody.text = body ?? "";
            m_Loading = loading;
            foreach (var d in m_Loader) d.gameObject.SetActive(loading);
            SetContent(m_Message);
        }

        // ================================================================== navigation
        void Go(View v)
        {
            m_View = v;
            m_Page = 0;
            m_DetailProduct = null;
            Show();
            Refresh();
        }

        void CloseDetail()
        {
            m_DetailProduct = null;
            RefreshHeader();
            RefreshContent();
            RefreshFooter();
        }

        /// <summary>Open the Browse tab (after a voice answer, or from the nav).</summary>
        public void ShowBrowse() => Go(View.Browse);

        /// <summary>Open the Visa checkout view (Bag button, or voice: "buy the room").</summary>
        public void ShowVisa() => Go(View.Visa);

        /// <summary>Jump to a curated category.</summary>
        public void Focus(string category)
        {
            if (S?.categories == null || S.categories.All(c => c.category != category)) return;
            m_Category = category;
            m_ChipPage = -1; // recomputed to show the selected chip
            Go(View.ForYou);
        }

        /// <summary>Open a product's detail view (voice: "tell me about the second one").</summary>
        public void OpenProduct(string productId)
        {
            var p = S?.GetProduct(productId);
            if (p == null) return;
            if (m_View == View.Bag || m_View == View.Visa) m_View = View.Browse;
            Show();
            m_DetailProduct = p;
            m_BackTo = null; // opened by voice: plain "Back"
            RefreshNav();
            RefreshHeader();
            ShowDetail(p);
            WarmModel(p);
        }

        // ================================================================== refresh
        public void Refresh()
        {
            var s = S;
            if (s == null) return;
            if (!m_PlacedWithSession)
            {
                // Head tracking may not have been valid in Start(); place again once we have content.
                m_PlacedWithSession = true;
                if (m_Visible) UIKit.PlaceInFront(transform, 0.95f, 0.12f);
            }
            var cats = s.categories ?? new List<CategoryResult>();
            if (m_Category == null || cats.All(c => c.category != m_Category))
            {
                m_Category = cats.Count > 0 ? cats[0].category : null;
                m_ChipPage = -1;
            }
            RefreshNav();
            RefreshHeader();
            RefreshContent();
            RefreshFooter();
        }

        void RefreshNav()
        {
            var count = S?.cart?.Sum(c => c.qty) ?? 0;
            m_NavBag.SetLabel(count > 0 ? $"Bag · {count}" : "Bag");
            var sel = m_View == View.ForYou ? m_NavForYou : m_View == View.Browse ? m_NavBrowse : m_NavBag;
            foreach (var b in new[] { m_NavForYou, m_NavBrowse, m_NavBag }) b.Selected = b == sel;
            var rt = (RectTransform)sel.transform;
            var w = UIKit.MeasureWidth(sel.Label, sel.Label.text);
            UIKit.Place(m_NavUnderline.rectTransform, rt.anchoredPosition.x + (rt.sizeDelta.x - w) / 2, 94, w, 3);
        }

        void RefreshHeader()
        {
            var s = S;
            var room = s?.room;
            string eyebrow, title, sub;
            var showSwatches = false;
            switch (m_View)
            {
                case View.Browse:
                {
                    var b = s?.browse;
                    eyebrow = "The collection";
                    title = b == null ? "Browse the collection" : b.total == 1 ? "1 piece" : $"{b.total:N0} pieces";
                    sub = b == null ? "Tell your designer what you're after, or narrow it down with the filters." : BrowseSummary(b);
                    break;
                }
                case View.Bag:
                {
                    var count = s?.cart?.Sum(c => c.qty) ?? 0;
                    eyebrow = "Your bag";
                    title = count == 0 ? "Your bag is empty" : count == 1 ? "1 piece" : $"{count} pieces";
                    sub = count == 0 ? "Open a piece and choose Add to bag, or just ask your designer." :
                        s.budget.HasValue ? $"{UIKit.Money(s.cartTotal)} of your {UIKit.Money(s.budget)} budget" : UIKit.Money(s.cartTotal);
                    break;
                }
                case View.Visa:
                    eyebrow = "Checkout with Visa";
                    title = "Buy the room";
                    sub = "Approve once — your AI agent checks out at every store, within your budget.";
                    break;
                default:
                {
                    eyebrow = "Curated for your room";
                    title = !string.IsNullOrEmpty(UIKit.RoomName(room?.roomType)) ? $"Your {UIKit.TitleCase(UIKit.RoomName(room.roomType))}" : "Your room";
                    // In a product's detail, speak to that product's category; otherwise the selected chip's.
                    var cat = m_DetailProduct != null
                        ? s?.categories?.FirstOrDefault(c => c.productIds.Contains(m_DetailProduct.id))
                        : s?.categories?.FirstOrDefault(c => c.category == m_Category);
                    sub = !string.IsNullOrEmpty(cat?.why) ? cat.why
                        : room != null ? string.Join("  ·  ", room.styleTags.Take(4).Select(UIKit.TitleCase))
                        : s?.prompt ?? "";
                    showSwatches = room?.palette != null && room.palette.Count > 0;
                    break;
                }
            }
            m_Eyebrow.text = eyebrow;
            m_Title.text = title;
            m_Subtitle.text = UIKit.Plain(sub);

            // The room's palette as small swatches after the eyebrow.
            var x = M + UIKit.MeasureWidth(m_Eyebrow, eyebrow) + 18;
            for (var i = 0; i < m_Swatches.Count; i++)
            {
                var has = showSwatches && i < room.palette.Count;
                var ring = m_Swatches[i].transform.parent.gameObject;
                ring.SetActive(has);
                if (!has) continue;
                m_Swatches[i].color = VRShopMaterials.Hex(room.palette[i].hex, Color.clear);
                UIKit.Place((RectTransform)ring.transform, x + i * 24, 42, 18, 18);
            }
        }

        string BrowseSummary(BrowseResult b)
        {
            var f = b.filters ?? new Filters();
            var parts = new List<string>();
            if (f.keywords != null) parts.AddRange(f.keywords.Select(k => $"“{k}”"));
            if (f.styles != null) parts.AddRange(f.styles.Select(UIKit.Pretty));
            if (f.stores != null) parts.AddRange(f.stores.Select(x => $"from {x}"));
            if (f.minRating.HasValue) parts.Add($"{f.minRating:0.#}★ and up");
            if (f.maxWidthM.HasValue) parts.Add($"up to {Mathf.RoundToInt(f.maxWidthM.Value * 100)} cm wide");
            if (b.priceRange != null && b.total > 0) parts.Add($"{UIKit.Money(b.priceRange.min)} – {UIKit.Money(b.priceRange.max)}");
            return parts.Count > 0 ? string.Join("  ·  ", parts) : "Everything in the catalog. Ask your designer to narrow it down.";
        }

        void RefreshContent()
        {
            var s = S;
            if (s == null) return;
            if (m_DetailProduct != null) { ShowDetail(m_DetailProduct); return; }
            switch (m_View)
            {
                case View.Bag: ShowBag(s); return;
                case View.Visa: ShowVisaView(s); return;
                case View.Browse: ShowBrowseGrid(s); return;
            }
            if (s.categories == null || s.categories.Count == 0)
            {
                if (s.status == "error") ShowMessage("Something went wrong", UIKit.Plain(s.error));
                else ShowMessage(string.IsNullOrEmpty(s.stage) ? "Curating your room…" : UIKit.Plain(s.stage), "Finding real furniture that fits your space and style.", true);
                return;
            }
            RefreshCategoryChips();
            var cat = s.categories.FirstOrDefault(c => c.category == m_Category) ?? s.categories[0];
            FillGrid(s, cat.productIds);
        }

        void RefreshFooter()
        {
            if (m_Design == null) return;
            m_Design.Interactable = S != null && S.categories != null && S.categories.Count > 0;
            var b = S?.browse;
            var thin = m_View == View.Browse && m_DetailProduct == null && b != null && b.total < 6 &&
                       (!string.IsNullOrEmpty(b.filters?.category) || (b.filters?.keywords?.Count ?? 0) > 0);
            m_More.gameObject.SetActive(thin);
            m_Design.gameObject.SetActive(!thin);
            m_More.Interactable = !m_FilterBusy;
        }

        // ================================================================== curated category chips
        static string ChipLabel(CategoryResult c) => c.origin == "voice" ? $"“{c.label}”" : c.label;

        void RefreshCategoryChips()
        {
            var cats = S?.categories ?? new List<CategoryResult>();
            // Greedy pages of chips that fit the row (leaving room for the arrows).
            const float avail = W - 2 * M - 116, gap = 10;
            var probe = m_CatChips[0].Label;
            m_ChipPageStarts.Clear();
            var widths = cats.Select(c => Mathf.Max(92, UIKit.MeasureWidth(probe, ChipLabel(c)) + 44)).ToList();
            float used = 0;
            for (var i = 0; i < cats.Count; i++)
            {
                if (i == 0 || used + widths[i] > avail || i - m_ChipPageStarts[m_ChipPageStarts.Count - 1] >= MaxChips) { m_ChipPageStarts.Add(i); used = 0; }
                used += widths[i] + gap;
            }
            if (m_ChipPageStarts.Count == 0) m_ChipPageStarts.Add(0);
            var selIdx = cats.FindIndex(c => c.category == m_Category);
            if (m_ChipPage < 0) m_ChipPage = Mathf.Max(0, m_ChipPageStarts.FindLastIndex(start => start <= Mathf.Max(0, selIdx)));
            m_ChipPage = Mathf.Clamp(m_ChipPage, 0, m_ChipPageStarts.Count - 1);
            var from = m_ChipPageStarts[m_ChipPage];
            var to = m_ChipPage + 1 < m_ChipPageStarts.Count ? m_ChipPageStarts[m_ChipPage + 1] : cats.Count;
            var x = M;
            for (var j = 0; j < m_CatChips.Count; j++)
            {
                var chip = m_CatChips[j];
                var ci = from + j;
                var on = ci < to;
                chip.gameObject.SetActive(on);
                if (!on) continue;
                chip.SetLabel(ChipLabel(cats[ci]));
                chip.SetRect(x, 0, widths[ci], ChipH);
                chip.Selected = cats[ci].category == m_Category;
                x += widths[ci] + gap;
            }
            m_ChipPrev.gameObject.SetActive(m_ChipPageStarts.Count > 1);
            m_ChipNext.gameObject.SetActive(m_ChipPageStarts.Count > 1);
            m_ChipPrev.Interactable = m_ChipPage > 0;
            m_ChipNext.Interactable = m_ChipPage < m_ChipPageStarts.Count - 1;
        }

        void SelectChip(int slot)
        {
            var cats = S?.categories;
            if (cats == null || m_ChipPageStarts.Count == 0) return;
            var ci = m_ChipPageStarts[Mathf.Clamp(m_ChipPage, 0, m_ChipPageStarts.Count - 1)] + slot;
            if (ci >= cats.Count) return;
            m_Category = cats[ci].category;
            m_Page = 0;
            m_DetailProduct = null;
            RefreshHeader();
            RefreshContent();
        }

        // ================================================================== the shelf (4 cards per page)
        void FillGrid(Session s, List<string> ids)
        {
            SetContent(m_Grid);
            var pages = Mathf.Max(1, Mathf.CeilToInt(ids.Count / (float)PerPage));
            m_Page = Mathf.Clamp(m_Page, 0, pages - 1);
            m_PrevPage.gameObject.SetActive(m_Page > 0);
            m_NextPage.gameObject.SetActive(m_Page < pages - 1);
            for (var i = 0; i < PerPage; i++)
            {
                var idx = m_Page * PerPage + i;
                var card = m_Cards[i];
                var p = idx < ids.Count ? s.GetProduct(ids[idx]) : null;
                card.button.gameObject.SetActive(p != null);
                card.button.Shadow.gameObject.SetActive(p != null);
                if (p == null) continue;
                var changed = card.productId != p.id;
                card.productId = p.id;
                card.store.text = p.store;
                card.title.text = p.title;
                card.price.text = UIKit.Price(p);
                card.rating.text = p.rating.HasValue ? $"<color={Theme.BrassHex}>★</color> {p.rating:0.0}" : "";
                card.bagPill.gameObject.SetActive(s.InCart(p.id));
                SetBadge(card, p);
                if (changed) LoadImage(card.image, p, () => card.productId == p.id, 384);
            }
            // Page dots (or "3 / 20" when there are many pages).
            var dots = pages > 1 && pages <= MaxDots;
            var start = W / 2 - (pages * 9 + (pages - 1) * 11) / 2f;
            for (var i = 0; i < m_Dots.Count; i++)
            {
                var on = dots && i < pages;
                m_Dots[i].gameObject.SetActive(on);
                if (!on) continue;
                m_Dots[i].color = i == m_Page ? Theme.Ink : Theme.Faint;
                UIKit.Place(m_Dots[i].rectTransform, start + i * 20, CardY + CardH + 24, 9, 9);
            }
            m_PageText.text = pages > MaxDots ? $"{m_Page + 1}  /  {pages}" : "";
        }

        static void SetBadge(Card card, Product p)
        {
            var m = p.model;
            string text = null;
            if (m != null && m.IsBusy) text = $"3D  {Mathf.RoundToInt(m.progress * 100)}%";
            else if (m != null && m.status == "ready") text = m.kind == "official" ? "3D model" : m.kind == "generated" ? "AI 3D" : null;
            else if (p.source == "ikea" && m?.status != "failed") text = "3D model";
            card.badgePill.gameObject.SetActive(text != null);
            if (text == null) return;
            card.badgeText.text = text;
            var w = UIKit.MeasureWidth(card.badgeText, text) + 24;
            UIKit.Place(card.badgePill.rectTransform, 24, 194, w, 28);
            UIKit.Place(card.badgeText.rectTransform, 0, 0, w, 28);
        }

        void RefreshLiveBadges()
        {
            var s = S;
            if (s == null) return;
            if (m_DetailProduct != null && m_Detail.gameObject.activeSelf)
                m_DModel.text = ModelLine(s.GetProduct(m_DetailProduct.id) ?? m_DetailProduct);
        }

        async void LoadImage(RawImage img, Product p, System.Func<bool> stillValid, int width)
        {
            UIKit.SetPicture(img, null);
            var tex = await TextureCache.Get(Api.ImageUrl(p.imageUrl, width));
            if (img != null && stillValid()) UIKit.SetPicture(img, tex);
        }

        // ================================================================== detail
        void OpenCard(int i)
        {
            var p = S?.GetProduct(m_Cards[i].productId);
            if (p == null) return;
            m_DetailProduct = p;
            m_BackTo = m_View == View.ForYou ? S?.categories?.FirstOrDefault(c => c.category == m_Category)?.label : "results";
            ShowDetail(p);
            RefreshHeader();
            RefreshFooter();
            WarmModel(p);
        }

        /// <summary>Warm up the 3D model as soon as the user looks at a product (IKEA models are free and fast).</summary>
        void WarmModel(Product p)
        {
            if (!p.model.IsReady && !p.model.IsBusy) _ = Api.EnsureModel(p.id, p.source == "ikea");
        }

        static string ModelLine(Product p)
        {
            var m = p.model;
            if (m != null && m.IsBusy) return $"Preparing the 3D model… {Mathf.RoundToInt(m.progress * 100)}%";
            if (m != null && m.status == "ready")
                return m.kind == "official" ? "True-scale 3D model from the maker" : m.kind == "generated" ? "AI-generated 3D model, true to size" : "True-size stand-in";
            if (m != null && m.status == "failed") return "True-size box (3D model unavailable)";
            return p.source == "ikea" ? "True-scale 3D model from the maker" : "3D model made when you place it";
        }

        void ShowDetail(Product p)
        {
            p = S?.GetProduct(p.id) ?? p;
            SetContent(m_Detail);
            var backLabel = string.IsNullOrEmpty(m_BackTo) ? "‹  Back" : $"‹  Back to {m_BackTo.ToLowerInvariant()}";
            m_DBack.SetLabel(backLabel);
            m_DBack.SetRect(M - 14, ChipY, Mathf.Min(420, UIKit.MeasureWidth(m_DBack.Label, backLabel) + 40), 44);
            m_DStore.text = string.IsNullOrEmpty(p.brand) || p.brand == p.store ? p.store : $"{p.brand}  ·  {p.store}";
            m_DTitle.text = p.title;
            m_DPrice.text = UIKit.Price(p);
            m_DRating.text = p.rating.HasValue ? $"<color={Theme.BrassHex}>★</color> {p.rating:0.0}   <color={Theme.FaintHex}>({(p.reviews ?? 0):N0} reviews)</color>" : "";
            m_DDims.text = p.dims != null
                ? $"{p.dims.ToCmString()}   <color={Theme.MutedHex}>{p.dims.ToInchString()}</color>" + (p.dimsSource == "estimated" ? $"  <color={Theme.FaintHex}>(est.)</color>" : "")
                : $"<color={Theme.MutedHex}>Measured when the 3D model loads</color>";
            m_DModel.text = ModelLine(p);
            m_DWhy.text = string.IsNullOrEmpty(p.why) ? "" : $"“{UIKit.Plain(p.why)}”";
            var inCart = S != null && S.InCart(p.id);
            m_DCart.SetLabel(inCart ? "In your bag  ✓" : "Add to bag");
            m_DCart.Selected = inCart;
            LoadImage(m_DImage, p, () => m_DetailProduct != null && m_DetailProduct.id == p.id, 768);
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
                Toast.Show(qty > 0 ? "Added to your bag" : "Removed from your bag", 2.5f);
            }
            catch (System.Exception e) { Toast.Show($"Couldn't update your bag: {e.Message}"); }
        }

        // ================================================================== bag
        void ShowBag(Session s)
        {
            SetContent(m_BagView);
            var items = s.cart ?? new List<CartItem>();
            var pages = Mathf.Max(1, Mathf.CeilToInt(items.Count / (float)BagPerPage));
            m_Page = Mathf.Clamp(m_Page, 0, pages - 1);
            var paged = pages > 1;
            m_BagPrev.gameObject.SetActive(paged);
            m_BagNext.gameObject.SetActive(paged);
            m_BagPage.gameObject.SetActive(paged);
            m_BagPage.text = $"{m_Page + 1} / {pages}";
            m_BagPrev.Interactable = m_Page > 0;
            m_BagNext.Interactable = m_Page < pages - 1;
            for (var i = 0; i < m_BagRows.Count; i++)
            {
                var row = m_BagRows[i];
                var idx = m_Page * BagPerPage + i;
                var p = idx < items.Count ? s.GetProduct(items[idx].productId) : null;
                row.root.gameObject.SetActive(p != null);
                if (p == null) continue;
                var changed = row.productId != p.id;
                row.productId = p.id;
                row.title.text = p.title;
                row.meta.text = items[idx].qty > 1 ? $"{p.store}  ·  Qty {items[idx].qty}" : p.store;
                row.price.text = UIKit.Price(p);
                if (changed) LoadImage(row.image, p, () => row.productId == p.id, 192);
            }

            var total = s.cartTotal;
            var budget = s.budget ?? 0;
            m_BagTotal.text = UIKit.Money(total);
            m_BagOf.text = budget > 0 ? $"of your {UIKit.Money(budget)} budget" : $"{items.Sum(c => c.qty)} piece{(items.Sum(c => c.qty) == 1 ? "" : "s")}";
            var barW = ((RectTransform)m_BudgetFill.transform.parent).rect.width - 60;
            var frac = budget > 0 ? Mathf.Clamp01(total / budget) : 0;
            UIKit.Place(m_BudgetFill.rectTransform, 30, 170, Mathf.Max(frac > 0 ? 8 : 0, barW * frac), 8);
            var over = budget > 0 && total > budget;
            m_BudgetFill.color = over ? Theme.Terracotta : Theme.Brass;
            m_BagLeft.text = budget <= 0 ? "" : over ? $"<color={Theme.TerracottaHex}>{UIKit.Money(total - budget)} over budget</color>" : $"{UIKit.Money(budget - total)} left to spend";
            var stores = items.Select(c => s.GetProduct(c.productId)?.store).Where(x => x != null).Distinct().ToList();
            m_BagStores.text = items.Count == 0 ? "" : $"From {stores.Count} store{(stores.Count == 1 ? "" : "s")}: {string.Join(", ", stores)}";
            m_BagBuy.gameObject.SetActive(items.Count > 0 || s.checkout != null);
            m_BagNote.gameObject.SetActive(items.Count > 0);
            m_BagBuy.SetLabel(items.Count > 0 ? "Buy the room with Visa" : "View Visa receipt");
            if (items.Count == 0 && s.checkout == null)
                ShowMessage("Nothing here yet", "Open any piece and choose Add to bag — or tell your designer “add it to my bag”.");
        }

        // ================================================================== browse (whole catalog, voice + filter chips)
        void ShowBrowseGrid(Session s)
        {
            RefreshFilterChips();
            var b = s.browse;
            if (b == null || b.productIds == null || b.productIds.Count == 0)
            {
                if (b == null) ShowMessage("What are you looking for?", "Hold X and tell your designer — “a black leather sofa under $1,500”, “something cheaper”, “only IKEA”.");
                else ShowMessage("Nothing matches just yet", "Try a higher price, Reset the filters, or search stores for more.");
                return;
            }
            FillGrid(s, b.productIds);
        }

        string PriceLabel(Filters f)
        {
            var lo = f?.minPrice ?? 0; var hi = f?.maxPrice ?? 0;
            if (lo > 0 && hi > 0) return $"{UIKit.Money(lo)}–{UIKit.Money(hi)}";
            if (hi > 0) return $"Under {UIKit.Money(hi)}";
            if (lo > 0) return $"{UIKit.Money(lo)}+";
            return "Price";
        }

        void RefreshFilterChips()
        {
            var f = S?.browse?.filters ?? new Filters();
            var chips = new (UIButton b, string label, bool active)[]
            {
                (m_FCategory, string.IsNullOrEmpty(f.category) ? "Category" : UIKit.Pretty(f.category), !string.IsNullOrEmpty(f.category)),
                (m_FPrice, PriceLabel(f), (f.minPrice ?? 0) > 0 || (f.maxPrice ?? 0) > 0),
                (m_FColor, f.colors != null && f.colors.Count > 0 ? UIKit.Pretty(string.Join(" / ", f.colors)) : "Color", f.colors != null && f.colors.Count > 0),
                (m_FMaterial, f.materials != null && f.materials.Count > 0 ? UIKit.Pretty(string.Join(" / ", f.materials)) : "Material", f.materials != null && f.materials.Count > 0),
                (m_FSort, k_Sorts.FirstOrDefault(x => x.key == (f.sort ?? "relevance")).label ?? "Best match", !string.IsNullOrEmpty(f.sort) && f.sort != "relevance"),
            };
            var x = M;
            foreach (var (b, label, active) in chips)
            {
                var text = $"{label}  ⌄";
                b.SetLabel(text);
                var w = Mathf.Min(260, UIKit.MeasureWidth(b.Label, text) + 44);
                b.SetRect(x, 0, w, ChipH);
                b.Selected = active;
                b.Interactable = !m_FilterBusy;
                x += w + 10;
            }
            m_F3d.Selected = f.only3d == true;
            m_F3d.SetLabel(f.only3d == true ? "3D only  ✓" : "3D only");
            var w3 = UIKit.MeasureWidth(m_F3d.Label, m_F3d.Label.text) + 44;
            m_F3d.SetRect(x, 0, w3, ChipH);
            m_F3d.Interactable = !m_FilterBusy;
            x += w3 + 10;
            m_FReset.SetRect(x, 0, 96, ChipH);
            m_FReset.gameObject.SetActive(!IsDefault(f));
            m_FReset.Interactable = !m_FilterBusy;
        }

        static bool IsDefault(Filters f) =>
            string.IsNullOrEmpty(f.category) && (f.keywords == null || f.keywords.Count == 0) && (f.colors == null || f.colors.Count == 0) &&
            (f.materials == null || f.materials.Count == 0) && (f.styles == null || f.styles.Count == 0) && (f.stores == null || f.stores.Count == 0) &&
            !f.minPrice.HasValue && !f.maxPrice.HasValue && !f.minRating.HasValue && !f.maxWidthM.HasValue && f.only3d != true &&
            (string.IsNullOrEmpty(f.sort) || f.sort == "relevance");

        void OpenMenu(UIButton chip, List<ChipMenu.Option> options)
        {
            if (m_FilterBusy || options.Count == 0) return;
            var rt = (RectTransform)chip.transform;
            m_Menu.Open(rt.anchoredPosition.x, ChipY + ChipH + 8, options);
        }

        Filters CurrentFilters() => S?.browse?.filters?.Clone() ?? new Filters();

        List<ChipMenu.Option> CategoryOptions()
        {
            var f = CurrentFilters();
            var list = new List<ChipMenu.Option> { new ChipMenu.Option { label = "All furniture", selected = string.IsNullOrEmpty(f.category), pick = () => { var g = CurrentFilters(); g.category = null; ApplyFilters(g); } } };
            foreach (var facet in (S?.browse?.facets?.categories ?? new List<Facet>()).Take(13))
            {
                var v = facet.value;
                list.Add(new ChipMenu.Option { label = UIKit.Pretty(v), count = facet.count.ToString("N0"), selected = f.category == v, pick = () => { var g = CurrentFilters(); g.category = v; ApplyFilters(g); } });
            }
            return list;
        }

        List<ChipMenu.Option> PriceOptions()
        {
            var f = CurrentFilters();
            return k_PricePresets.Select(p => new ChipMenu.Option
            {
                label = p.label,
                selected = Mathf.Approximately(p.min, f.minPrice ?? 0) && Mathf.Approximately(p.max, f.maxPrice ?? 0),
                pick = () =>
                {
                    var g = CurrentFilters();
                    g.minPrice = p.min > 0 ? p.min : (float?)null;
                    g.maxPrice = p.max > 0 ? p.max : (float?)null;
                    ApplyFilters(g);
                },
            }).ToList();
        }

        List<ChipMenu.Option> ColorOptions()
        {
            var f = CurrentFilters();
            var cur = f.colors != null && f.colors.Count > 0 ? f.colors[0] : null;
            var list = new List<ChipMenu.Option> { new ChipMenu.Option { label = "Any color", selected = cur == null, pick = () => { var g = CurrentFilters(); g.colors = null; ApplyFilters(g); } } };
            foreach (var facet in (S?.browse?.facets?.colors ?? new List<Facet>()).Take(13))
            {
                var v = facet.value;
                list.Add(new ChipMenu.Option
                {
                    label = UIKit.Pretty(v), count = facet.count.ToString("N0"), selected = cur == v,
                    swatch = k_Swatches.TryGetValue(v, out var hex) ? Theme.Hex(hex) : Theme.Faint,
                    pick = () => { var g = CurrentFilters(); g.colors = new List<string> { v }; ApplyFilters(g); },
                });
            }
            return list;
        }

        List<ChipMenu.Option> MaterialOptions()
        {
            var f = CurrentFilters();
            var cur = f.materials != null && f.materials.Count > 0 ? f.materials[0] : null;
            var list = new List<ChipMenu.Option> { new ChipMenu.Option { label = "Any material", selected = cur == null, pick = () => { var g = CurrentFilters(); g.materials = null; ApplyFilters(g); } } };
            foreach (var facet in (S?.browse?.facets?.materials ?? new List<Facet>()).Take(13))
            {
                var v = facet.value;
                list.Add(new ChipMenu.Option { label = UIKit.Pretty(v), count = facet.count.ToString("N0"), selected = cur == v, pick = () => { var g = CurrentFilters(); g.materials = new List<string> { v }; ApplyFilters(g); } });
            }
            return list;
        }

        List<ChipMenu.Option> SortOptions()
        {
            var cur = CurrentFilters().sort ?? "relevance";
            return k_Sorts.Select(s => new ChipMenu.Option { label = s.label, selected = s.key == cur, pick = () => { var g = CurrentFilters(); g.sort = s.key; ApplyFilters(g); } }).ToList();
        }

        void Toggle3d()
        {
            var f = CurrentFilters();
            f.only3d = f.only3d == true ? (bool?)null : true;
            ApplyFilters(f);
        }

        async void ApplyFilters(Filters f)
        {
            if (S == null || m_FilterBusy) return;
            m_FilterBusy = true;
            RefreshFilterChips();
            try
            {
                var s = await Api.SetBrowse(S.id, f);
                m_Page = 0;
                VRShopApp.Instance.SetSession(s);
            }
            catch (System.Exception e) { Toast.Show($"Couldn't apply that filter: {e.Message}"); }
            finally
            {
                m_FilterBusy = false;
                if (m_View == View.Browse) { RefreshFilterChips(); RefreshFooter(); }
            }
        }

        async void SearchStores()
        {
            if (S == null || m_FilterBusy) return;
            m_FilterBusy = true;
            RefreshFooter();
            Toast.Sticky("Searching stores for more…");
            try
            {
                var res = await Api.BrowseMore(S.id);
                if (res.session != null) VRShopApp.Instance.SetSession(res.session);
                Toast.Show(res.added > 0 ? $"Found {res.added} more" : "No new matches in stores (or this month's search limit is reached)", 4);
            }
            catch (System.Exception e) { Toast.Show($"Store search failed: {e.Message}"); }
            finally { m_FilterBusy = false; RefreshFooter(); }
        }

        // ================================================================== Visa agent checkout
        static string CartSignature(Session s) => s.cart == null ? "" : string.Join(",", s.cart.Select(c => $"{c.productId}:{c.qty}"));

        async void LoadQuote(Session s)
        {
            var key = CartSignature(s);
            if (key == m_QuoteKey) return;
            m_QuoteKey = key;
            try { m_Quote = await Api.Quote(s.id); }
            catch (System.Exception e) { m_Quote = null; Debug.LogWarning($"[VRShop] quote: {e.Message}"); }
            if (m_View == View.Visa) RefreshContent();
        }

        void ShowVisaView(Session s)
        {
            SetContent(m_VisaView);
            var c = s.checkout;
            var hasCart = s.cart != null && s.cart.Count > 0;
            if (c != null && (c.status == "running" || !hasCart)) { ShowReceipt(c); return; }
            if (!hasCart)
            {
                m_VSteps.text = "Your bag is empty.\n\nAdd pieces from the showroom (or say “add it to my bag”), then come back to buy the whole room in one approval.";
                m_VInfo.text = "";
                m_VApprove.gameObject.SetActive(false);
                m_VSecondary.gameObject.SetActive(false);
                return;
            }
            LoadQuote(s);
            var q = m_Quote;
            m_VTitle.text = "Buy the room";
            if (q == null || m_QuoteKey != CartSignature(s))
            {
                m_VSteps.text = $"<color={Theme.MutedHex}>Preparing your basket…</color>";
                m_VApprove.gameObject.SetActive(false);
                m_VSecondary.gameObject.SetActive(false);
                return;
            }
            var sb = new System.Text.StringBuilder();
            foreach (var g in q.groups)
            {
                sb.Append($"<b>{UIKit.Plain(g.store)}</b>   <color={Theme.MutedHex}>{UIKit.Money(g.subtotal)}</color>\n");
                foreach (var it in g.items) sb.Append($"<color={Theme.MutedHex}>     {UIKit.Plain(Short(it.title))}{(it.qty > 1 ? $" ×{it.qty}" : "")}   {UIKit.Money(it.unitPrice * it.qty)}</color>\n");
                sb.Append("<size=8>\n</size>");
            }
            if (q.overBy > 0)
            {
                sb.Append($"\n<color={Theme.OchreHex}>{UIKit.Money(q.overBy)} over your budget.</color> Cheaper look-alikes:\n");
                foreach (var w in q.swaps)
                    sb.Append($"     {UIKit.Plain(Short(w.from.title))} → {UIKit.Plain(Short(w.to.title))}  <color={Theme.SageHex}>save {UIKit.Money(w.saves)}</color>\n     <color={Theme.MutedHex}><size=15>{UIKit.Plain(w.why)}</size></color>\n");
            }
            m_VSteps.text = sb.ToString();
            var over = q.overBy > 0;
            var cap = q.budget.HasValue && !over ? q.budget.Value : q.total;
            m_VInfo.text = $"Pay with <color={Theme.InkHex}>{q.visa?.card?.label}</color>\nTotal <color={Theme.InkHex}>{UIKit.Money(q.total)}</color>{(q.budget.HasValue ? $"  of {UIKit.Money(q.budget)}" : "")}\nAgent spending cap <color={Theme.InkHex}>{UIKit.Money(cap)}</color>\n\n<size=15>Approve once: your agent checks out at {q.groups.Count} store{(q.groups.Count == 1 ? "" : "s")}, signing each order with Visa Trusted Agent Protocol. {(q.visa?.acceptance == "sandbox" ? "Real Visa Acceptance sandbox authorizations." : "Visa authorization simulated (no sandbox keys).")}</size>";
            m_VApprove.gameObject.SetActive(true);
            m_VApprove.Interactable = !m_VisaBusy;
            m_VApprove.SetLabel(m_VisaBusy ? "Approving…" : over ? $"Approve {UIKit.Money(q.total)} anyway" : $"Approve {UIKit.Money(q.total)} with Visa");
            var swap = over && q.swaps.Count > 0 ? q.swaps[0] : null;
            m_VSecondary.gameObject.SetActive(swap != null);
            if (swap != null) m_VSecondary.SetLabel($"Swap to save {UIKit.Money(swap.saves)}");
        }

        void ShowReceipt(Checkout c)
        {
            m_VTitle.text = c.status == "running" ? "Checking out" : c.status == "done" ? "Room bought" : "Checkout";
            var sb = new System.Text.StringBuilder();
            foreach (var o in c.orders)
            {
                var col = o.status == "authorized" ? Theme.SageHex : o.status == "pending" ? Theme.MutedHex : o.status == "voided" ? Theme.OchreHex : Theme.TerracottaHex;
                sb.Append($"<b>{UIKit.Plain(o.store)}</b>   {UIKit.Money(o.amount)}   <color={col}><size=14>{o.status.ToUpper()}</size></color>\n");
                // Finished orders collapse to their payment line so several stores fit.
                var steps = o.status == "pending" || c.orders.Count == 1 ? o.steps : o.steps.Where(x => !x.ok || x.label.StartsWith("Visa")).ToList();
                foreach (var st in steps)
                    sb.Append($"<color={(st.ok ? Theme.SageHex : Theme.TerracottaHex)}>  ✓</color> {UIKit.Plain(st.label)}{(string.IsNullOrEmpty(st.detail) ? "" : $"\n<color={Theme.MutedHex}><size=14>       {UIKit.Plain(st.detail)}</size></color>")}\n");
                if (o.status == "pending" && c.status == "running") sb.Append($"<color={Theme.MutedHex}>  •  working…</color>\n");
                sb.Append("\n");
            }
            m_VSteps.text = sb.ToString();
            var m = c.mandate;
            m_VInfo.text = $"{UIKit.Plain(c.summary ?? "Your AI agent is checking out at each store.")}\n\nSpent <color={Theme.InkHex}>{UIKit.Money(m?.spent)}</color> of <color={Theme.InkHex}>{UIKit.Money(m?.totalCap)}</color>\n{m?.card?.label}\n<size=14><color={Theme.FaintHex}>Mandate {m?.id}</color></size>";
            m_VApprove.gameObject.SetActive(false);
            m_VSecondary.gameObject.SetActive(false);
        }

        static string Short(string t) => string.IsNullOrEmpty(t) ? "" : (t.Length > 34 ? t.Substring(0, 33) + "…" : t);

        async void ApproveVisa(bool allowOverBudget)
        {
            if (S == null || m_VisaBusy) return;
            m_VisaBusy = true;
            RefreshContent();
            // The approval moment: one deliberate press, confirmed with a haptic pulse on both controllers.
            XRInput.Instance?.Haptic(Hand.Left, 0.6f, 0.12f);
            XRInput.Instance?.Haptic(Hand.Right, 0.6f, 0.12f);
            try
            {
                var s = await Api.StartCheckout(S.id, allowOverBudget);
                Toast.Show("Approved. Your agent is checking out with Visa…", 4);
                VRShopApp.Instance.SetSession(s);
            }
            catch (System.Exception e) { Toast.Show($"Checkout: {e.Message}", 5); }
            finally { m_VisaBusy = false; if (m_View == View.Visa) RefreshContent(); }
        }

        async void ApplyTopSwap()
        {
            var w = m_Quote != null && m_Quote.swaps.Count > 0 ? m_Quote.swaps[0] : null;
            if (S == null || w == null || m_VisaBusy) return;
            m_VisaBusy = true;
            try
            {
                var s = await Api.Swap(S.id, w.from.productId, w.to.productId);
                Toast.Show($"Swapped for {Short(w.to.title)} (save {UIKit.Money(w.saves)})", 4);
                m_QuoteKey = null;
                VRShopApp.Instance.SetSession(s);
            }
            catch (System.Exception e) { Toast.Show($"Swap failed: {e.Message}"); }
            finally { m_VisaBusy = false; }
        }
    }
}
