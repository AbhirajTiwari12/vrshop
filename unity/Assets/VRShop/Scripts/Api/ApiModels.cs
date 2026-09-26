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
        public float cartTotal;
        public long updatedAt;

        public Product GetProduct(string pid) => pid != null && products != null && products.TryGetValue(pid, out var p) ? p : null;
        public bool InCart(string pid) => cart != null && cart.Exists(c => c.productId == pid);
    }

    // ---- Room geometry sent to the backend (Unity world space, meters) ----
    public class XZ { public float x, z; }
    public class WallDto { public Vec3 center; public Vec3 normal; public float width, height; }
    public class ObjectDto { public string label; public Vec3 center; public Vec3 size; public float yawDeg; }
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

    public class VoiceResponse
    {
        public string transcript;
        public string reply;
        public bool atPointer;
        public CategoryResult result;
        public Session session;
        public string error;
    }

    public class Capabilities { public bool openai; public bool serpapi; public bool ikea; public string generator; }
    public class Health { public bool ok; public string baseUrl; public Capabilities capabilities; }
}
