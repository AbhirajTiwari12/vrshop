using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace VRShop.EditorTools
{
    /// <summary>VRShop > Setup Window: every setup step as one button, plus build & deploy helpers.</summary>
    public class VRShopSetupWindow : EditorWindow
    {
        const string k_UrlPref = "VRShop.BackendUrl";
        const string k_PackageId = "com.vrshop.app";
        string m_Url;
        string m_Status = "";
        Vector2 m_Scroll;

        [MenuItem("VRShop/Setup Window", priority = 0)]
        public static void Open() => GetWindow<VRShopSetupWindow>("VRShop Setup").minSize = new Vector2(440, 560);

        [MenuItem("VRShop/2. Configure Project", priority = 2)] static void Configure() => ProjectConfigurator.Run();
        [MenuItem("VRShop/3. Build Scene", priority = 3)] static void BuildScene() => SceneBuilder.Build(EditorPrefs.GetString(k_UrlPref, DefaultUrl()));
        [MenuItem("VRShop/4. Build and Run on Quest", priority = 4)] static void BuildRun() => Build(true);
        [MenuItem("VRShop/Build APK only", priority = 5)] static void BuildOnly() => Build(false);

        static string DefaultUrl() => "http://192.168.1.50:8787";

        void OnEnable() => m_Url = EditorPrefs.GetString(k_UrlPref, DefaultUrl());

        void OnGUI()
        {
            m_Scroll = EditorGUILayout.BeginScrollView(m_Scroll);
            var h = new GUIStyle(EditorStyles.boldLabel) { fontSize = 14 };
            GUILayout.Label("VRShop — Quest 2 setup", h);
            EditorGUILayout.HelpBox("1. Install Packages  →  2. Configure Project  →  3. Build Scene  →  4. Build & Run.\nPlug the Quest in with USB (Developer Mode on) before step 4.", MessageType.Info);

            GUILayout.Space(6);
            GUILayout.Label("Backend URL (as the Quest sees it)", EditorStyles.boldLabel);
            EditorGUI.BeginChangeCheck();
            m_Url = EditorGUILayout.TextField(m_Url);
            if (EditorGUI.EndChangeCheck()) EditorPrefs.SetString(k_UrlPref, m_Url.Trim());
            EditorGUILayout.LabelField("Run the backend on a laptop on the same Wi-Fi; it prints this URL on start.", EditorStyles.miniLabel);
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Test connection")) TestConnection();
                if (GUILayout.Button("Apply to scene")) { SceneBuilder.SetBackendUrl(m_Url); m_Status = "Saved URL into the scene."; }
                if (GUILayout.Button("Send to Quest (adb)")) PushUrlToQuest(m_Url);
            }

            GUILayout.Space(10);
            GUILayout.Label("Setup", EditorStyles.boldLabel);
            if (GUILayout.Button("1. Install / update packages", GUILayout.Height(28))) EditorApplication.ExecuteMenuItem("VRShop/1. Install Packages");
            if (GUILayout.Button("2. Configure project for Quest", GUILayout.Height(28))) ProjectConfigurator.Run();
            if (GUILayout.Button("3. Build scene", GUILayout.Height(28))) SceneBuilder.Build(m_Url);

            GUILayout.Space(10);
            GUILayout.Label("Build", EditorStyles.boldLabel);
            if (GUILayout.Button("4. Build & Run on Quest (USB)", GUILayout.Height(34))) Build(true);
            if (GUILayout.Button("Build APK only (Builds/VRShop.apk)")) Build(false);

            GUILayout.Space(10);
            GUILayout.Label("Checks", EditorStyles.boldLabel);
            Check("Active build target is Android", EditorUserBuildSettings.activeBuildTarget == BuildTarget.Android);
            Check("URP asset assigned", UnityEngine.Rendering.GraphicsSettings.defaultRenderPipeline != null);
            Check("TextMeshPro resources imported", AssetDatabase.FindAssets("t:TMP_Settings", new[] { "Assets" }).Length > 0);
            Check("Runtime materials created", AssetDatabase.IsValidFolder(ProjectConfigurator.MaterialsDir));
            Check("glTF variant keepers created", AssetDatabase.IsValidFolder(ProjectConfigurator.KeepersDir));
            Check("Scene built", File.Exists(SceneBuilder.ScenePath));
            EditorGUILayout.HelpBox("If Meta > Tools > Project Setup Tool shows red items, click Fix All.\n" +
                                    "Editor Play mode works without a headset (a preview room stands in for passthrough): mouse = right controller (click = trigger, scroll = rotate), Tab = A, Backspace = B, hold V = voice, WASD/arrows = move/look.", MessageType.None);
            if (!string.IsNullOrEmpty(m_Status)) EditorGUILayout.HelpBox(m_Status, MessageType.None);
            EditorGUILayout.EndScrollView();
        }

        static void Check(string label, bool ok)
        {
            using (new EditorGUILayout.HorizontalScope())
            {
                var style = new GUIStyle(EditorStyles.label) { normal = { textColor = ok ? new Color(0.3f, 0.8f, 0.4f) : new Color(1f, 0.55f, 0.3f) } };
                GUILayout.Label(ok ? "✔" : "•", style, GUILayout.Width(16));
                GUILayout.Label(label);
            }
        }

        async void TestConnection()
        {
            m_Status = "Testing…";
            try
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
                var body = await http.GetStringAsync(m_Url.TrimEnd('/') + "/api/health");
                m_Status = $"OK: {body}";
            }
            catch (Exception e)
            {
                m_Status = $"Failed: {e.Message}\nIs the backend running? Is this machine on the same network?";
            }
            Repaint();
        }

        static string Adb()
        {
            // Reflection: the Android editor extension assembly only exists when Android Build Support is installed.
            var t = Type.GetType("UnityEditor.Android.AndroidExternalToolsSettings, UnityEditor.Android.Extensions");
            var sdk = t?.GetProperty("sdkRootPath")?.GetValue(null) as string;
            var adb = Path.Combine(sdk ?? "", "platform-tools", Application.platform == RuntimePlatform.WindowsEditor ? "adb.exe" : "adb");
            return File.Exists(adb) ? adb : "adb";
        }

        void PushUrlToQuest(string url)
        {
            var tmp = Path.Combine(Path.GetTempPath(), "vrshop.json");
            File.WriteAllText(tmp, "{\"backendUrl\":\"" + url.Trim() + "\"}");
            var dest = $"/sdcard/Android/data/{k_PackageId}/files/vrshop.json";
            var (code, output) = Run(Adb(), $"push \"{tmp}\" {dest}");
            m_Status = code == 0 ? $"Pushed to Quest ({dest}). Restart the app on the headset." : $"adb failed ({code}): {output}\nInstall/launch the app once first so its data folder exists.";
        }

        static (int, string) Run(string exe, string args)
        {
            try
            {
                var p = Process.Start(new ProcessStartInfo(exe, args) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true });
                var o = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
                p.WaitForExit(20000);
                return (p.ExitCode, o);
            }
            catch (Exception e) { return (-1, e.Message); }
        }

        static void Build(bool run)
        {
            if (!File.Exists(SceneBuilder.ScenePath)) { EditorUtility.DisplayDialog("VRShop", "Build the scene first (step 3).", "OK"); return; }
            BuildApk(run);
        }

        /// <summary>Builds Builds/VRShop.apk (and installs + launches it on the USB-connected Quest if run).</summary>
        public static BuildReport BuildApk(bool run)
        {
            if (!File.Exists(SceneBuilder.ScenePath)) { Debug.LogError("[VRShop] Build the scene first (step 3)."); return null; }
            // Runtime materials keep their shaders in the build; refresh them so newly added shaders are included.
            ProjectConfigurator.CreateRuntimeMaterials();
            Directory.CreateDirectory("Builds");
            var options = new BuildPlayerOptions
            {
                scenes = new[] { SceneBuilder.ScenePath },
                locationPathName = "Builds/VRShop.apk",
                target = BuildTarget.Android,
                targetGroup = BuildTargetGroup.Android,
                options = run ? BuildOptions.AutoRunPlayer : BuildOptions.None,
            };
            var report = BuildPipeline.BuildPlayer(options);
            if (report.summary.result == BuildResult.Succeeded)
                Debug.Log($"[VRShop] Built {options.locationPathName} ({report.summary.totalSize / (1024 * 1024)} MB){(run ? " and launched on the Quest" : "")}.");
            else
                Debug.LogError($"[VRShop] Build {report.summary.result}: {report.summary.totalErrors} errors. See Console.");
            return report;
        }
    }
}
