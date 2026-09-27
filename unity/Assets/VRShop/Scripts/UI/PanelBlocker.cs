using UnityEngine;
using VRShop.Interaction;

namespace VRShop.UI
{
    /// <summary>Catches laser hits on empty panel space so they don't fall through to furniture or the floor.</summary>
    public class PanelBlocker : MonoBehaviour, IPointerTarget, IOverlayTarget
    {
        public static void Add(GameObject go, float widthPx, float heightPx)
        {
            var col = go.AddComponent<BoxCollider>();
            col.isTrigger = true;
            // Top-left pivot; sits slightly behind the buttons (+Z is away from the viewer).
            col.center = new Vector3(widthPx / 2, -heightPx / 2, 4f);
            col.size = new Vector3(widthPx, heightPx, 2f);
            go.AddComponent<PanelBlocker>();
        }

        public void OnHoverEnter(PointerEvent e) { }
        public void OnHoverExit(PointerEvent e) { }
        public void OnPress(PointerEvent e) { }
        public void OnRelease(PointerEvent e, bool clicked) { }
    }
}
