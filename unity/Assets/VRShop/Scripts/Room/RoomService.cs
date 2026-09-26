using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Meta.XR.MRUtilityKit;
using UnityEngine;
using VRShop.Api;
using VRShop.Interaction;
using VRShop.Rendering;

namespace VRShop.Room
{
    public class WallInfo
    {
        public Vector3 center;   // world, mid-height
        public Vector3 normal;   // horizontal, points into the room
        public float width, height;
    }

    public class ObjectInfo
    {
        public string label;     // COUCH, TABLE, BED, STORAGE, SCREEN, LAMP, PLANT, OTHER, DOOR_FRAME, WINDOW_FRAME
        public Vector3 center;   // world
        public Vector3 size;     // x = width, y = height, z = depth (in the object's yaw frame)
        public float yawDeg;
        public bool isOpening => label.Contains("DOOR") || label.Contains("WINDOW");
    }

    /// <summary>
    /// Understands the physical room. On the Quest it reads the user's Space Setup through MR Utility Kit
    /// (walls, floor outline, furniture boxes, doors, windows — on Quest 2 these are drawn by the user in
    /// Settings > Physical Space > Space Setup). Without scene data (Editor, or no Space Setup) it builds a
    /// 4 x 4.5 m default room in front of the user.
    ///
    /// From that it builds:
    ///  - colliders for the laser (floor, walls, real furniture)
    ///  - depth-only occluders so virtual furniture hides behind real walls/furniture (MR mode)
    ///  - a shadow-catcher floor so virtual furniture casts shadows on the real floor (MR mode)
    ///  - a full-color "virtual room" (walls painted with the room's palette, wood floor) for VR mode
    /// </summary>
    public class RoomService : MonoBehaviour
    {
        public static RoomService Instance { get; private set; }

        public bool Ready { get; private set; }
        public bool FromDevice { get; private set; }
        public float FloorY { get; private set; }
        public float CeilingHeight { get; private set; } = 2.5f;
        public List<Vector3> Outline { get; } = new List<Vector3>();
        public List<WallInfo> Walls { get; } = new List<WallInfo>();
        public List<ObjectInfo> Objects { get; } = new List<ObjectInfo>();

        public event Action OnReady;

        [Tooltip("Seconds to wait for MR Utility Kit before falling back to a default room.")]
        public float sceneTimeout = 8f;

        Transform m_MrRoot;       // occluders + shadow catcher (MR mode)
        Transform m_VrRoot;       // painted virtual room (VR mode)
        Transform m_ColliderRoot; // always on
        Material m_WallMat, m_FloorMat;

        void Awake() => Instance = this;

        IEnumerator Start()
        {
            var t = 0f;
            while (MRUK.Instance == null && t < 2f) { t += Time.deltaTime; yield return null; }
            if (MRUK.Instance != null) MRUK.Instance.RegisterSceneLoadedCallback(OnSceneLoaded);
            t = 0f;
            while (!Ready && t < sceneTimeout) { t += Time.deltaTime; yield return null; }
            if (!Ready)
            {
                Debug.Log("[VRShop] No room model from MRUK; using a default room. (Run Space Setup on the Quest for your real room.)");
                BuildFallback();
            }
        }

        void OnSceneLoaded()
        {
            // A real Space Setup always wins; it can also replace the default room if it arrives late
            // (e.g. MRUK sent the user through Space Setup first).
            if (Ready && FromDevice) return;
            var mruk = MRUK.Instance;
            var room = mruk.GetCurrentRoom() ?? (mruk.Rooms.Count > 0 ? mruk.Rooms[0] : null);
            if (room == null || room.FloorAnchor == null)
            {
                BuildFallback();
                return;
            }
            try
            {
                Extract(room);
                FromDevice = true;
                Finish();
            }
            catch (Exception e)
            {
                Debug.LogError($"[VRShop] Failed to read room: {e}");
                BuildFallback();
            }
        }

        void Extract(MRUKRoom room)
        {
            Outline.Clear(); Walls.Clear(); Objects.Clear();
            FloorY = room.FloorAnchor.transform.position.y;
            if (room.CeilingAnchor != null) CeilingHeight = Mathf.Max(2f, room.CeilingAnchor.transform.position.y - FloorY);

            var outline = room.GetRoomOutline();
            if (outline != null && outline.Count >= 3)
                Outline.AddRange(outline.Select(p => new Vector3(p.x, FloorY, p.z)));
            else
                Outline.AddRange(room.FloorAnchor.PlaneBoundary2D.Select(p => room.FloorAnchor.transform.TransformPoint(new Vector3(p.x, p.y, 0f))).Select(p => new Vector3(p.x, FloorY, p.z)));

            var centroid = Centroid();
            foreach (var wall in room.WallAnchors)
            {
                if (!wall.PlaneRect.HasValue) continue;
                var rect = wall.PlaneRect.Value;
                var center = wall.transform.TransformPoint(new Vector3(rect.center.x, rect.center.y, 0));
                var n = Vector3.ProjectOnPlane(wall.transform.forward, Vector3.up).normalized;
                var toCenter = centroid - center; toCenter.y = 0;
                if (Vector3.Dot(n, toCenter) < 0) n = -n;
                Walls.Add(new WallInfo { center = center, normal = n, width = rect.width, height = rect.height });
            }

            foreach (var a in room.Anchors)
            {
                var label = a.Label.ToString();
                if (a.HasAnyLabel(MRUKAnchor.SceneLabels.DOOR_FRAME | MRUKAnchor.SceneLabels.WINDOW_FRAME) && a.PlaneRect.HasValue)
                {
                    var r = a.PlaneRect.Value;
                    var n = Vector3.ProjectOnPlane(a.transform.forward, Vector3.up).normalized;
                    Objects.Add(new ObjectInfo
                    {
                        label = a.HasAnyLabel(MRUKAnchor.SceneLabels.DOOR_FRAME) ? "DOOR_FRAME" : "WINDOW_FRAME",
                        center = a.transform.TransformPoint(new Vector3(r.center.x, r.center.y, 0)),
                        size = new Vector3(r.width, r.height, 0.05f),
                        yawDeg = Mathf.Atan2(n.x, n.z) * Mathf.Rad2Deg,
                    });
                    continue;
                }
                if (!a.VolumeBounds.HasValue) continue;
                if (a.HasAnyLabel(MRUKAnchor.SceneLabels.WALL_FACE | MRUKAnchor.SceneLabels.FLOOR | MRUKAnchor.SceneLabels.CEILING | MRUKAnchor.SceneLabels.GLOBAL_MESH)) continue;
                Objects.Add(VolumeToObject(label, a.transform, a.VolumeBounds.Value));
            }
        }

        /// <summary>Convert an anchor-local volume to a yaw-only box in world space.</summary>
        static ObjectInfo VolumeToObject(string label, Transform t, Bounds b)
        {
            var axes = new[] { t.right, t.up, t.forward };
            var sizes = new[] { b.size.x * t.lossyScale.x, b.size.y * t.lossyScale.y, b.size.z * t.lossyScale.z };
            var vertical = 0;
            for (var i = 1; i < 3; i++) if (Mathf.Abs(axes[i].y) > Mathf.Abs(axes[vertical].y)) vertical = i;
            var horiz = Enumerable.Range(0, 3).Where(i => i != vertical).ToArray();
            var depthAxis = Vector3.ProjectOnPlane(axes[horiz[1]], Vector3.up).normalized;
            return new ObjectInfo
            {
                label = label,
                center = t.TransformPoint(b.center),
                size = new Vector3(Mathf.Abs(sizes[horiz[0]]), Mathf.Abs(sizes[vertical]), Mathf.Abs(sizes[horiz[1]])),
                yawDeg = Mathf.Atan2(depthAxis.x, depthAxis.z) * Mathf.Rad2Deg,
            };
        }

        void BuildFallback()
        {
            if (Ready) return;
            Outline.Clear(); Walls.Clear(); Objects.Clear();
            var head = Camera.main != null ? Camera.main.transform : transform;
            var fwd = Vector3.ProjectOnPlane(head.forward, Vector3.up);
            if (fwd.sqrMagnitude < 0.01f) fwd = Vector3.forward;
            fwd.Normalize();
            var right = Vector3.Cross(Vector3.up, fwd);
            FloorY = 0f;
            var c = new Vector3(head.position.x, 0, head.position.z) + fwd * 1.2f;
            const float w = 4f, d = 4.5f;
            Outline.Add(c - right * w / 2 - fwd * d / 2);
            Outline.Add(c - right * w / 2 + fwd * d / 2);
            Outline.Add(c + right * w / 2 + fwd * d / 2);
            Outline.Add(c + right * w / 2 - fwd * d / 2);
            for (var i = 0; i < Outline.Count; i++)
            {
                var a = Outline[i]; var b = Outline[(i + 1) % Outline.Count];
                var mid = (a + b) / 2; mid.y = CeilingHeight / 2;
                var n = (c - (a + b) / 2); n.y = 0;
                Walls.Add(new WallInfo { center = mid, normal = n.normalized, width = Vector3.Distance(a, b), height = CeilingHeight });
            }
            FromDevice = false;
            Finish();
        }

        void Finish()
        {
            BuildColliders();
            BuildMixedRealityHelpers();
            BuildVirtualRoom(null);
            Ready = true;
            Debug.Log($"[VRShop] Room ready ({(FromDevice ? "Space Setup" : "default")}): {Walls.Count} walls, {Objects.Count} objects, floor y={FloorY:F2}, head y={(Camera.main != null ? Camera.main.transform.position.y : float.NaN):F2}");
            OnReady?.Invoke();
        }

        // ------------------------------------------------------------------ queries
        public Vector3 Centroid()
        {
            if (Outline.Count == 0) return Vector3.zero;
            var s = Vector3.zero;
            foreach (var p in Outline) s += p;
            return s / Outline.Count;
        }

        public bool Contains(Vector3 p)
        {
            var inside = false;
            for (int i = 0, j = Outline.Count - 1; i < Outline.Count; j = i++)
            {
                var a = Outline[i]; var b = Outline[j];
                if ((a.z > p.z) != (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
            }
            return inside;
        }

        /// <summary>Nearest wall to a point (horizontal distance to the wall plane within its width).</summary>
        public WallInfo NearestWall(Vector3 p, out float distance)
        {
            WallInfo best = null;
            distance = float.MaxValue;
            foreach (var w in Walls)
            {
                var tangent = Vector3.Cross(Vector3.up, w.normal);
                var rel = p - w.center; rel.y = 0;
                if (Mathf.Abs(Vector3.Dot(rel, tangent)) > w.width / 2 + 0.2f) continue;
                var d = Vector3.Dot(rel, w.normal);
                if (d > -0.3f && d < distance) { distance = d; best = w; }
            }
            return best;
        }

        public RoomGeometryDto ToDto()
        {
            var head = Camera.main != null ? Camera.main.transform : transform;
            return new RoomGeometryDto
            {
                floorY = FloorY,
                ceilingHeight = CeilingHeight,
                floorPolygon = Outline.Select(p => new XZ { x = p.x, z = p.z }).ToList(),
                walls = Walls.Select(w => new WallDto { center = new Vec3(w.center), normal = new Vec3(w.normal), width = w.width, height = w.height }).ToList(),
                objects = Objects.Select(o => new ObjectDto { label = o.label, center = new Vec3(o.center), size = new Vec3(o.size), yawDeg = o.yawDeg }).ToList(),
                user = new UserDto { position = new Vec3(head.position), forward = new Vec3(Vector3.ProjectOnPlane(head.forward, Vector3.up).normalized) },
            };
        }

        // ------------------------------------------------------------------ builders
        Transform Group(ref Transform field, string name)
        {
            if (field != null) Destroy(field.gameObject);
            field = new GameObject(name).transform;
            field.SetParent(transform, false);
            return field;
        }

        void BuildColliders()
        {
            var root = Group(ref m_ColliderRoot, "RoomColliders");
            // Floor: large thin box so the laser always finds the floor, even outside the traced outline.
            var floor = new GameObject("FloorCollider");
            floor.transform.SetParent(root, false);
            floor.transform.position = new Vector3(Centroid().x, FloorY - 0.01f, Centroid().z);
            var fc = floor.AddComponent<BoxCollider>();
            fc.size = new Vector3(40, 0.02f, 40);
            floor.AddComponent<RoomSurface>().kind = SurfaceKind.Floor;

            foreach (var w in Walls)
            {
                var go = new GameObject("WallCollider");
                go.transform.SetParent(root, false);
                go.transform.SetPositionAndRotation(w.center - w.normal * 0.05f, Quaternion.LookRotation(w.normal, Vector3.up));
                var bc = go.AddComponent<BoxCollider>();
                bc.size = new Vector3(w.width, w.height, 0.1f);
                var rs = go.AddComponent<RoomSurface>();
                rs.kind = SurfaceKind.Wall;
                rs.label = "WALL";
            }
            foreach (var o in Objects.Where(o => !o.isOpening))
            {
                var go = new GameObject($"Object_{o.label}");
                go.transform.SetParent(root, false);
                go.transform.SetPositionAndRotation(o.center, Quaternion.Euler(0, o.yawDeg, 0));
                go.AddComponent<BoxCollider>().size = o.size;
                var rs = go.AddComponent<RoomSurface>();
                rs.kind = SurfaceKind.Object;
                rs.label = o.label;
            }
        }

        void BuildMixedRealityHelpers()
        {
            var root = Group(ref m_MrRoot, "MixedRealityHelpers");
            // Shadow catcher on the real floor.
            var sc = GameObject.CreatePrimitive(PrimitiveType.Quad);
            Destroy(sc.GetComponent<Collider>());
            sc.name = "ShadowCatcher";
            sc.transform.SetParent(root, false);
            sc.transform.SetPositionAndRotation(new Vector3(Centroid().x, FloorY + 0.002f, Centroid().z), Quaternion.Euler(90, 0, 0));
            sc.transform.localScale = new Vector3(20, 20, 1);
            var scr = sc.GetComponent<MeshRenderer>();
            scr.sharedMaterial = VRShopMaterials.ShadowCatcher;
            scr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            scr.receiveShadows = true;

            // Depth-only occluders: real walls + real furniture hide virtual items behind them.
            foreach (var w in Walls)
            {
                var q = GameObject.CreatePrimitive(PrimitiveType.Cube);
                Destroy(q.GetComponent<Collider>());
                q.name = "WallOccluder";
                q.transform.SetParent(root, false);
                q.transform.SetPositionAndRotation(w.center - w.normal * 0.03f, Quaternion.LookRotation(w.normal, Vector3.up));
                q.transform.localScale = new Vector3(w.width, w.height, 0.04f);
                SetOccluder(q);
            }
            foreach (var o in Objects.Where(o => !o.isOpening))
            {
                var q = GameObject.CreatePrimitive(PrimitiveType.Cube);
                Destroy(q.GetComponent<Collider>());
                q.name = $"Occluder_{o.label}";
                q.transform.SetParent(root, false);
                // Tables and desks are open underneath: occlude only the top slab so a virtual rug (or a chair tucked
                // under) still shows between the legs. Couches, beds and storage are solid to the floor.
                var top = o.center.y + o.size.y / 2;
                var slab = o.label.Contains("TABLE") || o.label.Contains("DESK") ? Mathf.Min(0.05f, o.size.y) : o.size.y;
                q.transform.SetPositionAndRotation(new Vector3(o.center.x, top - slab / 2, o.center.z), Quaternion.Euler(0, o.yawDeg, 0));
                q.transform.localScale = new Vector3(o.size.x * 0.98f, slab * 0.98f, o.size.z * 0.98f);
                SetOccluder(q);

                // Solid furniture standing on the floor also gets a low "skirt" a few cm wider than its box: it hides
                // only floor-level virtual items (rugs), so a rug stays under the couch even when the hand-drawn
                // Space Setup box is slightly off, without clipping a virtual chair placed beside it.
                var onFloor = o.center.y - o.size.y / 2 < FloorY + 0.1f;
                if (onFloor && slab >= o.size.y)
                {
                    var skirt = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    Destroy(skirt.GetComponent<Collider>());
                    skirt.name = $"FloorSkirt_{o.label}";
                    skirt.transform.SetParent(root, false);
                    skirt.transform.SetPositionAndRotation(new Vector3(o.center.x, FloorY + 0.015f, o.center.z), Quaternion.Euler(0, o.yawDeg, 0));
                    skirt.transform.localScale = new Vector3(o.size.x + 0.08f, 0.03f, o.size.z + 0.08f);
                    SetOccluder(skirt);
                }
            }
        }

        static void SetOccluder(GameObject go)
        {
            var r = go.GetComponent<MeshRenderer>();
            r.sharedMaterial = VRShopMaterials.DepthOccluder;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = false;
        }

        /// <summary>Full-color virtual version of the room for VR mode: floor + walls painted from the room analysis.</summary>
        RoomAnalysis m_Analysis;
        readonly List<Material> m_VrMats = new List<Material>();

        Material VrMat(Color c)
        {
            var m = VRShopMaterials.Instance(VRShopMaterials.Lit, c);
            m_VrMats.Add(m);
            return m;
        }

        /// <summary>Editor-only stand-in for passthrough (see PassthroughController); never built on the headset.</summary>
        public void BuildVirtualRoom(RoomAnalysis analysis)
        {
            // Remember the AI palette so a later room rebuild (Space Setup arriving) keeps the colors.
            if (analysis != null) m_Analysis = analysis;
            if (!PassthroughController.NeedsEditorPreview) return;
            analysis = m_Analysis;
            foreach (var old in m_VrMats) if (old != null) Destroy(old);
            m_VrMats.Clear();
            var root = Group(ref m_VrRoot, "VirtualRoom");
            var wallColor = VRShopMaterials.Hex(analysis?.walls?.colorHex, new Color(0.93f, 0.92f, 0.9f));
            var floorColor = VRShopMaterials.Hex(analysis?.floor?.colorHex, new Color(0.62f, 0.48f, 0.36f));
            m_WallMat = VrMat(wallColor);
            m_FloorMat = VrMat(floorColor);
            if (m_FloorMat.HasProperty("_Smoothness")) m_FloorMat.SetFloat("_Smoothness", 0.35f);
            if (m_WallMat.HasProperty("_Smoothness")) m_WallMat.SetFloat("_Smoothness", 0.1f);

            // Floor polygon (fan triangulation from the centroid: fine for the convex-ish rooms Space Setup produces).
            if (Outline.Count >= 3)
            {
                var c = Centroid();
                var verts = new List<Vector3> { new Vector3(c.x, FloorY, c.z) };
                verts.AddRange(Outline.Select(p => new Vector3(p.x, FloorY, p.z)));
                var tris = new List<int>();
                for (var i = 1; i <= Outline.Count; i++)
                {
                    var j = i == Outline.Count ? 1 : i + 1;
                    var n = Vector3.Cross(verts[i] - verts[0], verts[j] - verts[0]);
                    if (n.y >= 0) { tris.Add(0); tris.Add(i); tris.Add(j); } else { tris.Add(0); tris.Add(j); tris.Add(i); }
                }
                var mesh = new Mesh { name = "VirtualFloor" };
                mesh.SetVertices(verts);
                mesh.SetTriangles(tris, 0);
                mesh.SetUVs(0, verts.Select(v => new Vector2(v.x, v.z)).ToList());
                mesh.RecalculateNormals();
                mesh.RecalculateBounds();
                var floor = new GameObject("Floor", typeof(MeshFilter), typeof(MeshRenderer));
                floor.transform.SetParent(root, false);
                floor.GetComponent<MeshFilter>().sharedMesh = mesh;
                var fr = floor.GetComponent<MeshRenderer>();
                fr.sharedMaterial = m_FloorMat;
                fr.receiveShadows = true;
            }
            foreach (var w in Walls)
            {
                var q = GameObject.CreatePrimitive(PrimitiveType.Cube);
                Destroy(q.GetComponent<Collider>());
                q.name = "Wall";
                q.transform.SetParent(root, false);
                q.transform.SetPositionAndRotation(new Vector3(w.center.x, FloorY + CeilingHeight / 2, w.center.z) - w.normal * 0.05f, Quaternion.LookRotation(w.normal, Vector3.up));
                q.transform.localScale = new Vector3(w.width + 0.1f, CeilingHeight, 0.1f);
                var r = q.GetComponent<MeshRenderer>();
                r.sharedMaterial = m_WallMat;
                r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                // Baseboard
                var bb = GameObject.CreatePrimitive(PrimitiveType.Cube);
                Destroy(bb.GetComponent<Collider>());
                bb.name = "Baseboard";
                bb.transform.SetParent(root, false);
                bb.transform.SetPositionAndRotation(new Vector3(w.center.x, FloorY + 0.05f, w.center.z) + w.normal * 0.005f, Quaternion.LookRotation(w.normal, Vector3.up));
                bb.transform.localScale = new Vector3(w.width, 0.1f, 0.02f);
                bb.GetComponent<MeshRenderer>().sharedMaterial = VrMat(Color.Lerp(wallColor, Color.white, 0.5f));
            }
            // Real furniture from Space Setup shown as soft gray blocks so the user keeps their bearings.
            foreach (var o in Objects.Where(o => !o.isOpening))
            {
                var q = GameObject.CreatePrimitive(PrimitiveType.Cube);
                Destroy(q.GetComponent<Collider>());
                q.name = $"Existing_{o.label}";
                q.transform.SetParent(root, false);
                q.transform.SetPositionAndRotation(o.center, Quaternion.Euler(0, o.yawDeg, 0));
                q.transform.localScale = o.size;
                q.GetComponent<MeshRenderer>().sharedMaterial = VrMat(new Color(0.7f, 0.7f, 0.72f));
            }
            root.gameObject.SetActive(m_VrActive);
        }

        bool m_VrActive;

        /// <summary>true = Editor preview room, false = passthrough helpers (MR).</summary>
        public void SetVirtualRoomVisible(bool vr)
        {
            m_VrActive = vr;
            if (m_VrRoot != null) m_VrRoot.gameObject.SetActive(vr);
            if (m_MrRoot != null) m_MrRoot.gameObject.SetActive(!vr);
        }
    }
}
