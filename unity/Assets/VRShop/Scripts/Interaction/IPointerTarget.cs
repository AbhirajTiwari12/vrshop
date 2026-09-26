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

    public enum SurfaceKind { Floor, Wall, Object }

    /// <summary>Marks colliders built from the room model (Space Setup) so the laser knows what it hit.</summary>
    public class RoomSurface : MonoBehaviour
    {
        public SurfaceKind kind;
        public string label;
    }
}
