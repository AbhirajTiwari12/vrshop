using UnityEngine;
using UnityEngine.Rendering;
using VRShop.Api;

namespace VRShop.Rendering
{
    /// <summary>
    /// One shadow-casting directional light + ambient, tuned from the AI room analysis
    /// (warm/neutral/cool mood, brightness, color temperature) so virtual furniture is lit like the real room.
    /// </summary>
    public class LightingRig : MonoBehaviour
    {
        public static LightingRig Instance { get; private set; }
        Light m_Sun;

        void Awake()
        {
            Instance = this;
            m_Sun = FindMainLight();
            if (m_Sun == null)
            {
                var go = new GameObject("KeyLight");
                go.transform.SetParent(transform, false);
                m_Sun = go.AddComponent<Light>();
                m_Sun.type = LightType.Directional;
            }
            m_Sun.transform.rotation = Quaternion.Euler(62f, -35f, 0f);
            m_Sun.shadows = LightShadows.Soft;
            m_Sun.shadowStrength = 0.85f;
            m_Sun.shadowBias = 0.02f;
            m_Sun.shadowNormalBias = 0.3f;
            Apply(null);
        }

        static Light FindMainLight()
        {
            foreach (var l in FindObjectsByType<Light>(FindObjectsSortMode.None))
                if (l.type == LightType.Directional) return l;
            return null;
        }

        public void Apply(RoomAnalysis room)
        {
            var kelvin = room?.lighting != null && room.lighting.kelvin > 1000 ? room.lighting.kelvin : 4000f;
            var brightness = room?.lighting != null ? Mathf.Clamp01(room.lighting.brightness) : 0.6f;
            var tint = VRShopMaterials.Kelvin(kelvin);

            m_Sun.color = tint;
            m_Sun.intensity = Mathf.Lerp(0.8f, 1.35f, brightness);

            // Soft trilight ambient: warm-ish sky, neutral horizon, darker floor bounce.
            RenderSettings.ambientMode = AmbientMode.Trilight;
            var amb = Mathf.Lerp(0.45f, 0.75f, brightness);
            RenderSettings.ambientSkyColor = Color.Lerp(Color.white, tint, 0.5f) * amb;
            RenderSettings.ambientEquatorColor = Color.Lerp(Color.white, tint, 0.3f) * amb * 0.85f;
            var floorHex = room?.floor?.colorHex;
            RenderSettings.ambientGroundColor = VRShopMaterials.Hex(floorHex, new Color(0.45f, 0.4f, 0.36f)) * amb * 0.5f;

            // Reflections for glossy wood/metal come from a procedural sky tinted like the room.
            var sky = VRShopMaterials.Skybox;
            if (sky != null && sky.shader.name == "Skybox/Procedural")
            {
                sky.SetColor("_SkyTint", Color.Lerp(new Color(0.6f, 0.6f, 0.62f), tint, 0.4f));
                sky.SetColor("_GroundColor", RenderSettings.ambientGroundColor * 2f);
                sky.SetFloat("_Exposure", Mathf.Lerp(0.9f, 1.3f, brightness));
                RenderSettings.skybox = sky;
                RenderSettings.defaultReflectionMode = DefaultReflectionMode.Skybox;
            }
            DynamicGI.UpdateEnvironment();
        }
    }
}
