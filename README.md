# VRShop — furnish your real room in VR, with real products

Scan your room with your phone → AI understands it and finds **real furniture from real stores** →
put on a **Meta Quest 2** and place **true-scale 3D models** of those exact products in your actual room,
walk around them, check they fit, let AI arrange the room, and check out with store links on your phone.

```
 iPhone (Safari)                    Backend (Node, your laptop)                          Quest 2 (Unity app)
 ───────────────                    ───────────────────────────                          ───────────────────
 photos + "cozy japandi,  ──POST──▶  OpenAI vision: room type, style, palette,           MR passthrough + your Space Setup
 $1,500"                             lighting, free space, shopping plan                 (walls, floor, furniture boxes, doors)
                                     │                                                    │
 recommendations, 3D preview,        ├─ IKEA search (free)  ─┐                            ├─ catalog panel: real photos,
 cart + store links      ◀──poll──   ├─ Google Shopping      ├─▶ AI ranking for the room  │  prices, stores, 3D-model source
                                     │  (SerpAPI: Amazon,    │                            ├─ Place: ghost box at true size →
                                     │  Wayfair, Target…)   ─┘                            │  real GLB (glTFast), shadows,
                                     ├─ 3D: IKEA official GLB │ image→3D (fal/Meshy/Tripo) │  occlusion by real walls/furniture
                                     │  │ procedural stand-in → normalized for Quest ────▶ ├─ drag / rotate / wall-snap,
                                     ├─ "Design my room" layout solver  ◀── room geometry ─┤  fit + doorway check
                                     └─ voice: transcription → intent → search  ◀── mic ───┤─ hold X: "a tall plant here"
                                                                                          └─ Y: full-color virtual room
```

| Folder | What |
|---|---|
| [`backend/`](backend) | Node/TypeScript API: room analysis, product search, 3D model pipeline, layout solver, voice, image proxy. Also serves the phone web app. |
| [`backend/public/`](backend/public) | Phone companion web app (capture, recommendations, 3D preview, cart). |
| [`unity/`](unity) | Quest 2 app for Unity 6000.3.13f1 — see [`unity/README.md`](unity/README.md) for the step-by-step setup. |
| [`docs/PLAN.md`](docs/PLAN.md) | The full plan: architecture decisions, research, 3-day schedule, demo script, LiDAR upgrade path. |

## Quick start

### 1. Backend (any Mac/PC on the same network as the Quest and phone)

```bash
cd backend && npm install
```

```bash
cp .env.example .env
```

Put your keys in `backend/.env` (all optional — without keys it still works with IKEA products and heuristic room analysis):
`OPENAI_API_KEY` (room vision, ranking, voice), `SERPAPI_KEY` (Google Shopping: Amazon/Wayfair/Target…), and one of
`FAL_KEY` / `MESHY_API_KEY` / `TRIPO_API_KEY` (AI 3D models for non-IKEA products).

```bash
npm run dev
```

It prints the URL to use, e.g. `http://192.168.1.23:8787`. Check everything end to end:

```bash
npm run smoke
```

### 2. Phone

Open the printed URL in Safari on the iPhone (same Wi-Fi). Take 4–8 photos (each wall + corners), describe the vibe and
budget, tap **Design my room**. Recommendations stream in within ~20–40 s.

### 3. Quest

Follow [`unity/README.md`](unity/README.md) once (create project, install packages, configure, build scene, Build & Run).
On the headset: do **Space Setup** (walls + furniture boxes + doors) first. Launch VRShop — it opens the latest room from the phone.

**Network tip:** hackathon Wi-Fi often blocks device-to-device traffic. Use a phone hotspot for all three devices, or expose
the backend with `cloudflared tunnel --url http://localhost:8787` and use the https URL everywhere.

## What's real vs. fallback

| Piece | With keys | Without keys |
|---|---|---|
| Room understanding | OpenAI vision (`gpt-6-sol`) on your photos | keyword heuristics from your text |
| Products | IKEA + Google Shopping (all stores), AI-ranked for your room | IKEA only, ranked by rating/price |
| 3D models | IKEA official GLBs (~80% of IKEA items) + AI-generated from listing photos | IKEA official GLBs + true-size procedural stand-ins |
| Voice search | OpenAI transcription + intent | — (typed search on the phone still works) |
| Layout ("Design my room") | deterministic solver over your real room geometry | same |

Before a demo: `npm run reset` clears old sessions (keeps the cached 3D models), then create a fresh room from the phone.

IKEA data and models are fetched on demand for this non-commercial prototype and credited to IKEA; commercial use would need
retailer partnerships (see `docs/PLAN.md`).
