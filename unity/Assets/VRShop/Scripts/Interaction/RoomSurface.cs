using UnityEngine;

namespace VRShop.Interaction
{
    public enum SurfaceKind { Floor, Wall, Object }

    /// <summary>Marks colliders built from the room model (Space Setup) so the laser knows what it hit.</summary>
    public class RoomSurface : MonoBehaviour
    {
        public SurfaceKind kind;
        public string label;
    }
}
