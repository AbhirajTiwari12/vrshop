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

        /// <summary>
        /// AI "Design my room": lays out the cart (or, if empty, the top pick of each recommended category)
        /// in the real room using the headset's walls + furniture, then animates every piece into place.
        /// </summary>
        public async void DesignMyRoom()
        {
            if (Session == null) return;
            // Real furniture the user keeps is part of the design: don't suggest a second sofa next to their couch.
            var real = RealFurniture.Instance;
            var kept = real != null ? real.CoveredCategories() : new HashSet<string>();
            var ids = Session.cart != null && Session.cart.Count > 0
                ? Session.cart.Select(c => c.productId).ToList()
                : Session.categories.Where(c => c.origin == "analysis" && c.productIds.Count > 0 && !kept.Contains(c.category))
                    // Themed rows lead with the themed product (usually a store listing without a 3D model); others prefer 3D.
                    .Select(c => c.theme != null && c.theme.Count > 0 ? c.productIds[0] : c.productIds.FirstOrDefault(id => Session.GetProduct(id)?.model?.kind == "official") ?? c.productIds[0])
                    .Take(7).ToList();
            // Include what is already placed so the layout accounts for it.
            foreach (var it in FurnitureManager.Instance.Items)
                if (!ids.Contains(it.Product.id)) ids.Add(it.Product.id);
            var orb = AssistantOrb.Instance;
            if (ids.Count == 0) { orb?.Notify("There's nothing to arrange yet — add a few pieces first."); return; }

            orb?.Think("Arranging your room…");
            CatalogPanel.Instance?.Hide();
            try
            {
                await SendGeometry();
                var head = XRInput.Instance.Head;
                var user = new UserDto { position = new Vec3(head.position), forward = new Vec3(Vector3.ProjectOnPlane(head.forward, Vector3.up).normalized) };
                // Replacements stay in their real piece's spot; everything else arranges around them.
                var res = await Api.Layout(Session.id, ids, user, real != null ? real.FixedPlacements() : null);
                FurnitureManager.Instance.ApplyLayout(res.placements, Session);
                var n = res.placements.Count;
                var why = res.placements.Select(p => p.reason).FirstOrDefault(r => !string.IsNullOrEmpty(r) && !r.StartsWith("in place of"));
                var line = $"Here's a first layout: {n} piece{(n == 1 ? "" : "s")}, arranged around your space.";
                var keptNames = real != null ? real.KeptNames() : new List<string>();
                if (keptNames.Count > 0) line += $" I kept your {Join(keptNames)} and designed around {(keptNames.Count == 1 ? "it" : "them")}.";
                if (!string.IsNullOrEmpty(why)) line += $" {char.ToUpper(why[0])}{why.Substring(1).TrimEnd('.')}.";
                if (res.usedDefaultRoom) line += " I used a standard room — run Space Setup on the headset so I can use yours.";
                if (orb != null) orb.Say(line);
                else Toast.Show(line, 7);
            }
            catch (Exception e)
            {
                if (orb != null) orb.Fail($"I couldn't arrange the room: {e.Message}");
                else Toast.Show($"Layout failed: {e.Message}", 5);
            }
        }
    }
}
