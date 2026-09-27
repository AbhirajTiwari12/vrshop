using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using VRShop.Furniture;
using VRShop.Interaction;
using VRShop.Rendering;
using VRShop.UI;

namespace VRShop.Room
{
    /// <summary>
    /// One piece of the user's real furniture: a Space Setup box. Kept (the default), it's solid: it hides virtual
    /// furniture behind it and new pieces are pushed out of it. Replaced, it's painted out of passthrough (RoomCover
    /// shader: the floor and wall behind it) and a product stands in its spot. Owns its laser collider, depth occluder,
    /// Editor-preview block, outline, cover, adjust handles and floating tag. Decisions go through RealFurniture.
    /// </summary>
    public class RealPiece : MonoBehaviour, IPointerTarget
    {
        /// <summary>The cover reaches this far past the box (hand-drawn boxes are rarely exact); the edge fades over it.</summary>
        public const float CoverMargin = 0.08f;

        public string Id { get; private set; }
        public string Label { get; private set; }         // COUCH, TABLE, ...
        public ObjectInfo Scanned { get; private set; }   // as Space Setup has it (Reset goes back to this)
        public Vector3 Center { get; private set; }
        public Vector3 Size { get; private set; }         // x = width (right axis), y = height, z = depth (forward axis)
        public float Yaw { get; private set; }
        public bool Adjusted { get; private set; }

        public bool IsReplaced { get; private set; }
        public string Category { get; set; }
        public List<string> Choices { get; set; } = new List<string>();
        public FurnitureItem Replacement { get; set; }
        public List<string> CandidateIds { get; } = new List<string>();
        public int CandidateIndex { get; set; }
        public bool Searching { get; set; }
        public string Message { get; set; }
        /// <summary>Our own change is on its way to the server: ignore (older) server state for this piece until then.</summary>
        public float PendingUntil { get; set; }
        public bool Adjusting { get; private set; }
        public bool Pinned { get; private set; }
        public bool Hovered { get; private set; }

        public string Name => RealFurniture.NameOf(Label);
        public bool IsTableLike => Label.Contains("TABLE") || Label.Contains("DESK");
        public Obb Footprint => new Obb(Center, Size.x / 2, Size.z / 2, Yaw);
        public float Bottom => Center.y - Size.y / 2;
        public float Top => Center.y + Size.y / 2;

        BoxCollider m_Collider;
        GameObject m_Occluder, m_Skirt, m_Preview, m_Outline, m_Cover;
        Material m_OutlineMat, m_CoverMat;
        Mesh m_OutlineMesh;
        BoxHandles m_Handles;
        RealPieceTag m_Tag;
        float m_Hide; // 0 = the real piece shows, 1 = painted out

        static readonly Color k_OutlineKeep = new Color(1f, 1f, 1f, 0.75f);
        static readonly Color k_OutlineReplace = new Color(0.96f, 0.84f, 0.62f, 0.9f); // brass, like the laser
        static readonly int k_Opacity = Shader.PropertyToID("_Opacity");

        public void Init(ObjectInfo scanned, RealFurniture.BoxOverride ov)
        {
            Scanned = scanned;
            Id = scanned.id;
            Label = (scanned.label ?? "OTHER").Split(',')[0].Trim().ToUpperInvariant();
            name = $"Real_{Label}_{Id}";

            m_Collider = gameObject.AddComponent<BoxCollider>();
            var rs = gameObject.AddComponent<RoomSurface>();
            rs.kind = SurfaceKind.Object;
            rs.label = Label;

            m_Occluder = Primitive("Occluder", VRShopMaterials.DepthOccluder);
            m_Skirt = Primitive("FloorSkirt", VRShopMaterials.DepthOccluder);
            m_Preview = Primitive("PreviewBlock", VRShopMaterials.Instance(VRShopMaterials.Lit, new Color(0.7f, 0.7f, 0.72f)));
            m_Preview.GetComponent<MeshRenderer>().shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;

            m_Outline = new GameObject("Outline", typeof(MeshFilter), typeof(MeshRenderer));
            m_Outline.transform.SetParent(transform, false);
            m_OutlineMat = VRShopMaterials.Instance(VRShopMaterials.UnlitTransparent, k_OutlineKeep);
            var or = m_Outline.GetComponent<MeshRenderer>();
            or.sharedMaterial = m_OutlineMat;
            or.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            or.receiveShadows = false;
            m_OutlineMesh = new Mesh { name = "PieceOutline" };
            m_Outline.GetComponent<MeshFilter>().sharedMesh = m_OutlineMesh;

            m_CoverMat = new Material(VRShopMaterials.RoomCover);
            m_Cover = Primitive("Cover", m_CoverMat);
            m_Cover.GetComponent<MeshRenderer>().receiveShadows = false;

            m_Handles = new GameObject("Handles").AddComponent<BoxHandles>();
            m_Handles.transform.SetParent(transform, false);
            m_Handles.Init(this);

            if (ov != null) SetBox(ov.Center, ov.Size, ov.yaw, true);
            else SetBox(scanned.center, scanned.size, scanned.yawDeg, false);

            m_Tag = RealPieceTag.Create(this);
            if (PassthroughController.Instance != null) PassthroughController.Instance.ModeChanged += OnModeChanged;
            ApplyVisibility();
        }

        GameObject Primitive(string n, Material m)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            Destroy(go.GetComponent<Collider>());
            go.name = n;
            go.transform.SetParent(transform, false);
            var r = go.GetComponent<MeshRenderer>();
            r.sharedMaterial = m;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = false;
            return go;
        }

        // ------------------------------------------------------------------ geometry

        /// <summary>Set the box (world center, size in the box's yaw frame) and rebuild everything that depends on it.</summary>
        public void SetBox(Vector3 center, Vector3 size, float yawDeg, bool adjusted)
        {
            Center = center;
            Size = new Vector3(Mathf.Max(0.05f, size.x), Mathf.Max(0.03f, size.y), Mathf.Max(0.05f, size.z));
            Yaw = yawDeg;
            Adjusted = adjusted;
            transform.SetPositionAndRotation(Center, Quaternion.Euler(0, Yaw, 0));

            var floorY = RoomService.Instance != null ? RoomService.Instance.FloorY : Bottom;
            // Tables and desks are open underneath: occlude only the top slab so a virtual rug (or a chair tucked under)
            // still shows between the legs. Couches, beds and storage are solid to the floor.
            var slab = IsTableLike ? Mathf.Min(0.05f, Size.y) : Size.y;
            m_Occluder.transform.localPosition = new Vector3(0, Size.y / 2 - slab / 2, 0);
            m_Occluder.transform.localScale = new Vector3(Size.x * 0.98f, slab * 0.98f, Size.z * 0.98f);
            // Solid pieces standing on the floor also get a low "skirt" a few cm wider than the box: it hides only
            // floor-level virtual items (rugs), so a rug stays under the couch even when the box is slightly off.
            var onFloor = Bottom < floorY + 0.1f && !IsTableLike;
            m_Skirt.transform.localPosition = new Vector3(0, floorY + 0.015f - Center.y, 0);
            m_Skirt.transform.localScale = new Vector3(Size.x + 0.08f, 0.03f, Size.z + 0.08f);
            m_Skirt.SetActive(onFloor);

            m_Preview.transform.localPosition = Vector3.zero;
            m_Preview.transform.localScale = Size;
            WireBox.Build(Size + Vector3.one * 0.012f, 0.009f, m_OutlineMesh);

            UpdateCollider();
            UpdateCover();
            m_Handles.Sync();
            ApplyVisibility();
        }

        void UpdateCollider()
        {
            if (m_Collider == null) return;
            m_Collider.enabled = !Adjusting;
            if (IsReplaced)
            {
                // Painted out: only a thin floor slab stays pointable, so the laser reaches the replacement standing on it.
                var floorY = RoomService.Instance != null ? RoomService.Instance.FloorY : Bottom;
                m_Collider.size = new Vector3(Size.x, 0.03f, Size.z);
                m_Collider.center = new Vector3(0, Mathf.Max(floorY, Bottom) + 0.015f - Center.y, 0);
            }
            else
            {
                m_Collider.size = Size;
                m_Collider.center = Vector3.zero;
            }
        }

        /// <summary>Feed the cover shader this box and the room around it.</summary>
        public void UpdateCover()
        {
            var room = RoomService.Instance;
            if (room == null || m_CoverMat == null) return;
            var floorY = room.FloorY;
            var yMin = Mathf.Min(Bottom, Bottom < floorY + 0.12f ? floorY : Bottom) - 0.03f;
            var yMax = Top + CoverMargin * 0.6f;
            var half = new Vector3(Size.x / 2 + CoverMargin, (yMax - yMin) / 2, Size.z / 2 + CoverMargin);
            var worldCenter = new Vector3(Center.x, (yMin + yMax) / 2, Center.z);
            m_Cover.transform.localPosition = new Vector3(0, worldCenter.y - Center.y, 0);
            m_Cover.transform.localScale = half * 2;

            m_CoverMat.SetVector("_BoxCenter", worldCenter);
            m_CoverMat.SetVector("_BoxAxisX", transform.right);
            m_CoverMat.SetVector("_BoxAxisZ", transform.forward);
            m_CoverMat.SetVector("_BoxHalf", half);
            // The walls nearest the piece (the shader can take 8): what you see behind it.
            var walls = room.Walls.OrderBy(w => Mathf.Abs(Vector3.Dot(new Vector3(Center.x - w.center.x, 0, Center.z - w.center.z), w.normal))).Take(8).ToList();
            var a = new Vector4[8];
            var b = new Vector4[8];
            for (var i = 0; i < walls.Count; i++)
            {
                a[i] = new Vector4(walls[i].center.x, walls[i].center.z, walls[i].normal.x, walls[i].normal.z);
                b[i] = new Vector4(walls[i].width / 2, 0, 0, 0);
            }
            m_CoverMat.SetVectorArray("_WallA", a);
            m_CoverMat.SetVectorArray("_WallB", b);
            m_CoverMat.SetVector("_Room", new Vector4(floorY, floorY + room.CeilingHeight, walls.Count, 0));
            m_CoverMat.SetFloat("_Feather", CoverMargin * 0.7f);
            UpdateCoverColors();
        }

        public void UpdateCoverColors()
        {
            var rf = RealFurniture.Instance;
            if (m_CoverMat == null || rf == null) return;
            m_CoverMat.SetColor("_FloorColor", rf.ToneColor(true));
            m_CoverMat.SetColor("_WallColor", rf.ToneColor(false));
        }

        // ------------------------------------------------------------------ state

        public void SetReplaced(bool replaced)
        {
            if (IsReplaced == replaced) return;
            IsReplaced = replaced;
            UpdateCollider();
            ApplyVisibility();
            RefreshTag();
        }

        public void SetPinned(bool on)
        {
            Pinned = on;
            ApplyVisibility();
            RefreshTag();
        }

        public void BeginAdjust()
        {
            Adjusting = true;
            m_Handles.Show(true);
            UpdateCollider();
            ApplyVisibility();
            RefreshTag();
        }

        public void EndAdjust()
        {
            if (!Adjusting) return;
            Adjusting = false;
            m_Handles.Show(false);
            UpdateCollider();
            ApplyVisibility();
            RefreshTag();
        }

        public void RefreshTag() { if (m_Tag != null) m_Tag.Refresh(); }

        void OnModeChanged(ViewMode _) => ApplyVisibility();

        void ApplyVisibility()
        {
            var mr = PassthroughController.Instance == null || PassthroughController.Instance.Mode == ViewMode.MixedReality;
            // Kept: occluders hide virtual furniture behind the real piece. Replaced: nothing of it should hide anything.
            m_Occluder.SetActive(mr && !IsReplaced);
            m_Skirt.SetActive(mr && !IsReplaced && Bottom < (RoomService.Instance != null ? RoomService.Instance.FloorY : Bottom) + 0.1f && !IsTableLike);
            m_Preview.SetActive(!mr && m_Hide < 0.5f);
            m_Cover.SetActive(mr && m_Hide > 0.001f);
            var outline = Hovered || Pinned || Adjusting;
            m_Outline.SetActive(outline);
            if (outline) VRShopMaterials.SetColor(m_OutlineMat, IsReplaced || Adjusting ? k_OutlineReplace : k_OutlineKeep);
        }

        void Update()
        {
            // Paint out / bring back over ~0.8 s: people read the fade as "it's gone".
            var target = IsReplaced ? 1f : 0f;
            if (Mathf.Approximately(m_Hide, target)) return;
            m_Hide = Mathf.MoveTowards(m_Hide, target, Time.deltaTime / 0.8f);
            m_CoverMat.SetFloat(k_Opacity, Mathf.SmoothStep(0, 1, m_Hide));
            ApplyVisibility();
        }

        // ------------------------------------------------------------------ pointer
        // Counted per hand: the other laser sweeping past mustn't hide the card the first one is showing.
        int m_HoverCount;
        public void OnHoverEnter(PointerEvent e) { m_HoverCount++; Hovered = true; ApplyVisibility(); }
        public void OnHoverExit(PointerEvent e) { m_HoverCount = Mathf.Max(0, m_HoverCount - 1); Hovered = m_HoverCount > 0; ApplyVisibility(); }
        public void OnPress(PointerEvent e) { }
        public void OnRelease(PointerEvent e, bool clicked)
        {
            if (clicked) RealFurniture.Instance?.Select(this);
        }

        void OnDestroy()
        {
            if (PassthroughController.Instance != null) PassthroughController.Instance.ModeChanged -= OnModeChanged;
            if (m_Tag != null) Destroy(m_Tag.gameObject);
            if (m_OutlineMesh != null) Destroy(m_OutlineMesh);
            if (m_CoverMat != null) Destroy(m_CoverMat);
        }
    }
}
