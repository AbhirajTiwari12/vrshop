using System.Collections.Generic;
using UnityEngine;
using VRShop.Input;
using VRShop.Interaction;
using VRShop.Rendering;

namespace VRShop.Room
{
    /// <summary>
    /// "Adjust" handles on a real piece's box, for when Space Setup's box is a little off: drag a side dot to move that
    /// side (the opposite side stays put), the top dot for height, the raised center dot to move the whole box. The
    /// thumbstick turns it (RealFurniture). Changes apply live; RealFurniture saves them when the user taps Done.
    /// </summary>
    public class BoxHandles : MonoBehaviour
    {
        RealPiece m_Piece;
        readonly List<Handle> m_Handles = new List<Handle>();

        public void Init(RealPiece piece)
        {
            m_Piece = piece;
            // Sides: +x, -x, +z, -z (in the box's frame), top, move.
            Add(Handle.Kind.Side, Vector3.right);
            Add(Handle.Kind.Side, Vector3.left);
            Add(Handle.Kind.Side, Vector3.forward);
            Add(Handle.Kind.Side, Vector3.back);
            Add(Handle.Kind.Top, Vector3.up);
            Add(Handle.Kind.Move, Vector3.up);
            Show(false);
        }

        void Add(Handle.Kind kind, Vector3 localAxis)
        {
            var go = GameObject.CreatePrimitive(kind == Handle.Kind.Move ? PrimitiveType.Cylinder : PrimitiveType.Sphere);
            Destroy(go.GetComponent<Collider>());
            go.name = $"Handle_{kind}_{localAxis}";
            go.transform.SetParent(transform, false);
            var col = go.AddComponent<SphereCollider>();
            col.isTrigger = true;
            col.radius = 0.9f; // generous: easier to hit with a laser than the visual dot
            var r = go.GetComponent<MeshRenderer>();
            r.sharedMaterial = VRShopMaterials.Instance(VRShopMaterials.UnlitColor, kind == Handle.Kind.Move ? new Color(0.17f, 0.15f, 0.13f) : new Color(0.96f, 0.84f, 0.62f));
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            var h = go.AddComponent<Handle>();
            h.Setup(m_Piece, kind, localAxis);
            m_Handles.Add(h);
        }

        public void Show(bool on)
        {
            gameObject.SetActive(on);
            if (on) Sync();
        }

        /// <summary>Put the dots on the faces of the current box.</summary>
        public void Sync()
        {
            if (m_Piece == null) return;
            var s = m_Piece.Size;
            var sideY = Mathf.Min(0.45f, s.y / 2) - s.y / 2; // near the bottom-middle of each side, where it's easy to see
            foreach (var h in m_Handles)
            {
                switch (h.kind)
                {
                    case Handle.Kind.Side:
                        h.transform.localPosition = new Vector3(h.localAxis.x * s.x / 2, sideY, h.localAxis.z * s.z / 2) + h.localAxis * 0.02f;
                        h.transform.localScale = Vector3.one * 0.07f;
                        break;
                    case Handle.Kind.Top:
                        h.transform.localPosition = new Vector3(0, s.y / 2 + 0.03f, 0);
                        h.transform.localScale = Vector3.one * 0.07f;
                        break;
                    case Handle.Kind.Move:
                        h.transform.localPosition = new Vector3(0, s.y / 2 + 0.16f, 0);
                        h.transform.localScale = new Vector3(0.09f, 0.012f, 0.09f);
                        break;
                }
            }
        }
    }

    /// <summary>One draggable dot. While pressed it follows the controller ray along its axis (or across the floor).</summary>
    public class Handle : MonoBehaviour, IPointerTarget
    {
        public enum Kind { Side, Top, Move }
        public Kind kind;
        public Vector3 localAxis;

        RealPiece m_Piece;
        bool m_Dragging;
        Hand m_Hand;
        // Captured at press: the fixed side / bottom / grab offset the drag is measured against.
        Vector3 m_Axis, m_Anchor, m_Start, m_GrabOffset;
        float m_Height;

        public void Setup(RealPiece piece, Kind k, Vector3 axis) { m_Piece = piece; kind = k; localAxis = axis; }

        public void OnHoverEnter(PointerEvent e) => transform.localScale *= 1.25f;
        public void OnHoverExit(PointerEvent e) => GetComponentInParent<BoxHandles>()?.Sync();

        public void OnPress(PointerEvent e)
        {
            m_Dragging = true;
            m_Hand = e.hand;
            var rot = Quaternion.Euler(0, m_Piece.Yaw, 0);
            m_Axis = kind == Kind.Side ? rot * localAxis : Vector3.up;
            var extent = kind == Kind.Side ? Mathf.Abs(Vector3.Dot(localAxis, m_Piece.Size)) : m_Piece.Size.y;
            m_Start = transform.position;
            m_Anchor = kind == Kind.Side ? m_Piece.Center - m_Axis * (extent / 2) : new Vector3(m_Piece.Center.x, m_Piece.Bottom, m_Piece.Center.z);
            m_Height = transform.position.y;
            if (kind == Kind.Move) m_GrabOffset = m_Piece.Center - transform.position;
            XRInput.Instance?.Haptic(e.hand, 0.3f, 0.03f);
        }

        public void OnRelease(PointerEvent e, bool clicked) => m_Dragging = false;

        void Update()
        {
            if (!m_Dragging || m_Piece == null || XRInput.Instance == null) return;
            var ray = XRInput.Instance.GetRay(m_Hand);
            var size = m_Piece.Size;
            var center = m_Piece.Center;
            switch (kind)
            {
                case Kind.Side:
                {
                    if (!ClosestOnLine(m_Start, m_Axis, ray, out var s)) return;
                    var face = m_Start + m_Axis * (s - 0.02f); // the dot sits 2 cm off the face
                    var extent = Mathf.Clamp(Vector3.Dot(face - m_Anchor, m_Axis), 0.1f, 6f);
                    var c = m_Anchor + m_Axis * (extent / 2);
                    center = new Vector3(c.x, center.y, c.z);
                    if (Mathf.Abs(localAxis.x) > 0.5f) size.x = extent; else size.z = extent;
                    break;
                }
                case Kind.Top:
                {
                    if (!ClosestOnLine(m_Start, Vector3.up, ray, out var s)) return;
                    var h = Mathf.Clamp(m_Start.y + s - 0.03f - m_Anchor.y, 0.05f, 3f);
                    size.y = h;
                    center.y = m_Anchor.y + h / 2;
                    break;
                }
                case Kind.Move:
                {
                    if (ray.direction.y > -0.02f) return;
                    var t = (m_Height - ray.origin.y) / ray.direction.y;
                    if (t < 0 || t > 12) return;
                    var hit = ray.GetPoint(t) + m_GrabOffset;
                    center = new Vector3(hit.x, center.y, hit.z);
                    break;
                }
            }
            m_Piece.SetBox(center, size, m_Piece.Yaw, true);
        }

        /// <summary>Parameter s of the point on line (origin + dir*s) closest to the ray.</summary>
        static bool ClosestOnLine(Vector3 origin, Vector3 dir, Ray ray, out float s)
        {
            var w0 = origin - ray.origin;
            var b = Vector3.Dot(dir, ray.direction);
            var denom = 1f - b * b;
            s = 0;
            if (denom < 1e-4f) return false; // the ray runs along the axis
            var d = Vector3.Dot(dir, w0);
            var e = Vector3.Dot(ray.direction, w0);
            s = (b * e - d) / denom;
            return true;
        }
    }
}
