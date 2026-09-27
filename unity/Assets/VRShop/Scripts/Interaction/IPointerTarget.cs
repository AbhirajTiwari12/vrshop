using UnityEngine;
using VRShop.Input;

namespace VRShop.Interaction
{
    public struct PointerEvent
    {
        public Hand hand;
        public Ray ray;
        public RaycastHit hit;
    }

    /// <summary>Anything the controller laser can hover and click: UI buttons, furniture, room surfaces.</summary>
    public interface IPointerTarget
    {
        void OnHoverEnter(PointerEvent e);
        void OnHoverExit(PointerEvent e);
        void OnPress(PointerEvent e);
        void OnRelease(PointerEvent e, bool clicked);
    }

    /// <summary>
    /// A pointer target on a floating panel (buttons, the designer). UI draws over the room, so the laser picks it
    /// over whatever room surface or furniture is in front of or behind it along the ray.
    /// </summary>
    public interface IOverlayTarget { }
}
