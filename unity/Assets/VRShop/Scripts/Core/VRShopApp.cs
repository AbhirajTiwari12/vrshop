using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Meta.XR.MRUtilityKit;
using Newtonsoft.Json;
using UnityEngine;
using VRShop.Api;
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
        public event Action<Session> SessionChanged;

        string m_RoomSignature;
        bool m_GeometrySent;
        int m_PollCount;

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
            Add<Toast>("Toast");
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
                    Debug.Log($"[VRShop] Connected to {Api.BaseUrl} (openai={h.capabilities?.openai}, serpapi={h.capabilities?.serpapi}, 3D={h.capabilities?.generator})");
                    return;
                }
                catch (Exception e)
                {
                    var msg = $"Can't reach the VRShop server at\n{Api.BaseUrl}\n\n<size=24><color=#A9B0BC>Is the backend running and on the same Wi-Fi? ({e.Message})\nRetrying…</color></size>";
                    CatalogPanel.Instance?.ShowMessage(msg);
                    if (attempt == 0) Toast.Show("Connecting to the VRShop server…", 4);
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
                            Toast.Show("No room scanned yet — starting a demo room. Scan yours with the phone app!", 6);
                            s = await Api.CreateDemoSession();
                        }
                    }
                    SetSession(s);
                    return;
                }
                catch (Exception e)
                {
                    CatalogPanel.Instance?.ShowMessage($"Couldn't load your room session\n<size=24><color=#A9B0BC>{e.Message}</color></size>");
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
                            Toast.Show("New room from your phone — loading it", 4);
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
                Toast.Show(s.checkout.summary, 8);
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
            var ids = Session.cart != null && Session.cart.Count > 0
                ? Session.cart.Select(c => c.productId).ToList()
                : Session.categories.Where(c => c.origin == "analysis" && c.productIds.Count > 0)
                    .Select(c => c.productIds.FirstOrDefault(id => Session.GetProduct(id)?.model?.kind == "official") ?? c.productIds[0])
                    .Take(7).ToList();
            // Include what is already placed so the layout accounts for it.
            foreach (var it in FurnitureManager.Instance.Items)
                if (!ids.Contains(it.Product.id)) ids.Add(it.Product.id);
            if (ids.Count == 0) { Toast.Show("Nothing to arrange yet"); return; }

            Toast.Sticky("Designing your room…");
            CatalogPanel.Instance?.Hide();
            try
            {
                await SendGeometry();
                var head = XRInput.Instance.Head;
                var user = new UserDto { position = new Vec3(head.position), forward = new Vec3(Vector3.ProjectOnPlane(head.forward, Vector3.up).normalized) };
                var res = await Api.Layout(Session.id, ids, user);
                FurnitureManager.Instance.ApplyLayout(res.placements, Session);
                var why = res.placements.Where(p => !string.IsNullOrEmpty(p.reason)).Select(p => $"{Session.GetProduct(p.productId)?.category?.Replace('_', ' ')}: {p.reason}").Take(3);
                Toast.Show($"Arranged {res.placements.Count} pieces{(res.usedDefaultRoom ? " (default room — run Space Setup for yours)" : "")}\n<size=22>{string.Join("\n", why)}</size>", 7);
            }
            catch (Exception e)
            {
                Toast.Show($"Layout failed: {e.Message}", 5);
            }
        }
    }
}
