# VRShop — Plan

**One line:** photograph your room, then put on a Quest and furnish your real room with real, buyable products shown as
true-scale 3D models. AI picks what fits your style, space and budget, and can arrange the whole room for you.

**How this amplifies the reference project (PIXX-AR, HackMIT 2026 Visa winner):**

| PIXX-AR (web) | VRShop |
|---|---|
| One photo in a "shallow 3D scene" | Your **actual room in the headset** at 1:1 scale, walls/floor/furniture from Space Setup |
| Flat product cutouts or stand-ins scaled to dimensions | **Real 3D models**: IKEA's official GLBs, AI image→3D for other stores, true-size stand-ins as fallback |
| Mouse placement | Walk around it; drag on the floor, rotate, **snap to walls**, real-time **shadows**, **occlusion** by real walls/furniture |
| Fit check vs typed measurements | **Live fit check** vs your real room: collisions with your couch, outside the walls, blocking the door, doorway delivery check |
| — | **"Design my room"**: an interior-layout solver arranges everything around your real furniture, animated |
| Text request | **Voice**: hold X, "a tall plant for this corner under $80", point where it goes |
| — | **Virtual room mode**: full-color digital version of your room (fixes Quest 2's grayscale passthrough) |

---

## 1. Decisions and why

### Headset reality: Meta Quest 2 (as of Sept 2026)
- Still supported: feature updates until **Dec 2026**, security until end of 2027. Meta XR SDK **v207** still targets Quest 2.
- **Passthrough is grayscale and low-res.** Colored virtual furniture over gray passthrough looks striking, but for judging
  color accuracy we added **Virtual Room mode** (Y button): the room re-built from Space Setup, walls/floor painted with the
  palette the AI extracted from your photos.
- **No depth sensor** means no automatic room mesh, no Depth API occlusion, and no camera access for apps. The metric truth is
  **Space Setup** (Settings → Physical Space), where the user traces walls and draws boxes for furniture. We read it through
  **MR Utility Kit (MRUK)** and use it for occlusion, shadows, collisions, wall snapping, fit checks and the AI layout.

### Runtime: Unity 6000.3.13f1 + Meta XR Core SDK 207 + MRUK 207 + OpenXR 1.18 + glTFast 6.20 (URP)
- Chosen for native Quest 2 performance and Meta's mature mixed-reality stack. The friend's Mac has Unity; Quest Link is
  Windows-only, so we iterate with **Editor Play mode** (built-in mouse/keyboard simulation plus MRUK's sample room) and
  **APK builds**. Meta XR Simulator (Apple Silicon) is optional.
- The research strongly favored **WebXR** for iteration speed and testability from a Mac. We kept the backend engine-agnostic,
  so a WebXR client (three.js + Spark for Gaussian splats) can be added later without backend changes.
- **Everything is built in code** (UI, scene objects, materials) plus editor tools that configure the project and generate the
  scene, so there's no fragile prefab or inspector wiring to reproduce by hand.

### Room capture without LiDAR (iPhone non-Pro)
- **Phone photos** (4–8: each wall and corner) → **OpenAI vision** for *understanding*: style, palette, lighting mood and
  color temperature, existing furniture, free zones, and a shopping plan with max sizes.
- **Quest Space Setup** gives *geometry*: metric walls, floor outline, furniture boxes, doors and windows, already in headset
  coordinates. Monocular depth from photos is off by 7–16%, so we don't trust photos for fit.
- **Optional photoreal twin** (Day 3 or later): Scaniverse (free, works without LiDAR, exports GLB mesh / PLY / SPZ splats) →
  load the mesh GLB in Virtual Room mode and align it to the Space Setup walls. Gaussian splats aren't viable natively on
  Quest 2; they'd need WebXR + Spark at about 150–300K splats.

### Products: real stores
- **IKEA** (free, no key): search API with prices, images and ratings, plus **official true-scale GLBs** for about 80% of
  items (bounding boxes within about 2% of listed dimensions). The GLBs must be fetched server-side because the CDN rejects
  third-party browser origins.
- **Google Shopping** covers Amazon, Wayfair, Target, Walmart and others, with price, thumbnail and store. It's available
  through two providers:
  - **Serper.dev** is preferred: 2,500 free queries, then about $1 per 1k.
  - **SerpAPI** gives 250 free a month, then about $15–25 per 1k.

  Google's current Shopping layout returns about 40 results per call with **no pagination**, so the bulk pull spreads over
  query variants. SerpAPI's `google_immersive_product` (1 extra search) resolves the direct store link; we call it lazily,
  only for items added to the cart.

### Catalog first, live search as fallback (voice + filters)
- **One bulk pull** (`npm run catalog:pull`, `backend/src/inventory/pull.ts`) fills `data/inventory.json`:
  - **IKEA** (free) returns its whole result set per query: about 2,300 real pieces in about 5 s.
  - **Google Shopping** adds about 1,000–2,500 listings from other stores. The "light" tier is 22 calls; `--full` is 40.
- **Classification:**
  - Each listing is mapped to one of 22 categories, and parts and accessories are dropped ("Cover for loveseat",
    "Sofa legs", lamp shades, door mats, patio furniture).
  - Listing text is normalized to canonical **colors / materials / styles** ("onyx" → black, "Grann/Bomstad" → leather,
    "walnut legs" ignored).
  - If a title names no color, the color is guessed from the product photo, which is free.
- **Every voice or typed turn is one fast LLM call** (`ai/assistant.ts`, heuristic parser without a key). It returns:
  - the complete next filter state;
  - a question type (cheapest, price range, average, count, best rated, budget left);
  - an action (open, place, add or remove from cart), plus which listed item it refers to ("the second one").
- **The server answers numeric questions from the real listings**, so prices are never hallucinated.
- **Cost guard:**
  - Filtering the catalog takes about 1–15 ms and is free.
  - A live store search runs only when a voice or typed request has fewer than `LIVE_MIN_RESULTS` matches, or when the
    user taps "Search stores for more".
  - Results are added to the catalog and the query is cached, so the same question never costs twice.
  - `SHOPPING_MONTHLY_LIMIT` hard-caps paid calls per month.
  - Manual filter taps never trigger a paid search.
- **Room analysis also draws from the catalog.** Picks for each category come from the pulled listings and are
  AI-ranked, so a new room costs 0 shopping searches instead of 6–10.
- **Not used:** Amazon PA-API 5 was retired in 2026; its replacement, the Creators API, needs 10 sales in 30 days. Wayfair and
  Target block scripts, and Wayfair's 3D API is dead.

### 3D models: first match wins
1. **IKEA official GLB**: exact geometry, PBR materials, true scale.
2. **Image → 3D** from the listing photo:
   - **fal.ai TRELLIS.2** is the fast default (MIT license, about $0.25–0.35).
   - **Rodin Gen-2** takes `bbox_condition` set to the listing's real W×D×H and is best for upholstery (about $0.40).
   - **Meshy** and **Tripo** are also supported.
   - The generated model is scaled to the listing dimensions, or an AI estimate if the listing has none.
3. **Procedural stand-in**, which always works:
   - Category-shaped (sofa, chair, table, lamp, shelf, bed, plant, rug, art) at the true size.
   - Tinted with the product photo's color.
   - Rugs and wall art use the product photo as their texture.

Every GLB goes through **normalization** (`backend/src/models/normalize.ts`):
- Meters, pivot at floor-center, front = +Z.
- Draco and meshopt decoded, WebP/AVIF converted to JPEG/PNG. Unity glTFast can't read WebP, and IKEA ships WebP + Draco.
- Exotic material extensions stripped.
- Textures at 1024, triangle budget enforced.
- Tables and rugs turned long-side-left-right.
- On the Unity side, **shader-variant keeper materials** guarantee glTFast's materials render in the Quest build instead of
  turning pink.

### AI (OpenAI, since that's the key you have)

| Job | Model |
|---|---|
| Room photos → structured analysis + shopping plan (JSON Schema structured outputs) | `gpt-6-sol` |
| Ranking listings for the room (thumbnails at low detail), dimension estimates, voice intent | `gpt-6-luna` (fast) |
| Speech → text | `gpt-transcribe` |

- All three are configurable in `.env`.
- A **heuristic fallback** keeps the whole flow working with no key.
- Lesson from PIXX-AR, baked into the prompt: queries must be *retail words* ("walnut mid century coffee table"), not
  designer jargon.

### Realism on Quest 2 (what actually moves the needle)
- Real product geometry and PBR (IKEA official), at **true scale**.
- **Soft real-time shadows** from one key light onto a **shadow-catcher** on the real floor, plus a **contact-shadow blob**
  under every item. This is what grounds virtual furniture in passthrough.
- **Occlusion**: depth-only copies of your real walls and Space Setup furniture, so a virtual sofa disappears behind your
  real table.
- **Lighting matched to your room**: the AI reads mood, brightness and color temperature (e.g. 3000 K warm) from the photos
  and drives the key light, trilight ambient, and a tinted procedural sky for reflections.
- URP tuned for Quest 2: MSAA 4x, no HDR, 2K soft shadows, one cascade, 7 m shadow distance.

---

## 2. Architecture

```
iPhone web app ──► backend (Node/TS, Express)  ◄──── Quest 2 (Unity)
                   ├─ ai/designer.ts      analyze room, rank products, voice intent (OpenAI; heuristic fallback)
                   ├─ search/ikea.ts      IKEA search + official GLB + product-page dimensions
                   ├─ search/serp.ts      Google Shopping + immersive product (store link, images, specs)
                   ├─ models/pipeline.ts  IKEA GLB → image→3D (fal/meshy/tripo) → stand-in; queue + progress
                   ├─ models/normalize.ts Quest/glTFast-safe GLB (scale, pivot, textures, variants, tri budget)
                   ├─ layout.ts           "Design my room" solver over the headset's real room geometry
                   ├─ session.ts          orchestration: analyze → search (parallel) → rank → stream results → prefetch models
                   └─ server.ts           REST API, image proxy (→ JPEG), model hosting, phone app
```

**API** (all JSON):

| Endpoint | What it does |
|---|---|
| `POST /api/sessions` | multipart photos + prompt + budget → session |
| `POST /api/sessions/demo` | session with no photos |
| `GET /api/sessions/latest` | the newest session, used by the Quest |
| `GET /api/sessions/:id?since=` | poll a session |
| `POST /api/sessions/:id/search {text}` | typed search that adds a category row (legacy) |
| `POST /api/sessions/:id/voice (audio, focusProductId?)` | voice turn with the shopping assistant (transcribe → filter / answer / act) |
| `POST /api/sessions/:id/ask {text, focusProductId?}` | the same turn, typed |
| `PUT /api/sessions/:id/browse {filters}` | manual filters over the catalog (never a paid search) |
| `POST /api/sessions/:id/browse/more` | "Search stores for more": live top-up for the current filters |
| `GET /api/catalog` | catalog size, pull status, shopping usage this month, filter vocabulary |
| `POST /api/catalog/pull {shopping: none\|light\|full}` | start a bulk pull in the background |
| `POST /api/sessions/:id/geometry` | Quest room model |
| `POST /api/sessions/:id/layout {productIds, user}` | → placements |
| `POST /api/sessions/:id/design {mode: style\|bag, style, placed, user}` | "Design my room": styled picks (or the bag) laid out; same-kind pieces are replaced, never doubled up → placements, removals, replaced real pieces |
| `GET /api/design/styles` | the design styles (Modern, Victorian, Scandinavian, …) |
| `PUT /api/sessions/:id/placements` | what's placed, synced to the phone |
| `POST /api/sessions/:id/cart {productId, qty}` | update the cart |
| `POST /api/products/:id/model {generate}` | start model preparation |
| `GET /api/products/:id` | model status + progress |
| `GET /models/:id.glb` | the model file |
| `GET /api/img?u=&w=` | JPEG image proxy |

**Coordinates:** meters, Y-up, Unity world space. Yaw: an item's front (+Z) faces `(sin yaw, cos yaw)`. Pivot at
floor-center.

---

## 3. What's in v1 (this commit)

**Built and tested here (end-to-end against live IKEA data):**
- The backend pipeline: 6 categories found and ranked, official GLBs downloaded and normalized in about 1 s each, and a
  sensible layout (sofa on the wall facing the TV, coffee table 45 cm in front, rug under the sofa's front legs, armchair
  facing the sofa, lamp beside it, plant in a free corner).
- The phone app: capture, room card, recommendations, 3D preview, and a cart grouped by store.
- Stand-ins and the image proxy.

**Written and verified, but not compiled:** the Unity app. There's no Unity on this machine. The code was parse-checked
with a real C# grammar and cross-checked against the actual Meta/MRUK/glTFast/OpenXR package sources.
**Expect a short fix-up pass on first compile.** Paste any Console errors back here and they'll get fixed.

**Not yet exercised (need keys):** OpenAI analysis/ranking/voice, SerpAPI, and the image→3D providers. The code follows
their current documented request shapes.

---

## 4. Schedule (2–4 days)

**Roles (adjust to your team):**
- **U** — Unity/Quest owner (friend with the Mac)
- **B** — backend/AI
- **P** — phone app + pitch + demo design
- **Everyone** — test in the headset

### Day 0 — tonight (2–3 h)

| Owner | Task |
|---|---|
| U | Install Unity modules (Android Build Support, OpenJDK, SDK/NDK). Follow `unity/README.md` §1–2. |
| Everyone | Put the Quest in **Developer Mode**. |
| B | Run the backend. Add keys to `.env` (OpenAI, SerpAPI, one of fal/Meshy/Tripo). Run `npm run smoke`. |
| B | Pick the network: test that the Quest can reach the laptop. Bring a travel router or hotspot. |
| Everyone | **Space Setup** on the Quest in the demo room: walls, couch/table boxes, door. |

### Day 1 — "it runs on the headset"

| Owner | Task |
|---|---|
| U | First compile in Unity. Paste errors → fix. Play mode in the Editor. Build & Run on the Quest. |
| U | Verify: passthrough, catalog, place an IKEA sofa, shadows, occlusion behind a real table, wall snap. |
| B | Real room photos → tune the analysis prompt and the ranking. Check Google Shopping results quality per category. |
| B | Pre-generate AI models for the demo's Google Shopping picks (cost control + no waiting on stage). |
| P | Phone UX pass on a real iPhone (camera input, HEIC, upload). Draft the pitch narrative. |

### Day 2 — "wow" polish

| Owner | Task |
|---|---|
| U | Tune lighting/shadow strength to match the demo room. Tune "Design my room" animation timing and the virtual room look. Tune voice UX. |
| U (stretch) | Hand-tracking pinch pointer (OVRHand `PointerPose` + pinch) to go controller-free. |
| B | Layout solver: add more room types (bedroom/office) with test geometries. Faster first results (stream the first category earlier). |
| P | Record a **backup demo video** through Quest casting. Build the pitch deck. |

### Day 3 — demo hardening (if you have it)
- `npm run reset`, then create the final demo room from the phone. Warm every model the demo uses.
- Rehearse the 3-minute script below 5+ times with the real network.
- Stretch: Scaniverse mesh twin in Virtual Room mode, and multi-store "agentic checkout" (see §7).

---

## 5. Demo script (3 min)
1. **(Phone, 30 s)**
   - Snap 5 photos of the room.
   - Type "cozy japandi reading corner, $1,500".
   - Tap Design. Show the room card: style tags, extracted palette, warm 3000 K lighting, shopping plan.
2. **(Headset, cast to a screen, 2 min)**
   - Put on the Quest: passthrough of the real room, catalog floating in front.
   - Open the IKEA armchair → **Place**. A true-size ghost appears instantly, then the real model settles in with a
     shadow on the real floor.
   - Walk around it. Drag it behind the real table: it's occluded. Push it into the real couch: the footprint turns red,
     "Overlaps your couch".
   - Hold X: *"a tall plant for this corner under 80 dollars"*, pointing at the corner. A new row appears; place it and it
     lands in the corner.
   - **Design my room**: the rest of the pieces fly into a designer layout around the real furniture.
   - Press Y for the **full-color virtual room**, then back.
3. **(Phone, 20 s)**
   - The cart syncs: grouped by store, with total vs budget and buy links.
   - Close: "From a vibe to a finished, measured room with real products in under two minutes."

**Pitch hooks:**
- **Visualization:** return rates for furniture are high because of size and style mismatch; we check both before you buy.
- **Scale:** it works with any store, because every listing gets a 3D model — official when one exists, generated otherwise.
- **Honesty:** we label official vs AI-generated models, and listing vs estimated dimensions.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Venue Wi-Fi blocks device-to-device traffic | Phone hotspot or travel router for all devices, or `cloudflared tunnel` (https). The app shows the URL it's trying. |
| Unity compile or runtime issues (code written without an editor) | Setup Window checks. Editor simulation mode. Fix-up pass on Day 1; paste errors here. |
| Pink materials in the build (shader stripping) | Keeper materials in `Resources/GltfVariantKeepers`, plus the backend normalizes every GLB to that feature set. |
| Quest 2 performance | Models capped at 60–80K tris with 1K textures. Single shadow cascade. Aim for ≤ 8 items on screen. Keep 72 Hz. |
| Image→3D latency (30 s – 2 min) and cost | Ghost box appears instantly with a progress %. Pre-generate demo items. IKEA official models are free and take about 1 s. |
| AI picks a wrong product type | Ranking prompt drops accessories and parts. IKEA accessory filter. The user can always voice or type a search. |
| IKEA endpoints change | Isolated in `search/ikea.ts`. Stand-ins keep the flow alive. Models are cached on disk after the first fetch. |
| Space Setup inaccurate (manual on Quest 2) | Redraw carefully before the demo. The fit check uses whatever Space Setup says. Virtual Room mode shows the traced geometry so errors are visible. |

---

## 7. After the hackathon / stretch
- **LiDAR** (see §8).
- **Hands:** pinch-to-select with OVRHand pointer poses; direct grab.
- **Multi-user:** roommates co-furnish with Shared Spatial Anchors (supported on Quest 2).
- **Agentic checkout:** like PIXX-AR's Visa Trusted Agent Protocol flow — approve the basket once, and the agent checks out
  per retailer. Keep it clearly labeled as sandbox.
- **Photoreal twin:** Gaussian-splat room (Scaniverse/Polycam SPZ) via a WebXR client with Spark, or a Quest 3 build.
- **Quest 3:** color passthrough + Depth API occlusion. The same app runs with better visuals.
- **Commerce data:** retailer partnerships (official 3D models, inventory, delivery windows), price tracking,
  second-hand/sustainable alternatives.

---

## 8. LiDAR upgrade path (when the scanner arrives)
The backend already treats room geometry as a pluggable input (`RoomGeometry` in `backend/src/types.ts`), so LiDAR slots in
without touching the product or 3D pipeline.

- **If it's an iPhone/iPad Pro**:
  - Build a tiny Swift app with **RoomPlan**. It uploads the `CapturedRoom` JSON (walls, doors, windows, furniture boxes with
    categories) plus the USDZ.
  - Add a `POST /api/sessions/:id/roomplan` endpoint that converts it to `RoomGeometry` in room coordinates.
  - The headset aligns RoomPlan walls to Space Setup walls: 2D rigid fit, with 90° hypotheses broken by door position, or a
    2-point manual alignment with the controllers.
  - Payoff: accurate furniture boxes without hand-drawing, and exact dimensions for the AI.
- **If it's a standalone scanner** (e.g. XGRIDS, Leica BLK, Matterport):
  - Ingest a **GLB/OBJ mesh** (twin mode in Unity via glTFast, aligned the same way) or **PLY/E57 point clouds**.
  - Run plane fitting to get walls and floor (RANSAC), and optionally SpatialLM on a cloud GPU for object boxes.
  - Splats (PLY/SPZ/LCC) go to a WebXR/Quest 3 client, not Quest 2 native.
- **Code touchpoints:**
  - backend: new `ingest/` module and `RoomGeometry.source`
  - Unity: `RoomService` gets a "scan" source alongside MRUK, plus a `TwinLoader` (glTFast) and an alignment gizmo
  - phone app: upload the scan file

---

## 9. Cost per room session (with all keys)

| Item | Cost |
|---|---|
| OpenAI analysis + ranking | a few cents |
| Google Shopping | **0 per session** once the catalog is pulled. The one-time pull costs 22–40 searches (Serper free tier: 2,500; SerpAPI: 250/month). Voice only searches live when the catalog is thin, capped by `SHOPPING_MONTHLY_LIMIT`. |
| IKEA | free |
| Image→3D | about $0.25–0.60 per generated item |
| **Total** | **about $1–2 per session**, dropping as the model cache fills |

---

## Sources (research, Sept 2026)

**Meta / Quest**
- Meta XR Core SDK v207 and Unity requirements: developers.meta.com/horizon/downloads/package/meta-xr-core-sdk
- Scene on Quest 2 (manual Space Setup, no global mesh): developers.meta.com/horizon/documentation/native/android/openxr-scene-overview
- Device budgets (Quest 2 vs 3): developers.meta.com/horizon/resources/device-optimization-comparison

**Unity packages**
- glTFast runtime import and shader variants: docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.x (Project Setup, Features)

**Products and 3D generation**
- SerpApi Google Shopping / Immersive Product: serpapi.com/google-shopping-api, serpapi.com/google-immersive-product-api
- Amazon PA-API retirement / Creators API: affiliate-program.amazon.com/creatorsapi/docs
- fal queue API + TRELLIS.2 / Rodin / Hunyuan: fal.ai/docs; Meshy: docs.meshy.ai; Tripo: docs.tripo3d.ai

**Room capture**
- Scaniverse exports: nianticspatial.com/blog/scaniverse
- Spark splats: sparkjs.dev/docs/performance

**AI**
- OpenAI models / structured outputs / speech-to-text: developers.openai.com/api/docs
