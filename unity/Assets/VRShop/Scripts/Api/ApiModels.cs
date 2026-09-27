using System;
using System.Collections.Generic;
using UnityEngine;

// Mirrors backend/src/types.ts. Field names match the JSON exactly (camelCase) so Newtonsoft maps them directly.
// ReSharper disable InconsistentNaming
namespace VRShop.Api
{
    [Serializable]
    public class Dims
    {
        public float w, d, h;
        public Vector3 ToSize() => new Vector3(w, h, d);
        public string ToCmString() => $"{Mathf.RoundToInt(w * 100)} × {Mathf.RoundToInt(d * 100)} × {Mathf.RoundToInt(h * 100)} cm";
        public string ToInchString() => $"{Mathf.RoundToInt(w * 39.37f)}\" W × {Mathf.RoundToInt(d * 39.37f)}\" D × {Mathf.RoundToInt(h * 39.37f)}\" H";
    }

    public class ModelInfo
    {
        public string status;   // none | queued | processing | ready | failed
        public string kind;     // official | generated | standin
        public string url;      // relative to backend, e.g. /models/ikea-123.glb?v=abc
        public float progress;
        public string message;
        public int? triangles;
        public long? bytes;

        public bool IsReady => status == "ready" && !string.IsNullOrEmpty(url);
        public bool IsBusy => status == "queued" || status == "processing";
    }

    public class Product
    {
        public string id;
        public string source;   // ikea | google_shopping
        public string store;
        public string title;
        public string brand;
        public string category;
        public float? price;
        public string currency;
        public string priceText;
        public float? rating;
        public int? reviews;
        public string imageUrl;
        public List<string> images = new List<string>();
        public string productUrl;
        public bool storeLinkResolved;
        public Dims dims;
        public string dimsSource; // listing | model | estimated
        public List<string> colors = new List<string>();
        public ProductAttrs attrs;
        public string why;
        public float? fitScore;
        public ModelInfo model = new ModelInfo { status = "none" };

        public string ModelBadge
        {
            get
            {
                if (model == null) return "3D on demand";
                if (model.IsBusy) return $"Preparing 3D… {Mathf.RoundToInt(model.progress * 100)}%";
                if (model.status == "ready")
                    return model.kind == "official" ? "Official 3D model" : model.kind == "generated" ? "AI-generated 3D" : "Stand-in model";
                if (model.status == "failed") return "3D failed";
                return source == "ikea" ? "IKEA 3D (tap Place)" : "3D on demand";
            }
        }
    }

    public class ProductAttrs
    {
        public List<string> colors = new List<string>();
        public List<string> materials = new List<string>();
        public List<string> styles = new List<string>();
    }

    /// <summary>Catalog filter state (backend/src/types.ts Filters). Null / empty = any.</summary>
    public class Filters
    {
        public string category;
        public List<string> keywords;
        public List<string> theme;      // a motif the product must show ("race car"); any one term matches
        public List<string> colors;
        public List<string> materials;
        public List<string> styles;
        public List<string> stores;
        public float? minPrice;
        public float? maxPrice;
        public float? minRating;
        public float? maxWidthM;
        public float? maxDepthM;
        public float? maxHeightM;
        public bool? only3d;
        public string sort; // relevance | price_asc | price_desc | rating

        public Filters Clone() => new Filters
        {
            category = category, keywords = keywords == null ? null : new List<string>(keywords), theme = theme == null ? null : new List<string>(theme), colors = colors == null ? null : new List<string>(colors),
            materials = materials == null ? null : new List<string>(materials), styles = styles == null ? null : new List<string>(styles),
            stores = stores == null ? null : new List<string>(stores), minPrice = minPrice, maxPrice = maxPrice, minRating = minRating,
            maxWidthM = maxWidthM, maxDepthM = maxDepthM, maxHeightM = maxHeightM, only3d = only3d, sort = sort,
        };
    }

    public class Facet { public string value; public int count; }
    public class Facets { public List<Facet> categories = new List<Facet>(); public List<Facet> colors = new List<Facet>(); public List<Facet> materials = new List<Facet>(); public List<Facet> stores = new List<Facet>(); }
    public class PriceRange { public float min, max, median; }

    /// <summary>Current catalog query + results for a session (voice or manual filters).</summary>
    public class BrowseResult
    {
        public Filters filters = new Filters();
        public List<string> productIds = new List<string>();
        public int total;
        public PriceRange priceRange;
        public Facets facets;
        public string liveSearched;
    }

    public class ChatTurn { public string role; public string text; public string via; }

    // ---- Visa agent checkout ("buy the room") ----
    public class CardInfo { public string brand; public string last4; public string label; }
    public class MandateMerchant { public string store; public float cap; }
    public class Mandate
    {
        public string id;
        public string status;       // active | completed | expired | revoked
        public float totalCap, spent;
        public long expiresAt;
        public List<MandateMerchant> merchants = new List<MandateMerchant>();
        public CardInfo card;
    }
    public class OrderStep { public string label; public bool ok; public string detail; }
    public class PaymentInfo { public string provider; public string id; public string status; public string approvalCode; }
    public class Order
    {
        public string id, store, status;  // pending | authorized | declined | rejected | error | voided
        public float amount;
        public List<OrderStep> steps = new List<OrderStep>();
        public PaymentInfo payment;
        public string merchantOrderId;
    }
    public class Checkout { public string status; public Mandate mandate; public List<Order> orders = new List<Order>(); public string summary; }

    public class QuoteItem { public string productId, title; public int qty; public float unitPrice; }
    public class QuoteGroup { public string store; public float subtotal; public List<QuoteItem> items = new List<QuoteItem>(); }
    public class SwapTarget { public string productId, title, store; public float price; }
    public class Swap { public QuoteItem from; public SwapTarget to; public float saves; public string why; }
    public class VisaStatus { public string acceptance; public string tapKeyId; public CardInfo card; }
    public class Quote
    {
        public float total, overBy;
        public float? budget;
        public List<QuoteGroup> groups = new List<QuoteGroup>();
        public List<Swap> swaps = new List<Swap>();
        public VisaStatus visa;
    }

    public class PaletteColor { public string hex; public string name; }
    public class Lighting { public string mood; public float brightness; public float kelvin; }
    public class Surface { public string material; public string colorHex; }

    public class RoomAnalysis
    {
        public string roomType;
        public string summary;
        public List<string> styleTags = new List<string>();
        public List<PaletteColor> palette = new List<PaletteColor>();
        public Lighting lighting;
        public Surface floor;
        public Surface walls;
        public string source;
    }

    public class PlacementHint { public string anchor; public string near; }

    public class CategoryResult
    {
        public string category;
        public string label;
        public string query;
        public string why;
        public PlacementHint placement;
        public List<string> productIds = new List<string>();
        public string origin; // analysis | voice | search
        public List<string> theme; // set when these products carry the room's theme (e.g. race-car beds from stores)
    }

    public class CartItem { public string productId; public int qty; }

    [Serializable]
    public class Vec3
    {
        public float x, y, z;
        public Vec3() { }
        public Vec3(Vector3 v) { x = v.x; y = v.y; z = v.z; }
        public Vector3 ToVector3() => new Vector3(x, y, z);
    }

    public class Placement
    {
        public string productId;
        public Vec3 position;
        public float yawDeg;
        public string reason;
    }

    public class Session
    {
        public bool unchanged;
        public string id;
        public string status;  // analyzing | searching | ready | error
        public string stage;
        public string error;
        public string prompt;
        public float? budget;
        public List<string> photos = new List<string>();
        public RoomAnalysis room;
        public List<CategoryResult> categories = new List<CategoryResult>();
        public List<CartItem> cart = new List<CartItem>();
        public List<Placement> placements = new List<Placement>();
        public Dictionary<string, Product> products = new Dictionary<string, Product>();
        public BrowseResult browse;
        public Checkout checkout;
        public List<ChatTurn> chat = new List<ChatTurn>();
        /// <summary>The user's real furniture (Space Setup boxes) by anchor id: keep or replace.</summary>
        public Dictionary<string, RealPieceDto> realFurniture = new Dictionary<string, RealPieceDto>();
        public float cartTotal;
        public long updatedAt;

        public Product GetProduct(string pid) => pid != null && products != null && products.TryGetValue(pid, out var p) ? p : null;
        public bool InCart(string pid) => cart != null && cart.Exists(c => c.productId == pid);
    }

    // ---- Room geometry sent to the backend (Unity world space, meters) ----
    public class XZ { public float x, z; }
    public class WallDto { public Vec3 center; public Vec3 normal; public float width, height; }
    public class ObjectDto { public string id; public string label; public Vec3 center; public Vec3 size; public float yawDeg; }

    /// <summary>One real piece of furniture and the user's decision about it (backend/src/types.ts RealPiece).</summary>
    public class RealPieceDto
    {
        public string id;
        public string label;            // COUCH, TABLE, STORAGE, ...
        public string category;         // our furniture type for it; null = user picks
        public string categorySource;   // auto | user
        public List<string> choices = new List<string>();
        public string state;            // keep | replace
        public string replacementId;
        public long updatedAt;
    }

    public class CandidatesResponse { public string pieceId; public string category; public List<Product> products = new List<Product>(); }

    /// <summary>An item "Design my room" must leave where it is (a replacement in its real piece's spot).</summary>
    public class FixedPlacement { public string productId; public Vec3 position; public float yawDeg; public string reason; }

    public class ReplaceResult { public string pieceId; public string category; public List<string> productIds = new List<string>(); public List<Product> products = new List<Product>(); }
    public class UserDto { public Vec3 position; public Vec3 forward; }

    public class RoomGeometryDto
    {
        public float floorY;
        public float ceilingHeight;
        public List<XZ> floorPolygon = new List<XZ>();
        public List<WallDto> walls = new List<WallDto>();
        public List<ObjectDto> objects = new List<ObjectDto>();
        public UserDto user;
    }

    public class LayoutResponse { public List<Placement> placements = new List<Placement>(); public bool usedDefaultRoom; }

    public class SearchResponse { public CategoryResult result; public Session session; }

    /// <summary>One assistant turn (voice or typed): what was heard, the answer, and an optional action.</summary>
    public class VoiceResponse
    {
        public string transcript;
        public string reply;
        public string action;     // none | open | add_to_cart | remove_from_cart | place | checkout | replace
        public string productId;  // the product the action/question refers to
        public bool atPointer;
        public BrowseResult browse;
        public Session session;
        public string speechUrl;  // the reply as speech (WAV), when the server has text to speech
        public ReplaceResult replace; // action replace: which real piece, and the products that can stand in for it
        public string error;
    }

    public class SpeechResponse { public string url; }

    public class BrowseMoreResponse { public int added; public string liveSearched; public Session session; }

    public class Capabilities { public bool openai; public bool tts; public bool serpapi; public bool ikea; public string generator; }
    public class Health { public bool ok; public string baseUrl; public Capabilities capabilities; }
}
