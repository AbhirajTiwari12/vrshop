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
  colors?: string[];              // hex swatches (IKEA)
  attrs?: ProductAttrs;            // normalized filter attributes (see inventory/attributes.ts)
  description?: string;            // extra searchable text: product type, snippet, image alt text
  why?: string;                    // AI: why this fits the room
  fitScore?: number;               // 0..1 from ranking
  model: ModelInfo;
  // provider-specific bits
  ikeaItemNo?: string;
  genImages?: string[];            // curated photos for image-to-3D (clean product shots, best first; up to 5)
  genModel?: string;               // fal model for this product's generation (rodin | trellis2 | hunyuan)
  officialModel?: boolean;         // IKEA publishes a 3D model for it (undefined = not checked yet)
  serpImmersiveToken?: string;
}

export interface ProductAttrs {
  colors: string[];                // canonical color names: black, white, gray, beige, brown, ...
  materials: string[];             // canonical: leather, velvet, wood, metal, ...
  styles: string[];                // canonical: modern, mid-century, scandinavian, ...
  colorFromImage?: boolean;        // colors guessed from the product photo (title had none)
}

/** Browse / filter state. Every field is optional; empty means "any". */
export interface Filters {
  category?: string;               // category key from catalog.ts
  keywords?: string[];             // concrete features that must appear in the listing ("sleeper", "round")
  theme?: string[];                // a motif the product itself must show; any one term matches ("race car", "lightning mcqueen")
  colors?: string[];
  materials?: string[];
  styles?: string[];               // soft: boosts ranking, never excludes
  stores?: string[];
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  maxWidthM?: number;
  maxDepthM?: number;
  maxHeightM?: number;
  only3d?: boolean;                // only products with a confirmed official (IKEA) 3D model
  sort?: 'relevance' | 'price_asc' | 'price_desc' | 'rating';
}

export interface Facet { value: string; count: number }

export interface BrowseResult {
  filters: Filters;
  productIds: string[];            // first page(s) of matches, best first
  total: number;                   // total matches in the catalog
  priceRange: { min: number; max: number; median: number } | null;
  facets: { categories: Facet[]; colors: Facet[]; materials: Facet[]; stores: Facet[] };
  liveSearched?: string;           // query sent to live stores because the catalog had too few matches
  updatedAt: number;
}

// ------------------------------------------------------------------ agentic checkout (Visa)

/**
 * The shopper's one-time approval for the agent to buy the room: a spending mandate modelled on Visa Intelligent
 * Commerce's payment instruction (total cap = room budget, per-merchant caps, item list, expiry).
 */
export interface Mandate {
  id: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  status: 'active' | 'completed' | 'expired' | 'revoked';
  currency: string;
  totalCap: number;                     // declineThreshold: the agent can never spend more than this
  spent: number;
  merchants: { store: string; cap: number; items: { productId: string; title: string; qty: number; unitPrice: number }[] }[];
  approval: { via: 'headset' | 'phone' | 'voice'; at: number; text: string };
  card: { brand: 'Visa'; last4: string; label: string };
}

export interface OrderStep { at: number; label: string; ok: boolean; detail?: string }

export interface Order {
  id: string;
  mandateId: string;
  store: string;
  items: { productId: string; title: string; qty: number; unitPrice: number }[];
  amount: number;
  currency: string;
  status: 'pending' | 'authorized' | 'declined' | 'rejected' | 'error' | 'voided';
  steps: OrderStep[];
  tap?: { keyId: string; nonce: string; tag: string; verified: boolean; reason?: string };
  payment?: {
    provider: 'visa_acceptance' | 'simulated';
    id?: string;                        // Visa Acceptance transaction id
    status?: string;                    // AUTHORIZED | DECLINED | ...
    approvalCode?: string;
    reconciliationId?: string;
    reversalId?: string;
    message?: string;
  };
  merchantOrderId?: string;
  createdAt: number;
}

export interface SplitLink { id: string; createdAt: number; to: string; amount: number; url: string; provider: 'visa_acceptance' | 'simulated'; note?: string }

export interface Checkout {
  status: 'running' | 'done' | 'partial' | 'failed';
  mandate: Mandate;
  orders: Order[];
  summary?: string;
}

export interface ChatTurn { role: 'user' | 'assistant'; text: string; at: number; via?: 'voice' | 'text' }

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
  theme?: string[];                // this item should carry the room's theme ("race car", "cars"): products must show it
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
  theme?: string[];                // set when these products carry a theme (found in stores if the catalog had none)
}

/** Room geometry reported by the Quest (from MRUK / Space Setup). Unity world space, meters, Y-up. */
export interface RoomGeometry {
  floorY: number;
  ceilingHeight: number;
  floorPolygon: { x: number; z: number }[];
  walls: { center: Vec3; normal: Vec3; width: number; height: number }[];
  objects: RoomObject[];
  user?: { position: Vec3; forward: Vec3 };
}

export interface Vec3 { x: number; y: number; z: number }

/** A Space Setup box (furniture) or plane (door / window). `id` is the headset's anchor id, stable across sessions. */
export interface RoomObject { id?: string; label: string; center: Vec3; size: Vec3; yawDeg: number }

/**
 * One piece of the user's real furniture (a Space Setup box) and what they want to do with it. Kept pieces are solid:
 * new furniture never overlaps them. Replaced pieces are painted out in the headset and a product stands in their spot.
 */
export interface RealPiece {
  id: string;                      // Space Setup anchor id (RoomObject.id)
  label: string;                   // COUCH, TABLE, STORAGE, BED, LAMP, PLANT, SCREEN, OTHER
  category: string | null;         // our furniture type for it (null = unknown until the user picks one)
  categorySource: 'auto' | 'user';
  choices: string[];               // furniture types that make sense for this label (type picker)
  state: 'keep' | 'replace';
  replacementId?: string;          // product currently standing in for it
  updatedAt: number;
}

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
  browse?: BrowseResult;          // current catalog filter + results (voice or manual)
  chat?: ChatTurn[];              // conversation with the shopping assistant (last ~20 turns)
  checkout?: Checkout;            // latest agentic checkout ("buy the room")
  splits?: SplitLink[];           // Visa Pay by Link requests sent to roommates
  pastCheckouts?: Checkout[];
  realFurniture?: Record<string, RealPiece>; // the user's real furniture by Space Setup anchor id (keep / replace)
}
