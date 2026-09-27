# VRShop — Quest 2 app (Unity 6000.3.13f1)

Everything lives in `Assets/VRShop/`. There are no prefabs to wire: the editor tools build the scene and
configure the project for you. Budget ~30–45 minutes the first time (mostly package downloads + first build).

## 0. What you need

- Unity **6000.3.13f1** with modules: **Android Build Support**, **OpenJDK**, **Android SDK & NDK Tools** (Unity Hub → Installs → ⚙ → Add modules).
- The Quest 2 in **Developer Mode** (see §5) and a USB-C data cable.
- The VRShop backend running on a laptop that the Quest can reach (see the repo `README.md`).

## 1. Open the project

This `unity/` folder **is** the Unity project (packages are pinned in `Packages/manifest.json` + `packages-lock.json`,
settings are in `ProjectSettings/`, and every asset's `.meta` is committed so scene references survive across machines).

1. Unity Hub → **Add** → **Add project from disk** → pick this `unity/` folder → open with **6000.3.13f1**.
2. The first open downloads Meta XR Core SDK 207, MR Utility Kit 207, OpenXR 1.18, glTFast 6.20 and Newtonsoft JSON
   from Meta's and Unity's registries (a few minutes). The project is already configured for Quest and the scene is
   already built, so you can go straight to §3 / §4. Steps in §2 are only needed to change the backend URL or re-apply
   settings.

Headless (terminal / CI), from the repo root:

```bash
UNITY=/Applications/Unity/Hub/Editor/6000.3.13f1/Unity.app/Contents/MacOS/Unity
# configure for Quest + rebuild the scene with a backend URL
$UNITY -batchmode -projectPath unity -buildTarget Android -executeMethod VRShop.EditorTools.BatchSetup.Setup -backendUrl http://192.168.1.23:8787
# build unity/Builds/VRShop.apk, then install it
$UNITY -batchmode -projectPath unity -buildTarget Android -executeMethod VRShop.EditorTools.BatchSetup.BuildApk
adb install -r unity/Builds/VRShop.apk
# end-to-end check in Play mode (backend must be running): session → room → Design my room → real GLBs → fit
$UNITY -batchmode -projectPath unity -buildTarget Android -executeMethod VRShop.EditorTools.PlayModeSmoke.Run
```

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

Press **Play**. VRShop is mixed-reality only, but the Mac editor can't show passthrough, so in the Editor (only) a simple
*preview room* stands in for your real one, built from MRUK's sample living room. Controls: mouse = right controller ray (**click** = trigger, **right-click** = grip, **scroll** =
rotate item), **Tab** = A (catalog), **Backspace** = B (delete), hold **V** = X (voice),
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
| Trigger / grip on furniture + move | select + slide along the floor (wall art slides along walls); your real furniture and walls are solid |
| Release near a wall | snaps flush to the wall |
| Right (or left) thumbstick ← → | rotate the selected item |
| Point at your real furniture (a Space Setup box) + trigger | its card: **Keep** / **Replace** / type / **Adjust** the box |
| Thumbstick ↑ ↓ on a replaced piece (or its replacement) | try the next / previous replacement |
| Drag a table lamp or small plant onto a table / dresser / shelf (virtual or real) | it stands on it and moves with it; drag it off the edge to put it back on the floor |
| **A** | show / hide the catalog in front of you |
| **B** | delete the selected item |
| hold **X** | talk to your designer: "a tall plant for this corner under 80 dollars" (point where it should go) |
| point at the **orb** + trigger | talk without holding anything — it stops listening when you pause; tap it while it speaks to interrupt |

**Your designer (the orb).** A small pearl orb floats at the lower left of your view. It breathes while idle, glows
gold and ripples with your voice while listening, turns rose with a spinning brass arc while thinking, and pulses as it
speaks. Replies are spoken (OpenAI text to speech via the backend, cached in `backend/data/tts`) and captioned in the
bubble beside it. Without `OPENAI_API_KEY` the captions still appear, just without the voice.

**Your real furniture.** Every Space Setup box is kept by default (solid: nothing virtual ends up inside it) or can be
replaced: it's painted out of passthrough and a product of the same kind and size stands in its spot ("replace my
couch with a green velvet sofa" works by voice too). See [docs/REAL_FURNITURE.md](../docs/REAL_FURNITURE.md).

**The showroom (A).** Three tabs: *For you* (the designer's picks for your room, one category chip at a time),
*Browse* (the whole catalog; filter chips open drop-down menus) and *Bag* (budget + "Buy the room with Visa").
Cards open a detail view with *Place in my room* / *Add to bag*.

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
| Compile errors mentioning Meta/MRUK/glTFast types | The packages didn't finish installing: wait, or check Window → Package Manager (Meta's registry must be reachable). |

## Code map

```
Scripts/Core/VRShopApp.cs            entry point: creates subsystems, backend session sync, "Design my room"
Scripts/Api/                         REST client + JSON models (mirror backend/src/types.ts), image cache
Scripts/Room/RoomService.cs          Space Setup via MRUK → colliders, occluders, shadow catcher, Editor preview room
Scripts/Rendering/                   passthrough (MR), room-matched lighting, materials
Scripts/Furniture/                   placing items, glTFast loading, ghost → model swap, layout animation
Scripts/Interaction/                 controller laser, drag/rotate/wall-snap, fit check
Scripts/UI/                          code-built world-space UI: Theme (colors + fonts), UIKit, catalog, filter menus, item tags, toasts
Scripts/Assistant/AssistantOrb.cs    the designer orb: listening / thinking / speaking states, captions, spoken replies
Scripts/Voice/                       hold-X or tap-the-orb voice (mic → backend → OpenAI), WAV encode/decode
Fonts/                               Inter + DM Serif Display (SIL OFL); VRShop > Rebuild UI Fonts bakes them into Resources/VRShopFonts
Shaders/                             shadow catcher, depth occluder, contact-shadow blob, ghost
Editor/                              package installer, setup window, project configurator, scene builder
```
