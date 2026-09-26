using System;
using UnityEngine;
using UnityEngine.XR;
using VRShop.Room;

namespace VRShop.Rendering
{
    public enum ViewMode { MixedReality, VirtualRoom }

    /// <summary>
    /// Switches between Mixed Reality (see your real room through passthrough, furniture composited in)
    /// and Virtual Room (full-color digital version of your room built from Space Setup + the AI palette —
    /// useful on Quest 2 whose passthrough is grayscale, and for remote shopping).
    /// </summary>
    public class PassthroughController : MonoBehaviour
    {
        public static PassthroughController Instance { get; private set; }
        public ViewMode Mode { get; private set; } = ViewMode.MixedReality;
        public event Action<ViewMode> ModeChanged;

        public Color virtualBackground = new Color(0.82f, 0.84f, 0.87f);

        OVRPassthroughLayer m_Layer;
        Camera m_Cam;

        void Awake() => Instance = this;

        void Start()
        {
            m_Layer = FindFirstObjectByType<OVRPassthroughLayer>();
            m_Cam = Camera.main;
            // Passthrough can't render in the Editor without a headset: start in the virtual room there.
            Apply(XRSettings.isDeviceActive && m_Layer != null ? ViewMode.MixedReality : ViewMode.VirtualRoom);
            if (RoomService.Instance != null) RoomService.Instance.OnReady += () => Apply(Mode);
        }

        public void Toggle() => Apply(Mode == ViewMode.MixedReality ? ViewMode.VirtualRoom : ViewMode.MixedReality);

        public void Apply(ViewMode mode)
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
                m_Cam.backgroundColor = mr ? new Color(0, 0, 0, 0) : virtualBackground;
            }
            RoomService.Instance?.SetVirtualRoomVisible(!mr);
            ModeChanged?.Invoke(mode);
        }
    }
}
