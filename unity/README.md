# VRShop — Quest 2 app (Unity 6000.3.13f1)

Everything lives in `Assets/VRShop/`. There are no prefabs to wire: the editor tools build the scene and
configure the project for you. Budget ~30–45 minutes the first time (mostly package downloads + first build).

## 0. What you need

- Unity **6000.3.13f1** with modules: **Android Build Support**, **OpenJDK**, **Android SDK & NDK Tools** (Unity Hub → Installs → ⚙ → Add modules).
- The Quest 2 in **Developer Mode** (see §5) and a USB-C data cable.
- The VRShop backend running on a laptop that the Quest can reach (see the repo `README.md`).

## 1. Create the Unity project

1. Unity Hub → **New project** → editor **6000.3.13f1** → template **Universal 3D** (URP) → name it `VRShopQuest`.
2. Close nothing — just copy this repo's `unity/Assets/VRShop` folder into the new project's `Assets/` folder
   (Finder drag-and-drop is fine). Unity imports it.
3. A dialog asks to install the VRShop packages → **Install**. (Or menu **VRShop → 1. Install Packages**.)
   It adds Meta XR Core SDK 207, MR Utility Kit 207, OpenXR 1.18, glTFast 6.20 and Newtonsoft JSON, plus Meta's
   package registry. Wait for the import + recompile. If Unity asks to **enable the new Input System backend /
   restart**, click **Yes**. If a Meta "Project Setup" popup appears, you can close it (step 2 handles it).

> The rest of the VRShop code only compiles once those packages exist (asmdef define constraints), so seeing
> just the **VRShop → 1. Install Packages** menu before this step is expected.

## 2. Configure + build the scene

Menu **VRShop → Setup Window**:

1. Type the **Backend URL** as the Quest will see it, e.g. `http://192.168.1.23:8787` (the backend prints it on start).
   Click **Test connection** → should say `OK`.
2. **2. Configure project for Quest** — switches to Android, IL2CPP/ARM64, Vulkan, Linear, ASTC, allows HTTP to the
   LAN backend, enables passthrough/scene/anchors/hands, tunes URP for Quest 2 (MSAA 4x, 2K soft shadows, no HDR),
   imports TMP resources, creates runtime materials + glTF shader-variant keepers, then runs Meta's Project Setup Tool
   "Fix All". Afterwards open **Meta → Tools → Project Setup Tool**: if anything is red, click **Fix All**.
   Also check **Edit → Project Settings → XR Plug-in Management → Android tab**: **OpenXR** checked, and under
   OpenXR → **Meta Quest Support** + **Meta XR** feature group enabled.
3. **3. Build scene** — creates `Assets/VRShop/Scenes/VRShop.unity` (Meta camera rig with passthrough, MR Utility Kit,
   key light, `VRShopApp`) and sets it as the only build scene.

## 3. Try it in the Editor (no headset)

Press **Play**. The Mac editor can't show passthrough, so you get the full-color *virtual room* built from MRUK's
sample living room. Controls: mouse = right controller ray (**click** = trigger, **right-click** = grip, **scroll** =
rotate item), **Tab** = A (catalog), **Backspace** = B (delete), hold **V** = X (voice), **M** = Y (passthrough ↔ virtual),
**WASD / arrows / Q E** = move / look. The backend must be reachable from the Mac (use `http://localhost:8787` while testing
in the editor, then switch back to the LAN URL before building).

Optional: Meta XR Simulator (runs on Apple Silicon) gives a simulated headset + synthetic rooms in Play mode.

## 4. Build & run on the Quest

1. Plug the Quest in, put it on, accept **Allow USB debugging** (tick *Always allow*).
2. **VRShop → Setup Window → 4. Build & Run on Quest (USB)**. First build takes 5–15 min (IL2CPP); later builds are faster.
3. The app appears on the Quest under **Library → Unknown Sources → VRShop**.

Change the backend URL later without rebuilding: set it in the window and click **Send to Quest (adb)**, then restart the app
(it writes `/sdcard/Android/data/com.vrshop.app/files/vrshop.json`).

## 5. One-time Quest 2 setup

- **Developer Mode:** create/verify a developer account at developers.meta.com (create an Organization), then in the
  **Meta Horizon** phone app → Devices → your Quest → Headset settings → **Developer Mode: On**. Reboot the headset.
- **Space Setup (important):** on the Quest 2 go to **Settings → Physical Space → Space Setup** and trace your walls,
  then **add furniture** (couch, table, bed, storage…) and **mark doors and windows**. VRShop uses this for occlusion, shadows,
  wall snapping, the fit check, and AI "Design my room". Quest 2 can't auto-scan, so draw the boxes carefully — it's the
  metric ground truth. If there's no Space Setup, the app asks for it (or falls back to a 4 × 4.5 m default room).
- First launch asks for **spatial data** and **microphone** permission — allow both.

## 6. Controls (Touch controllers)

| Input | Action |
|---|---|
| Trigger / grip on UI | click |
| Trigger / grip on furniture + move | select + slide along the floor (wall art slides along walls) |
| Release near a wall | snaps flush to the wall |
| Right (or left) thumbstick ← → | rotate the selected item |
| **A** | show / hide the catalog in front of you |
| **B** | delete the selected item |
| hold **X** | voice search: "a tall plant for this corner under 80 dollars" (point where it should go) |
| **Y** | passthrough ↔ full-color virtual room |

The footprint outline turns **red** when an item collides with real furniture, other items, goes past a wall or blocks a door;
the tag also warns if it may not fit through your door for delivery.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Furniture is pink/magenta or flat in the build | Re-run **2. Configure** (creates `Resources/GltfVariantKeepers`), then rebuild. |
| No text in the UI | Window → TextMeshPro → Import TMP Essential Resources. |
| "Can't reach the VRShop server" | Backend running? Same Wi-Fi? Hackathon Wi-Fi often blocks device-to-device traffic: use a phone hotspot, or a tunnel (`cloudflared tunnel --url http://localhost:8787`) and put the https URL in the Setup Window. |
| Black background instead of passthrough | Project Setup Tool → Fix All; OVRManager → *Insight Passthrough* enabled; OpenXR Meta features on. |
| Room walls in the wrong place | Redo Space Setup on the Quest, then restart the app. |
| Compile errors mentioning Meta/MRUK/glTFast types | The packages didn't finish installing: **VRShop → 1. Install Packages**, wait, check the Package Manager. |

## Code map

```
Scripts/Core/VRShopApp.cs            entry point: creates subsystems, backend session sync, "Design my room"
Scripts/Api/                         REST client + JSON models (mirror backend/src/types.ts), image cache
Scripts/Room/RoomService.cs          Space Setup via MRUK → colliders, occluders, shadow catcher, virtual room
Scripts/Rendering/                   passthrough ↔ virtual toggle, room-matched lighting, materials
Scripts/Furniture/                   placing items, glTFast loading, ghost → model swap, layout animation
Scripts/Interaction/                 controller laser, drag/rotate/wall-snap, fit check
Scripts/UI/                          code-built world-space UI: catalog, item tags, toasts
Scripts/Voice/VoiceCommand.cs        hold-X voice search (mic → backend → OpenAI)
Shaders/                             shadow catcher, depth occluder, contact-shadow blob, ghost
Editor/                              package installer, setup window, project configurator, scene builder
```
