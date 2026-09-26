using System;
using UnityEngine;
using Object = UnityEngine.Object;
using VRShop.Input;
using VRShop.Rendering;

namespace VRShop.Interaction
{
    /// <summary>
    /// Controller laser: raycasts every frame, draws the beam + reticle, and routes hover/press/release
    /// to the nearest IPointerTarget. Room surfaces (floor/walls) are hit-tested too so other systems can
    /// ask "where on the floor is the user pointing?".
    /// </summary>
    public class LaserPointer : MonoBehaviour
    {
        public Hand hand = Hand.Right;
        public float maxDistance = 12f;
        public Color idleColor = new Color(1f, 1f, 1f, 0.35f);
        public Color activeColor = new Color(0.45f, 0.75f, 1f, 0.9f);

        public bool HasHit { get; private set; }
        public RaycastHit Hit { get; private set; }
        public Ray CurrentRay { get; private set; }
        public IPointerTarget Hovered { get; private set; }
        public IPointerTarget Pressed { get; private set; }

        /// <summary>Last point on the floor the user pointed at (used for "put a lamp here").</summary>
        public Vector3? LastFloorPoint { get; private set; }
        public float LastFloorPointTime { get; private set; }

        public static event Action<LaserPointer, RaycastHit> FloorClicked;

        LineRenderer m_Line;
        Transform m_Reticle;
        Material m_LineMat;
        readonly RaycastHit[] m_Hits = new RaycastHit[24];
        float m_PressTime;
        Vector3 m_PressPoint;

        void Start()
        {
            m_LineMat = VRShopMaterials.Instance(VRShopMaterials.UnlitTransparent, idleColor);
            m_Line = gameObject.AddComponent<LineRenderer>();
            m_Line.positionCount = 2;
            m_Line.useWorldSpace = true;
            m_Line.widthCurve = new AnimationCurve(new Keyframe(0, 0.004f), new Keyframe(1, 0.0015f));
            m_Line.material = m_LineMat;
            m_Line.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            m_Line.receiveShadows = false;
            m_Line.numCapVertices = 2;

            var ret = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            Destroy(ret.GetComponent<Collider>());
            ret.name = $"Reticle{hand}";
            ret.transform.localScale = Vector3.one * 0.015f;
            var rr = ret.GetComponent<MeshRenderer>();
            rr.sharedMaterial = VRShopMaterials.Instance(VRShopMaterials.UnlitTransparent, new Color(1, 1, 1, 0.9f));
            rr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            m_Reticle = ret.transform;
        }

        void Update()
        {
            // Interface refs don't see Unity's destroy; drop targets whose object was deleted.
            if (Hovered is Object ho && ho == null) Hovered = null;
            if (Pressed is Object po && po == null) Pressed = null;
            var input = XRInput.Instance;
            if (input == null || !input.IsTracked(hand))
            {
                SetVisible(false);
                return;
            }
            SetVisible(true);

            var ray = input.GetRay(hand);
            CurrentRay = ray;
            var count = Physics.RaycastNonAlloc(ray, m_Hits, maxDistance, ~0, QueryTriggerInteraction.Collide);
            Array.Sort(m_Hits, 0, count, HitComparer.Instance);

            IPointerTarget target = null;
            RaycastHit best = default;
            var found = false;
            for (var i = 0; i < count; i++)
            {
                var h = m_Hits[i];
                // Ignore the object being dragged so we can see the floor through it.
                var t = FindTarget(h.collider);
                if (Pressed != null && t == Pressed && ManipulationController.Instance != null && ManipulationController.Instance.IsDragging) continue;
                best = h;
                target = t;
                found = true;
                break;
            }

            HasHit = found;
            Hit = best;
            if (found && IsFloor(best.collider))
            {
                LastFloorPoint = best.point;
                LastFloorPointTime = Time.time;
            }

            var ev = new PointerEvent { hand = hand, ray = ray, hit = best };
            if (!ReferenceEquals(target, Hovered))
            {
                Hovered?.OnHoverExit(ev);
                Hovered = target;
                Hovered?.OnHoverEnter(ev);
                if (Hovered != null) input.Haptic(hand, 0.12f, 0.02f);
            }

            if (input.TriggerDown(hand) || input.GripDown(hand))
            {
                Pressed = target;
                m_PressTime = Time.time;
                m_PressPoint = found ? best.point : ray.GetPoint(1);
                Pressed?.OnPress(ev);
                if (Pressed == null && found && IsFloor(best.collider)) FloorClicked?.Invoke(this, best);
            }
            if (input.TriggerUp(hand) || input.GripUp(hand))
            {
                var p = Pressed;
                Pressed = null;
                if (p != null)
                {
                    var clicked = ReferenceEquals(p, target) || Time.time - m_PressTime < 0.35f;
                    p.OnRelease(ev, clicked);
                }
            }

            var end = found ? best.point : ray.GetPoint(Mathf.Min(maxDistance, 3f));
            m_Line.SetPosition(0, ray.origin);
            m_Line.SetPosition(1, end);
            var active = target != null;
            VRShopMaterials.SetColor(m_LineMat, active || Pressed != null ? activeColor : idleColor);
            m_Reticle.gameObject.SetActive(found);
            if (found)
            {
                m_Reticle.position = best.point + best.normal * 0.003f;
                m_Reticle.localScale = Vector3.one * Mathf.Lerp(0.01f, 0.03f, best.distance / 6f);
            }
        }

        /// <summary>Interface lookup that respects Unity's fake-null objects in the Editor.</summary>
        public static IPointerTarget FindTarget(Collider c)
        {
            var t = c.GetComponentInParent<IPointerTarget>();
            return t as Object != null ? t : null;
        }

        public static bool IsFloor(Collider c) => c.TryGetComponent<RoomSurface>(out var s) && s.kind == SurfaceKind.Floor;

        void SetVisible(bool v)
        {
            if (m_Line != null) m_Line.enabled = v;
            if (m_Reticle != null && !v) m_Reticle.gameObject.SetActive(false);
        }

        class HitComparer : System.Collections.Generic.IComparer<RaycastHit>
        {
            public static readonly HitComparer Instance = new HitComparer();
            public int Compare(RaycastHit a, RaycastHit b) => a.distance.CompareTo(b.distance);
        }
    }
}
