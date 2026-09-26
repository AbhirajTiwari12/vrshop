using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRShop.Core;
using VRShop.Furniture;
using VRShop.Room;

namespace VRShop.EditorTools
{
    /// <summary>
    /// End-to-end check without a headset: enters Play mode in the VRShop scene, waits for the backend session
    /// and the MRUK room, runs "Design my room", and waits until every placed item has its real GLB loaded.
    /// Exits Unity with 0 on success, 1 on any error/exception or timeout. Needs the backend running.
    ///
    ///   Unity -batchmode -projectPath unity -buildTarget Android -executeMethod VRShop.EditorTools.PlayModeSmoke.Run
    /// </summary>
    [InitializeOnLoad]
    public static class PlayModeSmoke
    {
        const string k_Active = "VRShop.Smoke.Active", k_Deadline = "VRShop.Smoke.Deadline", k_Errors = "VRShop.Smoke.Errors", k_Designed = "VRShop.Smoke.Designed", k_SettleAt = "VRShop.Smoke.SettleAt";
        const double k_TimeoutSeconds = 150;

        static PlayModeSmoke()
        {
            // Entering Play mode reloads scripts, so state lives in SessionState and hooks are re-added here.
            if (!SessionState.GetBool(k_Active, false)) return;
            Application.logMessageReceived += OnLog;
            EditorApplication.update += Tick;
        }

        public static void Run()
        {
            SessionState.SetBool(k_Active, true);
            SessionState.SetFloat(k_Deadline, (float)(EditorApplication.timeSinceStartup + k_TimeoutSeconds));
            SessionState.SetInt(k_Errors, 0);
            SessionState.SetBool(k_Designed, false);
            SessionState.SetFloat(k_SettleAt, 0);
            Application.logMessageReceived += OnLog;
            EditorApplication.update += Tick;
            EditorSceneManager.OpenScene(SceneBuilder.ScenePath);
            EditorApplication.EnterPlaymode();
        }

        static void OnLog(string message, string stack, LogType type)
        {
            if (type != LogType.Error && type != LogType.Exception && type != LogType.Assert) return;
            SessionState.SetInt(k_Errors, SessionState.GetInt(k_Errors, 0) + 1);
            Debug.Log($"[VRShop smoke] captured {type}: {message}");
        }

        static void Tick()
        {
            if (!EditorApplication.isPlaying) return;
            if (EditorApplication.timeSinceStartup > SessionState.GetFloat(k_Deadline, 0)) { Finish(false, "timed out"); return; }
            if (SessionState.GetInt(k_Errors, 0) > 0) { Finish(false, "errors logged"); return; }

            var app = VRShopApp.Instance;
            var room = RoomService.Instance;
            if (app == null || app.Session == null || room == null || !room.Ready || app.Session.status != "ready") return;

            if (!SessionState.GetBool(k_Designed, false))
            {
                SessionState.SetBool(k_Designed, true);
                Debug.Log($"[VRShop smoke] session {app.Session.id} ready with {app.Session.categories.Count} categories; room has {room.Walls.Count} walls. Running Design my room…");
                app.DesignMyRoom();
                return;
            }
            var items = FurnitureManager.Instance.Items.Where(i => i != null).ToList();
            if (items.Count == 0 || items.Any(i => !i.ModelLoaded)) return;
            // Items glide into place one after another (~2.5 s for 7 pieces); let them land before judging.
            if (SessionState.GetFloat(k_SettleAt, 0) == 0) SessionState.SetFloat(k_SettleAt, (float)EditorApplication.timeSinceStartup + 4f);
            if (EditorApplication.timeSinceStartup < SessionState.GetFloat(k_SettleAt, 0)) return;
            var distinct = items.Select(i => new Vector2(Mathf.Round(i.transform.position.x * 20), Mathf.Round(i.transform.position.z * 20))).Distinct().Count();
            if (distinct < items.Count - 1) { Finish(false, $"layout collapsed: {items.Count} items at {distinct} positions"); return; }
            Finish(true, $"{items.Count} items placed with real models: " +
                         string.Join(", ", items.Select(i => $"{i.Product.category}@({i.transform.position.x:F2},{i.transform.position.z:F2}) {i.Fit}")));
        }

        static void Finish(bool ok, string why)
        {
            EditorApplication.update -= Tick;
            Application.logMessageReceived -= OnLog;
            SessionState.SetBool(k_Active, false);
            Debug.Log($"[VRShop smoke] {(ok ? "PASS" : "FAIL")}: {why}");
            EditorApplication.ExitPlaymode();
            EditorApplication.Exit(ok ? 0 : 1);
        }
    }
}
