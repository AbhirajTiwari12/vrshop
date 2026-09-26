using System;
using UnityEngine;
using UnityEngine.XR;
using VRShop.Room;

namespace VRShop.Rendering
{
    public enum ViewMode { MixedReality, EditorPreview }

    /// <summary>
    /// VRShop is mixed-reality only: on the headset you always see your real room through passthrough with
    /// furniture composited in. The Mac Editor can't render passthrough, so there (and only there) the room from
    /// MRUK's sample JSON is drawn as a simple virtual room so you can test placement without a headset.
    /// </summary>
    public class PassthroughController : MonoBehaviour
    {
        public static PassthroughController Instance { get; private set; }
        public ViewMode Mode { get; private set; } = ViewMode.MixedReality;
        public event Action<ViewMode> ModeChanged;

        /// <summary>True when there's no passthrough to show, so a stand-in room must be drawn.</summary>
        public static bool NeedsEditorPreview => Application.isEditor && !XRSettings.isDeviceActive;

        public Color previewBackground = new Color(0.82f, 0.84f, 0.87f);

        OVRPassthroughLayer m_Layer;
        Camera m_Cam;

        void Awake() => Instance = this;

        void Start()
        {
            m_Layer = FindFirstObjectByType<OVRPassthroughLayer>();
            m_Cam = Camera.main;
            if (m_Layer == null && !NeedsEditorPreview)
                Debug.LogError("[VRShop] No OVRPassthroughLayer in the scene: rebuild it with VRShop > 3. Build Scene.");
            Apply(NeedsEditorPreview ? ViewMode.EditorPreview : ViewMode.MixedReality);
            if (RoomService.Instance != null) RoomService.Instance.OnReady += () => Apply(Mode);
        }

        void Apply(ViewMode mode)
        {
            Mode = mode;
            var mr = mode == ViewMode.MixedReality;
            if (OVRManager.instance != null) OVRManager.instance.isInsightPassthroughEnabled = mr;
            if (m_Layer != null)
            {
                m_Layer.hidden = !mr;
                m_Layer.enabled = mr;
            }
            if (m_Cam == null) m_Cam = Camera.main;
            if (m_Cam != null)
            {
                m_Cam.clearFlags = CameraClearFlags.SolidColor;
                // Alpha 0 lets the passthrough underlay show through everywhere we don't draw.
                m_Cam.backgroundColor = mr ? new Color(0, 0, 0, 0) : previewBackground;
            }
            RoomService.Instance?.SetVirtualRoomVisible(!mr);
            ModeChanged?.Invoke(mode);
        }
    }
}
