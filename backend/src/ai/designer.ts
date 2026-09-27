import { config } from '../config.js';
import { CATEGORIES, categoryDef, normalizeCategory } from '../catalog.js';
import { log, errMsg } from '../util/log.js';
import type { Product, Recommendation, RoomAnalysis } from '../types.js';
import { expandTheme } from '../inventory/themes.js';
import { chatJson, hasOpenAI, photoDataUrl, type ChatMessage } from './openai.js';

const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

// ------------------------------------------------------------------------------------------
// 1) Room analysis: photos + user wish -> structured room profile + shopping plan
// ------------------------------------------------------------------------------------------

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;
const obj = (properties: Record<string, object>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: object) => ({ type: 'array', items });

const ROOM_SCHEMA = obj({
  roomType: str,
  summary: str,
  styleTags: arr(str),
  palette: arr(obj({ hex: str, name: str })),
  lighting: obj({ mood: { type: 'string', enum: ['warm', 'neutral', 'cool'] }, brightness: num, kelvin: num }),
  floor: obj({ material: str, colorHex: str }),
  walls: obj({ colorHex: str }),
  existingFurniture: arr(obj({ name: str, category: str, location: str, colorHex: str })),
  freeZones: arr(obj({ description: str, approxWidthM: num, approxDepthM: num })),
  estimatedSizeM: obj({ width: num, depth: num, height: num, confidence: num }),
  recommendations: arr(
    obj({
      category: { type: 'string', enum: CATEGORY_KEYS },
      label: str,
      query: str,
      ikeaQuery: str,
      why: str,
      priority: { type: 'integer' },
      maxWidthM: num,
      maxDepthM: num,
      maxHeightM: num,
      budget: num,
      theme: arr(str),
      anchor: { type: 'string', enum: ['wall', 'corner', 'center', 'window', 'near'] },
      near: str,
    }),
  ),
});

const ROOM_SYSTEM = `You are an expert interior designer and a pragmatic personal shopper.
You look at photos of a real room and plan what to buy so the room matches what the user wants.

Rules:
- Be concrete and visual. Colors as hex. Style tags a shopper would type ("japandi", "mid-century", "warm minimal").
- existingFurniture: what is already in the room, with where it is ("against the left wall", "by the window").
- freeZones: empty floor areas that could take furniture, with honest approximate sizes in meters.
- recommendations: 4-7 items, most impactful first (priority 1 = first). Only categories from the enum.
  Do not recommend a category the room already has unless replacing it is clearly the user's intent.
- query: what a person would type into Google Shopping to find a GOOD match. Plain retail words:
  item type + material + color + 1 style word, e.g. "walnut mid century coffee table", "cream boucle accent chair".
  Never use vague designer jargon ("statement piece", "elevated", "curated").
- ikeaQuery: 1-3 plain words for IKEA's catalog search, e.g. "armchair beige", "floor lamp", "rug wool".
- maxWidthM/maxDepthM/maxHeightM: largest size that fits where it would go (meters).
- budget: suggested spend in USD for that item; the total should respect the user's budget if one is given.
- anchor: where it goes (wall, corner, center, window, near) and near: which existing thing it goes near ("" if none).
- lighting.brightness 0..1, lighting.kelvin e.g. 2700 warm .. 6500 cool.
- estimatedSizeM: rough room size from the photos with confidence 0..1 (the headset measures the real size later).
- theme: when the user asks for a motif, character or franchise (race cars / Disney Cars, dinosaurs, outer space, unicorns,
  a sports team...), give the items that should visibly carry it (typically the bed, rug, wall art, a lamp, toy storage)
  2-5 words a matching product would have in its title, most specific first, e.g. ["lightning mcqueen", "disney cars",
  "race car", "racing"]. Use unambiguous terms ("outer space", "rocket", "astronaut", not "space" which matches "space
  saving"). Put the theme words in that item's query too ("race car twin bed kids"). Items that stay plain (dresser,
  bookshelf) and rooms without a theme get []. Styles like "modern" or "cozy" are not themes.
- A themed child's room feels complete with: the bed, a rug, wall art, a table lamp (category table_lamp; it stands on
  the kids table or a nightstand) and a kids table and chairs set (category dining_table), all carrying the theme;
  storage (dresser, bookshelf, toy box) can stay plain.`;

export async function analyzeRoom(photoPaths: string[], wish: string, budget: number | null): Promise<RoomAnalysis> {
  if (!hasOpenAI()) return heuristicAnalysis(wish, budget);
  try {
    const images = await Promise.all(photoPaths.slice(0, 8).map((p) => photoDataUrl(p)));
    const userText = [
      wish ? `What I want: ${wish}` : 'What I want: make this room look great and feel finished.',
      budget ? `Total budget: $${budget}` : 'No fixed budget; keep it reasonable.',
      images.length ? `${images.length} photo(s) of my room follow.` : 'I have no photos; assume a typical room matching my description.',
    ].join('\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: ROOM_SYSTEM },
      { role: 'user', content: [{ type: 'text', text: userText }, ...images.map((url) => ({ type: 'image_url' as const, image_url: { url, detail: 'high' as const } }))] },
    ];
    const r = await chatJson<any>({ model: config.openai.visionModel, messages, schemaName: 'room_analysis', schema: ROOM_SCHEMA, effort: 'low', timeoutMs: 120000 });
    return {
      roomType: r.roomType,
      summary: r.summary,
      styleTags: r.styleTags ?? [],
      palette: (r.palette ?? []).slice(0, 6),
      lighting: r.lighting,
      floor: r.floor,
      walls: r.walls,
      existingFurniture: r.existingFurniture ?? [],
      freeZones: r.freeZones ?? [],
      estimatedSizeM: r.estimatedSizeM,
      recommendations: (r.recommendations ?? []).map(
        (x: any): Recommendation & { ikeaQuery: string } => ({
          category: normalizeCategory(x.category),
          label: x.label || categoryDef(x.category).label,
          query: x.query,
          ikeaQuery: x.ikeaQuery || categoryDef(x.category).label,
          why: x.why,
          priority: x.priority,
          maxDims: x.maxWidthM > 0 ? { w: x.maxWidthM, d: x.maxDepthM, h: x.maxHeightM } : undefined,
          budget: x.budget > 0 ? x.budget : undefined,
          theme: expandTheme(themeTerms(x.theme)),
          placement: { anchor: x.anchor, near: x.near || undefined },
        }),
      ).sort((a: Recommendation, b: Recommendation) => a.priority - b.priority),
      source: 'openai',
    };
  } catch (e) {
    log.error('designer', `room analysis failed, using heuristic: ${errMsg(e)}`);
    return heuristicAnalysis(wish, budget);
  }
}

/** Clean theme words from the model: lowercase, 2-40 chars, at most 5; undefined when there's no theme. */
function themeTerms(v: unknown): string[] | undefined {
  const t = Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim().toLowerCase()).filter((x) => x.length > 1 && x.length < 40))].slice(0, 5) : [];
  return t.length ? t : undefined;
}

// ------------------------------------------------------------------------------------------
// 2) Ranking: pick the listings that best fit the room (uses thumbnails at low detail)
// ------------------------------------------------------------------------------------------

const RANK_SCHEMA = obj({ ranked: arr(obj({ id: str, score: num, why: str })) });

export async function rankProducts(room: RoomAnalysis, rec: { label: string; why: string; budget?: number; maxDims?: { w: number; d: number; h: number } }, products: Product[], keep = 8): Promise<Product[]> {
  if (products.length === 0) return [];
  if (!hasOpenAI()) return heuristicRank(products, rec.budget).slice(0, keep);
  try {
    const list = products.slice(0, 20);
    const lines = list.map((p, i) => `#${i} id=${p.id} | ${p.store} | ${p.priceText || 'price n/a'} | ${p.title}${p.dims ? ` | ${p.dims.w}x${p.dims.d}x${p.dims.h} m` : ''}${p.rating ? ` | ${p.rating}★ (${p.reviews ?? 0})` : ''}`);
    const content: any[] = [
      {
        type: 'text',
        text: `Room: ${room.summary}\nStyle: ${room.styleTags.join(', ')}\nPalette: ${room.palette.map((c) => `${c.name} ${c.hex}`).join(', ')}\n` +
          `We need: ${rec.label} — ${rec.why}${rec.budget ? `\nTarget price: about $${rec.budget}` : ''}${rec.maxDims ? `\nMust fit within ${rec.maxDims.w}x${rec.maxDims.d}x${rec.maxDims.h} m (W x D x H)` : ''}\n\n` +
          `Candidates (thumbnail images follow in the same order):\n${lines.join('\n')}\n\n` +
          `Return the best ${Math.min(keep, list.length)} candidates, best first. Score 0..1 for how well each fits the room's style, colors, size and budget. ` +
          `Drop items that are clearly the wrong product type, accessories, or parts. "why" is max 12 words, specific to this room.`,
      },
      ...list.map((p) => ({ type: 'image_url', image_url: { url: p.imageUrl, detail: 'low' } })),
    ];
    const r = await chatJson<{ ranked: { id: string; score: number; why: string }[] }>({
      messages: [{ role: 'system', content: 'You are a precise furniture shopping assistant. Output only valid JSON.' }, { role: 'user', content }],
      schemaName: 'product_ranking',
      schema: RANK_SCHEMA,
      effort: 'none',
    });
    const byId = new Map(list.map((p) => [p.id, p]));
    const out: Product[] = [];
    for (const x of r.ranked) {
      const p = byId.get(x.id);
      if (p && !out.includes(p)) { p.fitScore = x.score; p.why = x.why; out.push(p); }
    }
    return out.length ? out.slice(0, keep) : heuristicRank(products, rec.budget).slice(0, keep);
  } catch (e) {
    log.warn('designer', `ranking failed, heuristic: ${errMsg(e)}`);
    return heuristicRank(products, rec.budget).slice(0, keep);
  }
}

function heuristicRank(products: Product[], budget?: number): Product[] {
  const score = (p: Product) => {
    let s = 0.5;
    if (p.rating) s += (p.rating - 3.5) * 0.15;
    if (p.reviews) s += Math.min(0.15, Math.log10(p.reviews + 1) * 0.05);
    if (budget && p.price) s -= Math.max(0, (p.price - budget) / budget) * 0.4;
    if (p.source === 'ikea') s += 0.05; // true 3D model available more often
    return s;
  };
  return [...products].sort((a, b) => score(b) - score(a)).map((p) => ({ ...p, fitScore: Math.max(0, Math.min(1, score(p))) }));
}

// ------------------------------------------------------------------------------------------
// 3) Voice: "find me a tall lamp for this corner under 100 bucks" -> search intent
// ------------------------------------------------------------------------------------------

const VOICE_SCHEMA = obj({
  category: { type: 'string', enum: [...CATEGORY_KEYS, 'none'] },
  label: str,
  query: str,
  ikeaQuery: str,
  maxPrice: num,
  wantsPlacementAtPointer: { type: 'boolean' },
  reply: str,
});

export interface VoiceIntent { category: string; label: string; query: string; ikeaQuery: string; maxPrice: number | null; atPointer: boolean; reply: string }

export async function voiceIntent(transcript: string, room: RoomAnalysis | null): Promise<VoiceIntent> {
  if (!hasOpenAI()) {
    const category = normalizeCategory(transcript);
    const def = categoryDef(category);
    const price = transcript.match(/\$\s*(\d{2,5})|(\d{2,5})\s*(?:dollars|bucks|usd)|under\s+\$?(\d{2,5})/i);
    return { category, label: def.label, query: transcript, ikeaQuery: def.label, maxPrice: price ? Number(price[1] ?? price[2] ?? price[3]) : null, atPointer: /here|this|there/i.test(transcript), reply: `Looking for ${def.label.toLowerCase()}s.` };
  }
  const r = await chatJson<any>({
    messages: [
      {
        role: 'system',
        content: 'Turn a spoken furniture request into a shopping search. The user is standing in their room in VR and may point at a spot. ' +
          'query = retailer-friendly Google Shopping query (item + material/color + style). ikeaQuery = 1-3 plain words. maxPrice = 0 if not stated. ' +
          'wantsPlacementAtPointer = true if they refer to a place ("here", "this corner", "next to the couch"). reply = one short friendly sentence (max 12 words) confirming what you are searching for.',
      },
      { role: 'user', content: `${room ? `Room style: ${room.styleTags.join(', ')}; palette: ${room.palette.map((c) => c.name).join(', ')}.\n` : ''}They said: "${transcript}"` },
    ],
    schemaName: 'voice_intent',
    schema: VOICE_SCHEMA,
    effort: 'none',
  });
  const category = r.category === 'none' ? normalizeCategory(r.query) : r.category;
  return { category, label: r.label || categoryDef(category).label, query: r.query, ikeaQuery: r.ikeaQuery || categoryDef(category).label, maxPrice: r.maxPrice > 0 ? r.maxPrice : null, atPointer: !!r.wantsPlacementAtPointer, reply: r.reply };
}

// ------------------------------------------------------------------------------------------
// Heuristic fallback when no OpenAI key is configured (keeps the whole demo flow working)
// ------------------------------------------------------------------------------------------

const STYLE_WORDS = ['scandinavian', 'japandi', 'mid-century', 'modern', 'minimal', 'industrial', 'boho', 'coastal', 'rustic', 'farmhouse', 'cozy', 'luxury', 'contemporary', 'traditional'];

export function heuristicAnalysis(wish: string, budget: number | null): RoomAnalysis {
  const w = wish.toLowerCase();
  const roomType = /bed(room)?/.test(w) ? 'bedroom' : /office|study|work/.test(w) ? 'home office' : /dining/.test(w) ? 'dining room' : 'living room';
  const styles = STYLE_WORDS.filter((s) => w.includes(s));
  const style = styles[0] ?? 'modern';
  const warm = /warm|cozy|wood|earth/.test(w);
  const plan: Record<string, [string, string, string][]> = {
    'living room': [['sofa', `${style} 3 seat sofa`, 'sofa'], ['coffee_table', `${style} wood coffee table`, 'coffee table'], ['rug', `${style} area rug 5x8`, 'rug'], ['floor_lamp', `${style} floor lamp`, 'floor lamp'], ['armchair', `${style} accent chair`, 'armchair'], ['plant', 'large artificial plant', 'artificial plant']],
    bedroom: [['bed', `${style} queen bed frame`, 'bed frame'], ['nightstand', `${style} nightstand`, 'nightstand'], ['rug', `${style} bedroom rug`, 'rug'], ['table_lamp', `${style} bedside lamp`, 'table lamp'], ['dresser', `${style} dresser`, 'chest of drawers']],
    'home office': [['desk', `${style} desk`, 'desk'], ['office_chair', 'ergonomic office chair', 'office chair'], ['bookshelf', `${style} bookshelf`, 'bookcase'], ['floor_lamp', `${style} floor lamp`, 'floor lamp'], ['plant', 'artificial plant', 'artificial plant']],
    'dining room': [['dining_table', `${style} dining table`, 'dining table'], ['dining_chair', `${style} dining chair`, 'dining chair'], ['rug', `${style} dining rug`, 'rug'], ['cabinet', `${style} sideboard`, 'sideboard']],
  };
  const items = plan[roomType];
  const per = budget ? Math.round(budget / items.length) : undefined;
  return {
    roomType,
    summary: `A ${roomType} to be furnished in a ${style} style${wish ? ` (${wish})` : ''}.`,
    styleTags: styles.length ? styles : [style],
    palette: warm
      ? [{ hex: '#E8DCCB', name: 'oat' }, { hex: '#A0785A', name: 'walnut' }, { hex: '#5B6B4E', name: 'olive' }, { hex: '#2F2A26', name: 'espresso' }]
      : [{ hex: '#F2F1EE', name: 'warm white' }, { hex: '#BFC5C9', name: 'light gray' }, { hex: '#6D7A86', name: 'slate' }, { hex: '#C8A27A', name: 'light oak' }],
    lighting: { mood: warm ? 'warm' : 'neutral', brightness: 0.6, kelvin: warm ? 3000 : 4000 },
    floor: { material: 'wood', colorHex: '#B08D6A' },
    walls: { colorHex: '#EDEAE4' },
    existingFurniture: [],
    freeZones: [{ description: 'open floor in the middle of the room', approxWidthM: 3, approxDepthM: 2.5 }],
    estimatedSizeM: { width: 4, depth: 4.5, height: 2.5, confidence: 0.2 },
    recommendations: items.map(([category, query, ikeaQuery], i): Recommendation & { ikeaQuery: string } => ({
      category,
      label: categoryDef(category).label,
      query,
      ikeaQuery,
      why: `A ${style} ${categoryDef(category).label.toLowerCase()} anchors the ${roomType}.`,
      priority: i + 1,
      budget: per,
      placement: { anchor: categoryDef(category).anchor },
    })),
    source: 'heuristic',
  };
}
