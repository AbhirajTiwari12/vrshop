using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Meta.XR.MRUtilityKit;
using Newtonsoft.Json;
using UnityEngine;
using VRShop.Api;
using VRShop.Assistant;
using VRShop.Furniture;
using VRShop.Input;
using VRShop.Interaction;
using VRShop.Rendering;
using VRShop.Room;
using VRShop.UI;
using VRShop.Voice;

namespace VRShop.Core
{
    /// <summary>
    /// App entry point. Put this on one GameObject in the scene (the VRShop Setup Window does it for you)
    /// next to an OVRCameraRig and an MRUK object. It creates every subsystem, connects to the backend,
    /// loads the latest room session (created from the phone app), keeps it in sync, and sends the
    /// headset's room geometry to the server for "Design my room".
    /// </summary>
    [DefaultExecutionOrder(-100)]
    public class VRShopApp : MonoBehaviour
    {
        public static VRShopApp Instance { get; private set; }

        [Header("Backend")]
        [Tooltip("URL of the VRShop backend as seen from the Quest (LAN IP or tunnel). Override on device with " +
                 "/sdcard/Android/data/<package>/files/vrshop.json → {\"backendUrl\":\"http://…:8787\"}")]
        public string backendUrl = "http://192.168.1.50:8787";
        [Tooltip("Leave empty to always open the most recent session from the phone app.")]
        public string sessionId = "";
        public bool createDemoSessionIfNone = true;

        public ApiClient Api { get; private set; }
        public Session Session { get; private set; }
        /// <summary>What the backend can do (OpenAI, spoken replies, Google Shopping, 3D generation).</summary>
        public Capabilities Capabilities { get; private set; }
        public event Action<Session> SessionChanged;

        string m_RoomSignature;
        bool m_GeometrySent;
        int m_PollCount;
        bool m_Greeted;

        [Serializable]
        class Overrides { public string backendUrl; public string sessionId; }

        void Awake()
        {
            Instance = this;
            LoadOverrides();
            Api = new ApiClient(backendUrl);
            Application.targetFrameRate = 72;

            // On the headset use only the real Space Setup (MRUK will prompt for it if missing);
            // the sample-room JSON fallback is for Editor testing. Runs before MRUK.Awake (execution order -100).
            var mruk = FindFirstObjectByType<MRUK>();
            if (mruk != null && mruk.SceneSettings != null && !Application.isEditor)
                mruk.SceneSettings.DataSource = MRUK.SceneDataSource.Device;

            // Subsystems (created in code so the scene stays trivial to set up).
            Add<XRInput>("Input");
            Add<RoomService>("Room");
            Add<LightingRig>("Lighting");
            Add<PassthroughController>("Passthrough");
            Add<ManipulationController>("Manipulation");
            Add<FurnitureManager>("Furniture");
            Add<RealFurniture>("RealFurniture");
            Add<Toast>("Toast");
            Add<AssistantOrb>("Assistant");
            Add<CatalogPanel>("Catalog");
            Add<VoiceCommand>("Voice");
            Add<LaserPointer>("LaserRight").hand = Hand.Right;
            Add<LaserPointer>("LaserLeft").hand = Hand.Left;
        }

        T Add<T>(string name) where T : Component
        {
            var existing = FindFirstObjectByType<T>();
            if (existing != null && !(existing is LaserPointer)) return existing;
            var go = new GameObject(name);
            go.transform.SetParent(transform, false);
            return go.AddComponent<T>();
        }

        void LoadOverrides()
        {
            try
            {
                var path = Path.Combine(Application.persistentDataPath, "vrshop.json");
                if (!File.Exists(path)) return;
                var o = JsonConvert.DeserializeObject<Overrides>(File.ReadAllText(path));
                if (!string.IsNullOrWhiteSpace(o?.backendUrl)) backendUrl = o.backendUrl.Trim();
                if (o?.sessionId != null) sessionId = o.sessionId.Trim();
                Debug.Log($"[VRShop] Overrides from {path}: backend={backendUrl} session={sessionId}");
            }
            catch (Exception e) { Debug.LogWarning($"[VRShop] vrshop.json: {e.Message}"); }
        }

        async void Start()
        {
            RoomService.Instance.OnReady += () => { m_GeometrySent = false; _ = SendGeometry(); };
            await Connect();
            LoadDesignStyles();
            await LoadSession();
            if (RoomService.Instance.Ready) _ = SendGeometry();
            PollLoop();
        }

        async Task Connect()
        {
            for (var attempt = 0; this != null; attempt++)
            {
                try
                {
                    var h = await Api.Health();
                    Capabilities = h.capabilities;
                    Debug.Log($"[VRShop] Connected to {Api.BaseUrl} (openai={h.capabilities?.openai}, serpapi={h.capabilities?.serpapi}, 3D={h.capabilities?.generator})");
                    return;
                }
                catch (Exception e)
                {
                    CatalogPanel.Instance?.ShowMessage("Can't reach the showroom",
                        $"Is the VRShop server running at {Api.BaseUrl}, on the same Wi-Fi as the headset?\n{UIKit.Plain(e.Message)}  ·  Retrying…", true);
                    await Task.Delay(3000);
                }
            }
        }

        async Task LoadSession()
        {
            while (this != null)
            {
                try
                {
                    Session s;
                    if (!string.IsNullOrEmpty(sessionId)) s = await Api.GetSession(sessionId);
                    else
                    {
                        try { s = await Api.LatestSession(); }
                        catch (ApiException e) when (e.Status == 404 && createDemoSessionIfNone)
                        {
                            s = await Api.CreateDemoSession(); // no room scan yet: start from a sample room
                        }
                    }
                    SetSession(s);
                    Invoke(nameof(Greet), 1.5f);
                    return;
                }
                catch (Exception e)
                {
                    CatalogPanel.Instance?.ShowMessage("Couldn't open your room", UIKit.Plain(e.Message) + "  ·  Retrying…", true);
                    await Task.Delay(3000);
                }
            }
        }

        async void PollLoop()
        {
            while (this != null && Session != null)
            {
                await Task.Delay(Session.checkout?.status == "running" ? 700 : Session.status == "ready" ? 4000 : 1500);
                if (this == null) return;
                try
                {
                    m_PollCount++;
                    // Every ~20 s, follow the phone if the user started a new room there.
                    if (string.IsNullOrEmpty(sessionId) && m_PollCount % 5 == 0)
                    {
                        var latest = await Api.LatestSession();
                        if (latest != null && latest.id != Session.id && latest.updatedAt > Session.updatedAt)
                        {
                            Toast.Show("Loading your new room scan", 4);
                            FurnitureManager.Instance.ClearAll();
                            m_GeometrySent = false;
                            SetSession(latest);
                            _ = SendGeometry();
                            continue;
                        }
                    }
                    var s = await Api.GetSession(Session.id, Session.updatedAt);
                    if (s != null && !s.unchanged) SetSession(s);
                }
                catch (Exception e) { Debug.LogWarning($"[VRShop] poll: {e.Message}"); }
            }
        }

        public void SetSession(Session s)
        {
            if (s == null || s.unchanged) return;
            var first = Session == null || Session.id != s.id;
            // Announce when the agent finishes checking out ("Room bought: 3 stores, $1,412 of $1,500 via Visa").
            if (!first && Session.checkout?.status == "running" && s.checkout != null && s.checkout.status != "running" && !string.IsNullOrEmpty(s.checkout.summary))
            {
                if (AssistantOrb.Instance != null) AssistantOrb.Instance.Say(s.checkout.summary);
                else Toast.Show(s.checkout.summary, 8);
            }
            // Keep product model status we learned locally if the server copy is older.
            Session = s;
            var sig = s.room != null ? $"{s.id}:{s.room.summary}:{s.room.lighting?.kelvin}" : s.id;
            if (first || sig != m_RoomSignature)
            {
                m_RoomSignature = sig;
                LightingRig.Instance?.Apply(s.room);
                RoomService.Instance?.BuildVirtualRoom(s.room);
            }
            SessionChanged?.Invoke(s);
        }

        public void UpdateProduct(Product p)
        {
            if (Session?.products == null || p == null) return;
            Session.products[p.id] = p;
        }

        static string Join(List<string> words) => words.Count <= 1 ? string.Concat(words) : string.Join(", ", words.Take(words.Count - 1)) + " and " + words.Last();

        /// <summary>The designer introduces itself once per launch.</summary>
        void Greet()
        {
            if (m_Greeted || Session == null || AssistantOrb.Instance == null) return;
            m_Greeted = true;
            var room = UIKit.RoomName(Session.room?.roomType);
            var line = string.IsNullOrEmpty(room)
                ? "Welcome in. I'm curating pieces for your room — it only takes a moment. Tell me what you're looking for anytime."
                : $"Welcome in. I've pulled pieces that suit your {room}. Tell me what you're looking for.";
            AssistantOrb.Instance.Say(line, "Hold X, or point at me and pull the trigger");
        }

        /// <summary>Upload the room again (the user adjusted a real piece's box, or the server hasn't seen it yet).</summary>
        public Task ResendGeometry()
        {
            m_GeometrySent = false;
            return SendGeometry();
        }

        async Task SendGeometry()
        {
            if (m_GeometrySent || Session == null || RoomService.Instance == null || !RoomService.Instance.Ready) return;
            m_GeometrySent = true;
            try { await Api.PostGeometry(Session.id, RoomService.Instance.ToDto()); }
            catch (Exception e) { m_GeometrySent = false; Debug.LogWarning($"[VRShop] geometry upload: {e.Message}"); }
        }

        /// <summary>The styles "Design my room" offers (from the server; a built-in copy until it answers).</summary>
        public List<DesignStyle> DesignStyles { get; private set; } = DefaultStyles();

        static List<DesignStyle> DefaultStyles()
        {
            DesignStyle S(string key, string label, string blurb, params string[] sw) => new DesignStyle { key = key, label = label, blurb = blurb, swatches = sw.ToList() };
            return new List<DesignStyle>
            {
                S("modern", "Modern", "Clean lines, soft neutrals, a little metal", "#2B2B2B", "#B9BDC1", "#F2F1EE"),
                S("victorian", "Victorian", "Dark woods, velvet, wingbacks, gilt", "#5B1F24", "#2F4A3A", "#B08A4A"),
                S("scandinavian", "Scandinavian", "Light oak, white, wool and linen", "#F4F1EA", "#D8C6A6", "#9A9A9A"),
                S("mid-century", "Mid-century", "Walnut, tapered legs, mustard and teal", "#7A4A2A", "#C9962F", "#2E6A6A"),
                S("industrial", "Industrial", "Black steel, raw wood, worn leather", "#1F1F1F", "#6B4A33", "#8A8C8E"),
                S("japandi", "Japandi", "Low, calm, natural wood and linen", "#E6DCCB", "#8B6B4A", "#2A2724"),
                S("boho", "Boho", "Rattan, jute, plants and pattern", "#C46A3C", "#D9B44A", "#5E7B5A"),
                S("coastal", "Coastal", "Whites, sea blues, linen and light wood", "#F7F5F0", "#7FA3C0", "#D8C6A6"),
                S("farmhouse", "Farmhouse", "Warm wood, white paint, cozy textures", "#F4EFE6", "#9C7652", "#2B2B2B"),
                S("glam", "Art Deco", "Velvet, brass, marble, bold geometry", "#1F4D3A", "#B8934A", "#1C1C24"),
                S("minimalist", "Minimalist", "Fewer, simpler pieces in quiet tones", "#FFFFFF", "#C9C9C9", "#1E1E1E"),
                S("traditional", "Traditional", "Classic shapes, warm wood, rolled arms", "#1F3050", "#E9E0CF", "#8A6A48"),
            };
        }

        async void LoadDesignStyles()
        {
            try
            {
                var r = await Api.DesignStyles();
                if (r?.styles != null && r.styles.Count > 0) DesignStyles = r.styles;
            }
            catch (Exception e) { Debug.LogWarning($"[VRShop] design styles: {e.Message}"); }
        }

        bool m_Designing;

        /// <summary>
        /// AI "Design my room" in a style (empty = the room's own style), or with <paramref name="bag"/> the pieces in the bag.
        /// The server picks real pieces that suit the room and each other and lays them out in the real room. Anything of
        /// the same kind already there is replaced, never doubled up: a real piece (a couch from Space Setup) is set to
        /// "replace" with the design's pick, exactly as if chosen on its card, and a virtual piece placed earlier is removed.
        /// </summary>
        public async void DesignMyRoom(string style = null, bool bag = false, string heard = null)
        {
            if (Session == null || m_Designing) return;
            var orb = AssistantOrb.Instance;
            if (bag && (Session.cart == null || Session.cart.Count == 0)) { orb?.Notify("Your bag is empty — add a few pieces first."); return; }
            var styleName = DesignStyles.FirstOrDefault(x => x.key == style)?.label;
            m_Designing = true;
            orb?.Think(bag ? "Arranging your bag…" : styleName != null ? $"Designing a {styleName} room…" : "Designing your room…", heard);
            CatalogPanel.Instance?.Hide();
            try
            {
                await SendGeometry();
                var head = XRInput.Instance.Head;
                var user = new UserDto { position = new Vec3(head.position), forward = new Vec3(Vector3.ProjectOnPlane(head.forward, Vector3.up).normalized) };
                var res = await Api.Design(Session.id, bag ? "bag" : "style", style, FurnitureManager.Instance.CurrentPieces(), user);
                // The session now marks the real pieces the design replaces: RealFurniture paints them out and stands the
                // new pieces in their spots as it syncs. Everything else glides into place.
                if (res.session != null) SetSession(res.session);
                FurnitureManager.Instance.ApplyDesign(res, Session);
                if (!bag) CatalogPanel.Instance?.FocusQuietly("design");
                var line = DesignLine(res);
                if (orb != null) orb.Say(line);
                else Toast.Show(line, 8);
            }
            catch (Exception e)
            {
                if (orb != null) orb.Fail($"I couldn't design the room: {e.Message}");
                else Toast.Show($"Design failed: {e.Message}", 5);
            }
            finally { m_Designing = false; }
        }

        /// <summary>What the designer says after a design: the look, what was swapped out, what stayed, what didn't fit.</summary>
        static string DesignLine(DesignResponse r)
        {
            var n = r.placements.Count;
            var parts = new List<string>();
            if (r.mode == "bag") parts.Add($"Here's your bag, arranged: {n} piece{(n == 1 ? "" : "s")}.");
            else if (!string.IsNullOrEmpty(r.concept)) parts.Add(r.concept.TrimEnd('.') + ".");
            else parts.Add($"Here's a {r.styleLabel} room: {n} pieces.");
            if (r.replacedLabels != null && r.replacedLabels.Count > 0) parts.Add($"I swapped out {Join(r.replacedLabels.Take(3).ToList())}.");
            // Real furniture the user keeps is part of the design.
            var kept = RealFurniture.Instance != null ? RealFurniture.Instance.KeptNames().Where(x => x != "piece").Take(3).ToList() : new List<string>();
            if (kept.Count > 0) parts.Add($"I kept your {Join(kept)} and designed around {(kept.Count == 1 ? "it" : "them")}.");
            if (r.skipped != null && r.skipped.Count > 0)
                parts.Add($"I left out the {Join(r.skipped.Select(x => x.label.ToLower()).Distinct().Take(2).ToList())} — there wasn't room.");
            if (r.usedDefaultRoom) parts.Add("I used a standard room — run Space Setup so I can use yours.");
            return string.Join(" ", parts);
        }
    }
}
