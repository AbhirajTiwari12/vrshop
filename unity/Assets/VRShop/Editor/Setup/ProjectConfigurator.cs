using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.Build;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using VRShop.Rendering;

namespace VRShop.EditorTools
{
    /// <summary>
    /// Step 2: configure the project for Quest (Android, IL2CPP/ARM64, Vulkan, linear, ASTC, cleartext HTTP to
    /// the LAN backend), Meta features (passthrough, scene, anchors, hands), URP quality for Quest 2, runtime
    /// materials, glTFast shader-variant keepers, TMP essentials, and finally Meta's own Project Setup Tool fixes.
    /// </summary>
    public static class ProjectConfigurator
    {
        public const string ResourcesRoot = "Assets/VRShop/Resources";
        public const string MaterialsDir = ResourcesRoot + "/" + VRShopMaterials.ResourceFolder;
        public const string KeepersDir = ResourcesRoot + "/GltfVariantKeepers";
        const string k_GltfShaderDir = "Packages/com.unity.cloud.gltfast/Runtime/Shader/";

        public static async void Run()
        {
            try
            {
                EditorUtility.DisplayProgressBar("VRShop", "Switching to Android…", 0.05f);
                if (EditorUserBuildSettings.activeBuildTarget != BuildTarget.Android)
                {
                    // Switching platform recompiles and reloads scripts, which would cut this async method short.
                    EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Android, BuildTarget.Android);
                    EditorUtility.ClearProgressBar();
                    EditorUtility.DisplayDialog("VRShop", "Switched the project to Android.\n\nWhen Unity finishes recompiling, click  2. Configure project  again.", "OK");
                    return;
                }
                await ConfigureAllAsync();
                EditorUtility.DisplayDialog("VRShop", "Project configured for Meta Quest.\n\nNext: 3. Build Scene.\n\n(Check Meta > Tools > Project Setup Tool shows no red items; click Fix All if it does.)", "OK");
            }
            catch (Exception e)
            {
                Debug.LogError($"[VRShop] Configure failed: {e}");
                EditorUtility.DisplayDialog("VRShop", $"Configure hit an error:\n{e.Message}\n\nSee the Console for details.", "OK");
            }
            finally
            {
                EditorUtility.ClearProgressBar();
            }
        }

        /// <summary>
        /// Every configuration step, with no dialogs (used by the menu and by BatchSetup on the command line).
        /// The active build target must already be Android.
        /// </summary>
        public static async Task ConfigureAllAsync()
        {
            EditorUserBuildSettings.androidBuildSubtarget = MobileTextureSubtarget.ASTC;
            EditorUtility.DisplayProgressBar("VRShop", "Player settings…", 0.15f);
            ConfigurePlayer();
            EditorUtility.DisplayProgressBar("VRShop", "XR loader…", 0.2f);
            EnsureOpenXrLoader();
            EditorUtility.DisplayProgressBar("VRShop", "Meta XR features…", 0.25f);
            ConfigureMeta();
            EditorUtility.DisplayProgressBar("VRShop", "URP for Quest 2…", 0.35f);
            ConfigureUrp();
            EditorUtility.DisplayProgressBar("VRShop", "TextMeshPro resources…", 0.45f);
            ImportTmpEssentials();
            EditorUtility.DisplayProgressBar("VRShop", "Materials…", 0.55f);
            CreateRuntimeMaterials();
            CreateGltfVariantKeepers();
            EditorUtility.DisplayProgressBar("VRShop", "OpenXR features…", 0.65f);
            ConfigureOpenXrFeatures();
            AssetDatabase.SaveAssets();

            EditorUtility.DisplayProgressBar("VRShop", "Meta Project Setup Tool: fixing recommended settings…", 0.8f);
            try { await OVRProjectSetup.FixAllAsync(BuildTargetGroup.Android); }
            catch (Exception e) { Debug.LogWarning($"[VRShop] Meta Project Setup Tool: {e.Message}. Open Meta > Tools > Project Setup Tool and click Fix All."); }
            ConfigureOpenXrFeatures(); // again, in case Fix All changed the feature set
            AssetDatabase.SaveAssets();
            Debug.Log("[VRShop] Project configured for Quest. Next: VRShop > Setup Window > 3. Build Scene.");
        }

        /// <summary>XR Plug-in Management → Android → OpenXR (the runtime Meta XR SDK 207 runs on).</summary>
        static void EnsureOpenXrLoader()
        {
            if (!EditorBuildSettings.TryGetConfigObject(UnityEngine.XR.Management.XRGeneralSettings.k_SettingsKey, out UnityEditor.XR.Management.XRGeneralSettingsPerBuildTarget perTarget) || perTarget == null)
            {
                EnsureDir("Assets/XR");
                perTarget = ScriptableObject.CreateInstance<UnityEditor.XR.Management.XRGeneralSettingsPerBuildTarget>();
                AssetDatabase.CreateAsset(perTarget, "Assets/XR/XRGeneralSettingsPerBuildTarget.asset");
                EditorBuildSettings.AddConfigObject(UnityEngine.XR.Management.XRGeneralSettings.k_SettingsKey, perTarget, true);
            }
            if (!perTarget.HasSettingsForBuildTarget(BuildTargetGroup.Android)) perTarget.CreateDefaultSettingsForBuildTarget(BuildTargetGroup.Android);
            if (!perTarget.HasManagerSettingsForBuildTarget(BuildTargetGroup.Android)) perTarget.CreateDefaultManagerSettingsForBuildTarget(BuildTargetGroup.Android);
            var general = perTarget.SettingsForBuildTarget(BuildTargetGroup.Android);
            general.InitManagerOnStart = true;
            var manager = perTarget.ManagerSettingsForBuildTarget(BuildTargetGroup.Android);
            if (!manager.activeLoaders.Any(l => l != null && l.GetType().Name == "OpenXRLoader"))
            {
                if (UnityEditor.XR.Management.Metadata.XRPackageMetadataStore.AssignLoader(manager, "UnityEngine.XR.OpenXR.OpenXRLoader", BuildTargetGroup.Android))
                    Debug.Log("[VRShop] Enabled the OpenXR loader for Android.");
                else
                    Debug.LogError("[VRShop] Couldn't enable the OpenXR loader: Project Settings > XR Plug-in Management > Android > tick OpenXR.");
            }
            EditorUtility.SetDirty(general);
            EditorUtility.SetDirty(manager);
            EditorUtility.SetDirty(perTarget);
        }

        static void ConfigurePlayer()
        {
            PlayerSettings.companyName = "VRShop";
            PlayerSettings.productName = "VRShop";
            var android = NamedBuildTarget.Android;
            PlayerSettings.SetApplicationIdentifier(android, "com.vrshop.app");
            PlayerSettings.SetScriptingBackend(android, ScriptingImplementation.IL2CPP);
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
            PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel32;
            PlayerSettings.Android.forceInternetPermission = true;
            PlayerSettings.colorSpace = ColorSpace.Linear;
            PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.Android, false);
            PlayerSettings.SetGraphicsAPIs(BuildTarget.Android, new[] { GraphicsDeviceType.Vulkan });
            PlayerSettings.defaultInterfaceOrientation = UIOrientation.LandscapeLeft;
            // The Quest talks to the backend over plain HTTP on the LAN.
            PlayerSettings.insecureHttpOption = InsecureHttpOption.AlwaysAllowed;
        }

        static void ConfigureMeta()
        {
            var cfg = OVRProjectConfig.CachedProjectConfig;
            if (cfg == null) { Debug.LogWarning("[VRShop] OVRProjectConfig not found"); return; }
            if (!cfg.targetDeviceTypes.Contains(OVRProjectConfig.DeviceType.Quest2)) cfg.targetDeviceTypes.Add(OVRProjectConfig.DeviceType.Quest2);
            cfg.handTrackingSupport = OVRProjectConfig.HandTrackingSupport.ControllersAndHands;
            cfg.insightPassthroughSupport = OVRProjectConfig.FeatureSupport.Required;
            cfg.sceneSupport = OVRProjectConfig.FeatureSupport.Required;
            cfg.anchorSupport = OVRProjectConfig.AnchorSupport.Enabled;
            // Meta's network security config sets cleartextTrafficPermitted=false, which silently blocks the
            // plain-HTTP LAN backend (overriding PlayerSettings.insecureHttpOption). Use a https tunnel if you
            // ever need to turn this back on.
            cfg.enableNSCConfig = false;
            OVRProjectConfig.CommitProjectConfig(cfg);
        }

        static IEnumerable<UniversalRenderPipelineAsset> UrpAssets()
        {
            var set = new HashSet<UniversalRenderPipelineAsset>();
            if (GraphicsSettings.defaultRenderPipeline is UniversalRenderPipelineAsset d) set.Add(d);
            for (var i = 0; i < QualitySettings.names.Length; i++)
                if (QualitySettings.GetRenderPipelineAssetAt(i) is UniversalRenderPipelineAsset q) set.Add(q);
            return set;
        }

        static void ConfigureUrp()
        {
            var assets = UrpAssets().ToList();
            if (assets.Count == 0)
            {
                Debug.LogWarning("[VRShop] No URP asset found. Create the project from the 'Universal 3D' template (see unity/README.md).");
                return;
            }
            foreach (var a in assets)
            {
                var so = new SerializedObject(a);
                void SetInt(string n, int v) { var p = so.FindProperty(n); if (p != null) p.intValue = v; }
                void SetBool(string n, bool v) { var p = so.FindProperty(n); if (p != null) p.boolValue = v; }
                void SetFloat(string n, float v) { var p = so.FindProperty(n); if (p != null) p.floatValue = v; }
                SetInt("m_MSAA", 4);                         // crisp edges on Quest (tile-based MSAA is cheap)
                SetBool("m_SupportsHDR", false);             // HDR is expensive on Quest 2
                SetFloat("m_RenderScale", 1f);
                SetBool("m_MainLightShadowsSupported", true);
                SetInt("m_MainLightShadowmapResolution", 2048);
                SetFloat("m_ShadowDistance", 7f);
                SetInt("m_ShadowCascadeCount", 1);
                SetBool("m_SoftShadowsSupported", true);
                SetBool("m_SupportsCameraOpaqueTexture", false);
                SetBool("m_SupportsCameraDepthTexture", false);
                SetBool("m_UseSRPBatcher", true);
                so.ApplyModifiedPropertiesWithoutUndo();
                EditorUtility.SetDirty(a);
            }
            Debug.Log($"[VRShop] Tuned {assets.Count} URP asset(s) for Quest 2 (MSAA 4x, no HDR, 2K soft shadows).");
        }

        static void ImportTmpEssentials()
        {
            if (AssetDatabase.FindAssets("t:TMP_Settings", new[] { "Assets" }).Length > 0) return;
            foreach (var pkg in new[] { "Packages/com.unity.ugui/Package Resources/TMP Essential Resources.unitypackage", "Packages/com.unity.textmeshpro/Package Resources/TMP Essential Resources.unitypackage" })
            {
                var full = Path.GetFullPath(pkg);
                if (!File.Exists(full)) continue;
                AssetDatabase.ImportPackage(full, false);
                Debug.Log("[VRShop] Imported TMP Essential Resources.");
                return;
            }
            Debug.LogWarning("[VRShop] Couldn't find TMP Essential Resources. Use Window > TextMeshPro > Import TMP Essential Resources.");
        }

        static void EnsureDir(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return;
            var parent = Path.GetDirectoryName(path)?.Replace('\\', '/');
            if (!string.IsNullOrEmpty(parent)) EnsureDir(parent);
            AssetDatabase.CreateFolder(parent, Path.GetFileName(path));
        }

        static void SaveMaterial(string dir, string name, Shader shader, Action<Material> setup = null)
        {
            if (shader == null) { Debug.LogWarning($"[VRShop] Shader for {name} not found"); return; }
            var path = $"{dir}/{name}.mat";
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null)
            {
                mat = new Material(shader) { name = name };
                setup?.Invoke(mat);
                AssetDatabase.CreateAsset(mat, path);
            }
            else
            {
                mat.shader = shader;
                setup?.Invoke(mat);
                EditorUtility.SetDirty(mat);
            }
        }

        public static void CreateRuntimeMaterials()
        {
            EnsureDir(MaterialsDir);
            SaveMaterial(MaterialsDir, "ShadowCatcher", Shader.Find("VRShop/ShadowCatcher"));
            SaveMaterial(MaterialsDir, "DepthOccluder", Shader.Find("VRShop/DepthOccluder"));
            SaveMaterial(MaterialsDir, "BlobShadow", Shader.Find("VRShop/BlobShadow"));
            SaveMaterial(MaterialsDir, "UnlitTransparent", Shader.Find("VRShop/UnlitTransparent"));
            SaveMaterial(MaterialsDir, "UnlitColor", Shader.Find("Universal Render Pipeline/Unlit"));
            SaveMaterial(MaterialsDir, "Lit", Shader.Find("Universal Render Pipeline/Lit"));
            SaveMaterial(MaterialsDir, "Skybox", Shader.Find("Skybox/Procedural"), m =>
            {
                m.SetFloat("_SunSize", 0.02f);
                m.SetFloat("_AtmosphereThickness", 0.8f);
                m.SetFloat("_Exposure", 1.1f);
            });
            AssetDatabase.SaveAssets();
        }

        /// <summary>
        /// glTFast picks shader variants at runtime from material features. Unity strips variants no build
        /// material uses, so we ship one placeholder material per feature combination the backend can emit
        /// (it normalizes every GLB to metallic-roughness with these options).
        /// </summary>
        public static void CreateGltfVariantKeepers()
        {
            EnsureDir(KeepersDir);
            var lit = AssetDatabase.LoadAssetAtPath<Shader>(k_GltfShaderDir + "glTF-pbrMetallicRoughness.shadergraph") ?? Shader.Find("Shader Graphs/glTF-pbrMetallicRoughness");
            var unlit = AssetDatabase.LoadAssetAtPath<Shader>(k_GltfShaderDir + "glTF-unlit.shadergraph") ?? Shader.Find("Shader Graphs/glTF-unlit");
            var modes = new[] { "Opaque", "Mask", "Blend" };
            var n = 0;
            foreach (var mode in modes)
            foreach (var occlusion in new[] { false, true })
            foreach (var emissive in new[] { false, true })
            foreach (var texTransform in new[] { false, true })
            {
                var kws = new List<string>();
                if (occlusion) kws.Add("_OCCLUSION");
                if (emissive) kws.Add("_EMISSIVE");
                if (texTransform) kws.Add("_TEXTURE_TRANSFORM");
                var name = $"glTF_{mode}{(occlusion ? "_Occ" : "")}{(emissive ? "_Emi" : "")}{(texTransform ? "_TT" : "")}";
                SaveMaterial(KeepersDir, name, lit, m => ApplyMode(m, mode, kws));
                n++;
            }
            if (unlit != null)
            {
                SaveMaterial(KeepersDir, "glTF_Unlit_Opaque", unlit, m => ApplyMode(m, "Opaque", new List<string>()));
                SaveMaterial(KeepersDir, "glTF_Unlit_Blend", unlit, m => ApplyMode(m, "Blend", new List<string>()));
            }
            AssetDatabase.SaveAssets();
            Debug.Log($"[VRShop] Created {n} glTFast shader-variant keeper materials in {KeepersDir}.");
        }

        static void ApplyMode(Material m, string mode, List<string> keywords)
        {
            foreach (var k in m.shaderKeywords) m.DisableKeyword(k);
            foreach (var k in keywords) m.EnableKeyword(k);
            if (mode == "Mask")
            {
                m.EnableKeyword("_ALPHATEST_ON");
                m.SetOverrideTag("RenderType", "TransparentCutout");
                if (m.HasProperty("_AlphaClip")) m.SetFloat("_AlphaClip", 1);
            }
            else if (mode == "Blend")
            {
                m.SetOverrideTag("RenderType", "Transparent");
                m.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
                m.EnableKeyword("_DISABLE_SSR_TRANSPARENT");
                m.EnableKeyword("_ENABLE_FOG_ON_TRANSPARENT");
                m.SetShaderPassEnabled("DepthOnly", false);
                if (m.HasProperty("_Surface")) m.SetFloat("_Surface", 1);
                if (m.HasProperty("_ZWrite")) m.SetFloat("_ZWrite", 0);
                m.renderQueue = (int)RenderQueue.Transparent;
            }
        }

        static void ConfigureOpenXrFeatures()
        {
#if VRSHOP_HAS_OPENXR
            var settings = UnityEngine.XR.OpenXR.OpenXRSettings.GetSettingsForBuildTargetGroup(BuildTargetGroup.Android);
            if (settings == null) return;
            var enabled = new List<string>();
            foreach (var f in settings.GetFeatures())
            {
                var t = f.GetType().Name;
                if (t == "MetaQuestFeature" || t == "MetaXRFeature" || t == "OculusTouchControllerProfile" || t == "MetaQuestTouchPlusControllerProfile" || t == "MetaQuestTouchProControllerProfile")
                {
                    if (!f.enabled) { f.enabled = true; enabled.Add(t); }
                }
            }
            EditorUtility.SetDirty(settings);
            if (enabled.Count > 0) Debug.Log($"[VRShop] Enabled OpenXR features: {string.Join(", ", enabled)}");
#endif
        }
    }
}
