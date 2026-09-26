// Shared data model. Unity (Assets/VRShop/Scripts/Runtime/Api/ApiModels.cs) mirrors these
// shapes, so keep field names in sync when changing them.

/** Real-world size in meters. w = width (x), d = depth (z), h = height (y). */
export interface Dims { w: number; d: number; h: number }

export type DimsSource = 'listing' | 'model' | 'estimated';

export type ModelKind = 'official' | 'generated' | 'standin';
export type ModelStatus = 'none' | 'queued' | 'processing' | 'ready' | 'failed';

export interface ModelInfo {
  status: ModelStatus;
  kind?: ModelKind;
  url?: string;          // path of the normalized GLB on this server, e.g. /models/ikea-123.glb?v=abc (resolve against the base URL)
  progress?: number;     // 0..1
  message?: string;
  triangles?: number;
  bytes?: number;
}

export interface Product {
  id: string;                      // "ikea-70437814" | "gs-<hash>"
  source: 'ikea' | 'google_shopping';
  store: string;                   // "IKEA", "Wayfair", "Amazon.com", ...
  title: string;
  brand?: string;
  category: string;                // our normalized category key, e.g. "sofa"
  price: number | null;
  currency: string;
  priceText: string;
  rating?: number;
  reviews?: number;
  imageUrl: string;                // original image URL
  images: string[];
  productUrl: string;              // best known link (store page, or Google product page until resolved)
  storeLinkResolved?: boolean;
  dims?: Dims;
  dimsSource?: DimsSource;
  colors?: string[];
  why?: string;                    // AI: why this fits the room
  fitScore?: number;               // 0..1 from ranking
  model: ModelInfo;
  // provider-specific bits
  ikeaItemNo?: string;
  serpImmersiveToken?: string;
}

export interface PaletteColor { hex: string; name: string }

export interface Recommendation {
  category: string;                // normalized key: sofa, armchair, coffee_table, rug, floor_lamp, ...
  label: string;                   // human label, e.g. "Accent chair"
  query: string;                   // retailer-friendly search query (Google Shopping)
  ikeaQuery?: string;              // 1-3 plain words for IKEA's catalog search
  why: string;
  priority: number;                // 1 = most important
  maxDims?: Dims;                  // max size that fits the free space (m)
  budget?: number;                 // suggested spend for this item
  placement: { anchor: 'wall' | 'corner' | 'center' | 'window' | 'near'; near?: string };
}

export interface RoomAnalysis {
  roomType: string;
  summary: string;
  styleTags: string[];
  palette: PaletteColor[];
  lighting: { mood: 'warm' | 'neutral' | 'cool'; brightness: number; kelvin: number };
  floor: { material: string; colorHex: string };
  walls: { colorHex: string };
  existingFurniture: { name: string; category: string; location: string; colorHex?: string }[];
  freeZones: { description: string; approxWidthM: number; approxDepthM: number }[];
  estimatedSizeM: { width: number; depth: number; height: number; confidence: number };
  recommendations: Recommendation[];
  source: 'openai' | 'heuristic';
}

export interface CategoryResult {
  category: string;
  label: string;
  query: string;
  why: string;
  placement: Recommendation['placement'];
  productIds: string[];
  origin: 'analysis' | 'voice' | 'search';
}

/** Room geometry reported by the Quest (from MRUK / Space Setup). Unity world space, meters, Y-up. */
export interface RoomGeometry {
  floorY: number;
  ceilingHeight: number;
  floorPolygon: { x: number; z: number }[];
  walls: { center: Vec3; normal: Vec3; width: number; height: number }[];
  objects: { label: string; center: Vec3; size: Vec3; yawDeg: number }[];
  user?: { position: Vec3; forward: Vec3 };
}

export interface Vec3 { x: number; y: number; z: number }

export interface Placement { productId: string; position: Vec3; yawDeg: number; reason?: string }

export interface CartItem { productId: string; qty: number; addedAt: number }

export type SessionStatus = 'analyzing' | 'searching' | 'ready' | 'error';

export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  stage: string;
  error?: string;
  prompt: string;
  budget: number | null;
  photos: string[];               // relative URLs (/uploads/..)
  room: RoomAnalysis | null;
  geometry: RoomGeometry | null;
  categories: CategoryResult[];
  cart: CartItem[];
  placements: Placement[];        // last layout the headset reported / received
  voice: { at: number; transcript: string; query: string }[];
}
