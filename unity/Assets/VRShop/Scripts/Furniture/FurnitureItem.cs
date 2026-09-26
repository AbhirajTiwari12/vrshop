using System.Collections;
using UnityEngine;
using VRShop.Api;
using VRShop.Interaction;
using VRShop.Rendering;
using VRShop.UI;

namespace VRShop.Furniture
{
    public enum FitState { Ok, Overlap, OutsideRoom, BlocksDoor }

    /// <summary>
    /// One placed product. Shows a true-size ghost box immediately (so the user sees the footprint while the
    /// 3D model downloads or generates), then swaps in the real model. Owns its collider, contact shadow,
    /// footprint outline (green = fits, red = collides) and floating info tag.
    /// </summary>
    public class FurnitureItem : MonoBehaviour, IPointerTarget
    {
        public Product Product { get; private set; }
        public Dims Dims { get; private set; }
        public bool IsWallMounted { get; private set; }
        /// <summary>Flat floor coverings (rugs) layer under everything, real and virtual.</summary>
        public bool IsFloorLayer => Product != null && Product.category == "rug";
        public bool ModelLoaded { get; private set; }
        public FitState Fit { get; private set; } = FitState.Ok;
        public string FitMessage { get; private set; } = "";
        public bool Selected { get; private set; }

        Transform m_Visual;
        GameObject m_Ghost;
        GameObject m_Model;
        GameObject m_Blob;
        float m_ContactHeight;
        LineRenderer m_Footprint;
        Material m_FootprintMat;
        BoxCollider m_Collider;
        ItemTag m_Tag;
        bool m_Hover;
        string m_Status = "";
        string m_Note;

        static readonly Color k_Ok = new Color(0.35f, 0.9f, 0.55f, 0.9f);
        static readonly Color k_Bad = new Color(1f, 0.35f, 0.3f, 0.95f);
        static readonly Color k_Idle = new Color(1f, 1f, 1f, 0.55f);

        public void Init(Product p)
        {
            Product = p;
            name = $"Furniture_{p.id}";
            IsWallMounted = p.category == "wall_art" || p.category == "mirror";
            Dims = p.dims ?? new Dims { w = 0.6f, d = 0.6f, h = 0.6f };
            m_Visual = new GameObject("Visual").transform;
            m_Visual.SetParent(transform, false);

            m_Collider = gameObject.AddComponent<BoxCollider>();
            BuildGhost();
            BuildBlob();
            BuildFootprint();
            ApplyDims(Dims);

            m_Tag = ItemTag.Create(this);
            RefreshTag();
        }

        // ------------------------------------------------------------------ visuals
        void BuildGhost()
        {
            m_Ghost = GameObject.CreatePrimitive(PrimitiveType.Cube);
            Destroy(m_Ghost.GetComponent<Collider>());
            m_Ghost.name = "Ghost";
            m_Ghost.transform.SetParent(m_Visual, false);
            var r = m_Ghost.GetComponent<MeshRenderer>();
            r.sharedMaterial = VRShopMaterials.Instance(VRShopMaterials.UnlitTransparent, new Color(0.55f, 0.75f, 1f, 0.22f));
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        }

        void BuildBlob()
        {
            m_Blob = GameObject.CreatePrimitive(PrimitiveType.Quad);
            Destroy(m_Blob.GetComponent<Collider>());
            m_Blob.name = "ContactShadow";
            m_Blob.transform.SetParent(transform, false);
            m_Blob.transform.localRotation = Quaternion.Euler(90, 0, 0);
            var r = m_Blob.GetComponent<MeshRenderer>();
            var m = new Material(VRShopMaterials.BlobShadow);
            if (m.HasProperty("_MainTex")) m.SetTexture("_MainTex", ProceduralTextures.Blob);
            r.sharedMaterial = m;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = false;
            m_Blob.SetActive(!IsWallMounted && !IsFloorLayer); // a rug's own halo looks wrong
        }

        void BuildFootprint()
        {
            var go = new GameObject("Footprint");
            go.transform.SetParent(transform, false);
            m_Footprint = go.AddComponent<LineRenderer>();
            m_Footprint.useWorldSpace = false;
            m_Footprint.loop = true;
            m_Footprint.positionCount = 4;
            m_Footprint.widthMultiplier = 0.008f;
            m_FootprintMat = VRShopMaterials.Instance(VRShopMaterials.UnlitTransparent, k_Idle);
            m_Footprint.material = m_FootprintMat;
            m_Footprint.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            m_Footprint.alignment = LineAlignment.TransformZ;
            go.transform.localRotation = Quaternion.Euler(90, 0, 0); // lay the line flat on the floor
            m_Footprint.enabled = false;
        }

        void ApplyDims(Dims d)
        {
            Dims = d;
            var size = d.ToSize();
            m_Ghost.transform.localScale = size;
            m_Ghost.transform.localPosition = new Vector3(0, size.y / 2, 0);
            m_Collider.size = new Vector3(Mathf.Max(size.x, 0.05f), Mathf.Max(size.y, 0.03f), Mathf.Max(size.z, 0.05f));
            m_Collider.center = new Vector3(0, m_Collider.size.y / 2, 0);
            m_Blob.transform.localScale = new Vector3(size.x * 1.25f + 0.1f, size.z * 1.25f + 0.1f, 1);
            m_Blob.transform.localPosition = new Vector3(0, m_ContactHeight + 0.004f, 0);
            float hw = size.x / 2 + 0.02f, hd = size.z / 2 + 0.02f;
            // Footprint drawn in the rotated (XY) plane of its GameObject: local (x, y) -> world (x, z)
            m_Footprint.SetPositions(new[] { new Vector3(-hw, -hd, -0.006f), new Vector3(hw, -hd, -0.006f), new Vector3(hw, hd, -0.006f), new Vector3(-hw, hd, -0.006f) });
        }

        public void SetStatus(string status)
        {
            m_Status = status;
            RefreshTag();
        }

        /// <summary>Informational line (e.g. doorway delivery check) shown when there is no status/warning.</summary>
        public void SetStatusNote(string note)
        {
            if (note == m_Note) return;
            m_Note = note;
            RefreshTag();
        }

        /// <summary>Lifts the contact shadow onto a virtual rug this item stands on (0 = the floor).</summary>
        public void SetContactHeight(float height)
        {
            if (Mathf.Approximately(height, m_ContactHeight)) return;
            m_ContactHeight = height;
            m_Blob.transform.localPosition = new Vector3(0, height + 0.004f, 0);
        }

        public IEnumerator SwapInModel(GameObject model)
        {
            if (model == null) yield break;
            m_Model = model;
            m_Model.transform.SetParent(m_Visual, false);
            // Trust the real model's measured size over listing numbers (model space == item space).
            var b = ModelLoader.LocalBounds(m_Model.transform);
            if (b.size.x > 0.02f && b.size.y > 0.005f)
                ApplyDims(new Dims { w = b.size.x, d = b.size.z, h = b.size.y });
            m_Ghost.SetActive(false);
            ModelLoaded = true;
            m_Status = "";
            RefreshTag();
            // little "settle" animation
            var t = 0f;
            while (t < 1f && m_Model != null)
            {
                t += Time.deltaTime / 0.35f;
                var s = Mathf.SmoothStep(0.92f, 1f, t);
                m_Model.transform.localScale = new Vector3(s, s, s);
                yield return null;
            }
            if (m_Model != null) m_Model.transform.localScale = Vector3.one;
        }

        public void SetSelected(bool on)
        {
            Selected = on;
            UpdateOutline();
            m_Tag.SetVisible(on || m_Hover || !ModelLoaded);
        }

        public void SetFit(FitState state, string message)
        {
            if (state == Fit && message == FitMessage) return;
            Fit = state;
            FitMessage = message;
            UpdateOutline();
            RefreshTag();
        }

        void UpdateOutline()
        {
            m_Footprint.enabled = Selected || m_Hover || Fit != FitState.Ok;
            VRShopMaterials.SetColor(m_FootprintMat, Fit != FitState.Ok ? k_Bad : Selected ? k_Ok : k_Idle);
            m_Footprint.widthMultiplier = Selected ? 0.012f : 0.007f;
        }

        public void RefreshTag()
        {
            if (m_Tag == null) return;
            m_Tag.Refresh(Product, Dims, string.IsNullOrEmpty(m_Status) ? m_Note : m_Status, Fit != FitState.Ok ? FitMessage : null);
        }

        // ------------------------------------------------------------------ pointer
        public void OnHoverEnter(PointerEvent e) { m_Hover = true; UpdateOutline(); m_Tag.SetVisible(true); }
        public void OnHoverExit(PointerEvent e) { m_Hover = false; UpdateOutline(); m_Tag.SetVisible(Selected || !ModelLoaded); }
        public void OnPress(PointerEvent e) => ManipulationController.Instance?.BeginDrag(this, e);
        public void OnRelease(PointerEvent e, bool clicked) => ManipulationController.Instance?.EndDrag(this, e, clicked);

        void OnDestroy()
        {
            if (m_Tag != null) Destroy(m_Tag.gameObject);
        }
    }
}
