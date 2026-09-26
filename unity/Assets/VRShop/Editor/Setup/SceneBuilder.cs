using System.Linq;
using Meta.XR.MRUtilityKit;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering.Universal;
using VRShop.Core;

namespace VRShop.EditorTools
{
    /// <summary>
    /// Step 3: build the one scene the app needs: Meta camera rig (with passthrough underlay), MR Utility Kit
    /// (reads the Quest's Space Setup; loads a sample room JSON in the Editor), a key light, and VRShopApp
    /// (which creates everything else at runtime).
    /// </summary>
    public static class SceneBuilder
    {
        public const string ScenePath = "Assets/VRShop/Scenes/VRShop.unity";
        const string k_RigPrefab = "Packages/com.meta.xr.sdk.core/Prefabs/OVRCameraRig.prefab";
        const string k_SampleRoom = "Packages/com.meta.xr.mrutilitykit/Core/Rooms/Json/MeshLivingRoom1.json";

        public static void Build(string backendUrl)
        {
            if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // Camera rig
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(k_RigPrefab);
            if (prefab == null)
            {
                EditorUtility.DisplayDialog("VRShop", $"Couldn't find {k_RigPrefab}. Is the Meta XR Core SDK installed?", "OK");
                return;
            }
            var rig = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            rig.name = "OVRCameraRig";
            var manager = rig.GetComponent<OVRManager>() ?? rig.AddComponent<OVRManager>();
            manager.isInsightPassthroughEnabled = true;
            var so = new SerializedObject(manager);
            foreach (var prop in new[] { "requestScenePermissionOnStartup", "requestRecordAudioPermissionOnStartup" })
            {
                var p = so.FindProperty(prop);
                if (p != null) p.boolValue = true;
            }
            so.ApplyModifiedPropertiesWithoutUndo();
            if (rig.GetComponent<OVRPassthroughLayer>() == null) rig.AddComponent<OVRPassthroughLayer>();

            var cam = rig.GetComponentsInChildren<Camera>(true).FirstOrDefault(c => c.name.Contains("CenterEye")) ?? rig.GetComponentInChildren<Camera>(true);
            if (cam != null)
            {
                cam.clearFlags = CameraClearFlags.SolidColor;
                cam.backgroundColor = new Color(0, 0, 0, 0);
                cam.nearClipPlane = 0.03f;
                cam.farClipPlane = 60f;
                cam.tag = "MainCamera";
                var data = cam.GetUniversalAdditionalCameraData();
                if (data != null)
                {
                    data.renderPostProcessing = false;
                    data.antialiasing = AntialiasingMode.None;
                    data.renderShadows = true;
                }
            }

            // MR Utility Kit: reads Space Setup on device, a sample room JSON in the Editor.
            var mrukGo = new GameObject("MRUK");
            var mruk = mrukGo.AddComponent<MRUK>();
            var sample = AssetDatabase.LoadAssetAtPath<TextAsset>(k_SampleRoom);
            mruk.SceneSettings = new MRUK.MRUKSettings
            {
                DataSource = MRUK.SceneDataSource.DeviceWithJsonFallback,
                SceneJsons = sample != null ? new[] { sample } : new TextAsset[0],
                RoomIndex = 0,
                LoadSceneOnStartup = true,
            };
            mruk.EnableWorldLock = true;

            // Key light (LightingRig tunes it from the AI room analysis at runtime)
            var lightGo = new GameObject("KeyLight");
            var light = lightGo.AddComponent<Light>();
            light.type = LightType.Directional;
            light.shadows = LightShadows.Soft;
            light.intensity = 1.1f;
            lightGo.transform.rotation = Quaternion.Euler(62, -35, 0);

            // App
            var appGo = new GameObject("VRShopApp");
            var app = appGo.AddComponent<VRShopApp>();
            app.backendUrl = backendUrl;

            System.IO.Directory.CreateDirectory("Assets/VRShop/Scenes");
            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            AssetDatabase.SaveAssets();
            Selection.activeGameObject = appGo;
            Debug.Log($"[VRShop] Scene built at {ScenePath} (backend {backendUrl}).");
        }

        /// <summary>Update the backend URL in the saved scene without rebuilding it.</summary>
        public static void SetBackendUrl(string url)
        {
            var app = Object.FindFirstObjectByType<VRShopApp>();
            if (app == null) return;
            Undo.RecordObject(app, "Set backend URL");
            app.backendUrl = url;
            EditorUtility.SetDirty(app);
            EditorSceneManager.MarkSceneDirty(app.gameObject.scene);
            EditorSceneManager.SaveOpenScenes();
        }
    }
}
