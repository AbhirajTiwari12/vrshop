import type { Dims, Recommendation } from './types.js';

// Normalized furniture categories. `shape` drives the procedural stand-in model,
// `mount` tells the headset how the item attaches to the room.
export interface CategoryDef {
  key: string;
  label: string;
  dims: Dims;                 // typical real-world size (m) when the listing has none
  shape: 'sofa' | 'chair' | 'table' | 'lamp' | 'rug' | 'shelf' | 'bed' | 'plant' | 'panel' | 'box' | 'cylinder';
  mount: 'floor' | 'wall';
  anchor: Recommendation['placement']['anchor'];
  keywords: string[];         // used to map free text to this category
}

export const CATEGORIES: CategoryDef[] = [
  { key: 'sofa', label: 'Sofa', dims: { w: 2.1, d: 0.9, h: 0.85 }, shape: 'sofa', mount: 'floor', anchor: 'wall', keywords: ['sofa', 'couch', 'sectional', 'loveseat', 'settee', 'sofa bed', 'futon', 'chesterfield'] },
  { key: 'armchair', label: 'Accent chair', dims: { w: 0.8, d: 0.85, h: 0.9 }, shape: 'chair', mount: 'floor', anchor: 'corner', keywords: ['armchair', 'accent chair', 'lounge chair', 'reading chair', 'recliner', 'club chair', 'wing chair', 'swivel chair', 'rocking chair', 'barrel chair', 'slipper chair', 'chair and a half', 'easy chair', 'kids chair', 'toddler chair', 'kids armchair', 'kids recliner', 'bean bag', 'bean bag chair', 'kids sofa', 'flip open sofa'] },
  { key: 'coffee_table', label: 'Coffee table', dims: { w: 1.1, d: 0.6, h: 0.45 }, shape: 'table', mount: 'floor', anchor: 'center', keywords: ['coffee table', 'cocktail table'] },
  { key: 'side_table', label: 'Side table', dims: { w: 0.5, d: 0.5, h: 0.55 }, shape: 'table', mount: 'floor', anchor: 'near', keywords: ['side table', 'end table', 'accent table', 'nesting tables', 'nesting table', 'c table', 'console table'] },
  { key: 'rug', label: 'Rug', dims: { w: 2.0, d: 1.4, h: 0.01 }, shape: 'rug', mount: 'floor', anchor: 'center', keywords: ['rug', 'carpet', 'area rug'] },
  { key: 'floor_lamp', label: 'Floor lamp', dims: { w: 0.4, d: 0.4, h: 1.6 }, shape: 'lamp', mount: 'floor', anchor: 'corner', keywords: ['floor lamp', 'arc lamp', 'torchiere', 'floor uplighter', 'standing lamp'] },
  { key: 'table_lamp', label: 'Table lamp', dims: { w: 0.3, d: 0.3, h: 0.5 }, shape: 'lamp', mount: 'floor', anchor: 'near', keywords: ['table lamp', 'desk lamp', 'bedside lamp'] },
  { key: 'bookshelf', label: 'Bookshelf', dims: { w: 0.8, d: 0.3, h: 1.8 }, shape: 'shelf', mount: 'floor', anchor: 'wall', keywords: ['bookshelf', 'bookcase', 'shelving', 'shelf unit', 'shelving unit', 'etagere', 'ladder shelf'] },
  { key: 'tv_stand', label: 'TV stand', dims: { w: 1.6, d: 0.4, h: 0.5 }, shape: 'box', mount: 'floor', anchor: 'wall', keywords: ['tv stand', 'tv bench', 'media console', 'tv unit', 'entertainment center'] },
  { key: 'dining_table', label: 'Dining table', dims: { w: 1.6, d: 0.9, h: 0.75 }, shape: 'table', mount: 'floor', anchor: 'center', keywords: ['dining table', 'kitchen table', 'dining set', 'table and 2 chairs', 'table and 4 chairs', 'table and 6 chairs', 'table and 4 armchairs', 'table and 2 benches', 'table and chair set', 'table and chairs set', 'table & chair set', 'table and chairs', 'activity table', 'play table'] },
  { key: 'dining_chair', label: 'Dining chair', dims: { w: 0.45, d: 0.5, h: 0.85 }, shape: 'chair', mount: 'floor', anchor: 'near', keywords: ['dining chair', 'kitchen chair'] },
  { key: 'desk', label: 'Desk', dims: { w: 1.2, d: 0.6, h: 0.75 }, shape: 'table', mount: 'floor', anchor: 'wall', keywords: ['desk', 'writing desk', 'computer desk', 'workstation', 'standing desk'] },
  { key: 'office_chair', label: 'Desk chair', dims: { w: 0.65, d: 0.65, h: 1.1 }, shape: 'chair', mount: 'floor', anchor: 'near', keywords: ['office chair', 'desk chair', 'task chair', 'gaming chair'] },
  { key: 'bed', label: 'Bed', dims: { w: 1.6, d: 2.1, h: 1.0 }, shape: 'bed', mount: 'floor', anchor: 'wall', keywords: ['bed', 'bed frame', 'platform bed', 'daybed', 'upholstered bed', 'canopy bed'] },
  { key: 'nightstand', label: 'Nightstand', dims: { w: 0.45, d: 0.4, h: 0.55 }, shape: 'box', mount: 'floor', anchor: 'near', keywords: ['nightstand', 'bedside table', 'night stand'] },
  { key: 'dresser', label: 'Dresser', dims: { w: 1.2, d: 0.5, h: 0.8 }, shape: 'box', mount: 'floor', anchor: 'wall', keywords: ['dresser', 'chest of drawers', 'sideboard', 'credenza', 'buffet'] },
  { key: 'cabinet', label: 'Cabinet', dims: { w: 0.8, d: 0.4, h: 1.0 }, shape: 'box', mount: 'floor', anchor: 'wall', keywords: ['cabinet', 'storage cabinet', 'wardrobe', 'armoire', 'display cabinet', 'toy box', 'toy chest', 'toy organizer', 'toy storage'] },
  { key: 'ottoman', label: 'Ottoman / pouf', dims: { w: 0.6, d: 0.6, h: 0.45 }, shape: 'cylinder', mount: 'floor', anchor: 'near', keywords: ['ottoman', 'pouf', 'footstool', 'footrest'] },
  { key: 'bench', label: 'Bench', dims: { w: 1.2, d: 0.4, h: 0.45 }, shape: 'box', mount: 'floor', anchor: 'wall', keywords: ['bench'] },
  { key: 'plant', label: 'Plant', dims: { w: 0.5, d: 0.5, h: 1.2 }, shape: 'plant', mount: 'floor', anchor: 'corner', keywords: ['plant', 'artificial plant', 'potted plant', 'faux plant', 'artificial tree', 'fiddle leaf', 'olive tree'] },
  { key: 'wall_art', label: 'Wall art', dims: { w: 0.8, d: 0.03, h: 0.6 }, shape: 'panel', mount: 'wall', anchor: 'wall', keywords: ['wall art', 'poster', 'print', 'painting', 'canvas', 'frame', 'picture'] },
  { key: 'mirror', label: 'Mirror', dims: { w: 0.6, d: 0.03, h: 1.5 }, shape: 'panel', mount: 'wall', anchor: 'wall', keywords: ['mirror'] },
];

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

export function categoryDef(key: string): CategoryDef {
  return BY_KEY.get(key) ?? { key, label: titleCase(key.replace(/_/g, ' ')), dims: { w: 0.6, d: 0.6, h: 0.6 }, shape: 'box', mount: 'floor', anchor: 'near', keywords: [key] };
}

/** Map free text ("mid-century accent chair") to a category key. Longest keyword match wins. */
export function normalizeCategory(text: string): string {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  if (BY_KEY.has(text.trim().toLowerCase())) return text.trim().toLowerCase();
  let best: { key: string; len: number } | null = null;
  for (const c of CATEGORIES) {
    for (const k of c.keywords) {
      if (t.includes(` ${k} `) || t.includes(` ${k}s `)) {
        if (!best || k.length > best.len) best = { key: c.key, len: k.length };
      }
    }
  }
  return best?.key ?? text.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 30);
}

/** Like normalizeCategory, but only returns one of our known category keys (or null). */
export function matchCategory(text: string): string | null {
  const key = normalizeCategory(text);
  return BY_KEY.has(key) ? key : null;
}

/** Plural display label: "Sofas", "Accent chairs", "Ottomans / poufs". */
export function pluralLabel(key: string): string {
  const label = categoryDef(key).label;
  return label.split(' / ').map((w) => (/lf$/i.test(w) ? `${w.slice(0, -1)}ves` : /(s|sh|ch)$/i.test(w) ? `${w}es` : /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`)).join(' / ');
}

// Parts and accessories that product searches return alongside the real thing ("Cover for loveseat", "Sofa legs",
// "Lamp shade"). A trailing "with removable cushion covers" is NOT an accessory, so only look at the head of the title.
const ACC = '(covers?|cvr|slipcovers?|cushions?|pads?|legs?|feet|protectors?|trays?|armrests?|sections?|shades?|inserts?|replacement|parts?|kits?|bulbs?|glides?|risers?|hardware|brackets?|hooks?|knobs?|handles?|casters?|sheets?|duvets?|pillowcases?|bedspreads?|mattress(?:es)?|slats?|slatted bed base|headboards?|stand for|lint brush)';
const ACC_START = new RegExp(`^\\s*(?:[\\w-]+\\s+){0,2}${ACC}\\b`, 'i');     // "Cover for ...", "Stretch sofa cover"
const ACC_FOR = new RegExp(`\\b${ACC}\\s+(?:for|to fit)\\b`, 'i');             // "... cushion for sofa"
// Things store searches return that aren't furniture at all (looked for in the head of the title / IKEA type name).
const NOT_FURNITURE = /\b(plush(ies)?|pillow ?buddy|pillowbuddy|soft pals|beanbag covers?|bean bag covers?|toy cars?|towels?|door ?mats?|bath mats?|place ?mats?|tablecloths?|oven mitts?|throws?|throw blankets?|duvets?|pillowcases?|clocks?|glass doors?|sliding doors?|mirror doors?|ledges?|holders?|laptop supports?|underframes?|table ?tops?|add-on units?|seat shells?|bases?|glass tops?|bouquets?|wreaths?|garlands?|artificial flowers?|flowers?|christmas|sprays?|plant pots?|plant stands?|lamp stands?|laptop stands?|monitor stands?|pockets?)\b/i;
const OUTDOOR = /\b(outdoor|patio)\b/i;
const IN_OUTDOOR = /\b(in ?\/ ?outdoor|indoor ?\/ ?outdoor|indoor (?:and|or|&) outdoor)\b/i;

export function isAccessory(title: string, category?: string): boolean {
  // This app furnishes an indoor room: skip patio furniture (but keep "indoor/outdoor" rugs).
  if (OUTDOOR.test(title) && !IN_OUTDOOR.test(title)) return true;
  const head = title.split(/,|\bwith\b|\bw\/|\||-\s/i)[0];
  if (NOT_FURNITURE.test(head)) return true;
  if (category === 'rug' || category === 'wall_art' || category === 'mirror') return /\b(rug pad|gripper|hanging kit|hooks?)\b/i.test(title);
  if (ACC_START.test(head) || ACC_FOR.test(head)) return true;
  // "<item> cover", "<item> legs": accessory word right after the category keyword in the head of the title.
  if (category) {
    for (const k of categoryDef(category).keywords) {
      if (new RegExp(`\\b${k}s?\\s+${ACC}\\b`, 'i').test(head)) return true;
    }
  }
  return false;
}

export const titleCase = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());

// ---------------------------------------------------------------------------------------------
// Dimension parsing: '84"W x 35"D x 33"H', 'Overall: 33'' H x 84'' W', '213 x 89 x 84 cm', '26 3/4"'
// ---------------------------------------------------------------------------------------------
const FRACTIONS: Record<string, number> = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };

function parseNumber(raw: string): number | null {
  let s = raw.trim();
  let extra = 0;
  for (const [f, v] of Object.entries(FRACTIONS)) {
    if (s.includes(f)) { extra += v; s = s.replace(f, ' '); }
  }
  const frac = s.match(/(\d+)\s*\/\s*(\d+)/);
  if (frac) { extra += Number(frac[1]) / Number(frac[2]); s = s.replace(frac[0], ' '); }
  const n = s.match(/\d+(?:[.,]\d+)?/);
  if (!n && !extra) return null;
  return (n ? Number(n[0].replace(',', '.')) : 0) + extra;
}

const UNIT_TO_M: Record<string, number> = { cm: 0.01, mm: 0.001, m: 1, in: 0.0254, '"': 0.0254, "''": 0.0254, inch: 0.0254, inches: 0.0254, ft: 0.3048, "'": 0.3048, feet: 0.3048 };

export function parseDims(text: string): Dims | null {
  if (!text) return null;
  const t = text.replace(/[”″]/g, '"').replace(/[’′]/g, "'").replace(/×/g, 'x');
  // Unit hint for the whole string
  const unitHint = /\bcm\b/i.test(t) ? 'cm' : /\bmm\b/i.test(t) ? 'mm' : /("|''|\binch|\bin\b)/i.test(t) ? 'in' : /\bft\b|feet/i.test(t) ? 'ft' : null;

  // 1) Labelled axes: 84"W, W 84", Width: 84 in
  const labelled: Partial<Record<'w' | 'd' | 'h' | 'l', number>> = {};
  const re = /(?:(width|depth|height|length|w|d|h|l)\s*[:=]?\s*)?(\d+(?:[.,]\d+)?(?:\s+\d+\s*\/\s*\d+)?[¼½¾⅛⅜⅝⅞]?)\s*(cm|mm|m|in(?:ch(?:es)?)?|ft|feet|"|''|')?\s*(width|depth|height|length|w|d|h|l)?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const axisWord = (m[1] || m[4] || '').toLowerCase();
    if (!axisWord) continue;
    const axis = axisWord[0] as 'w' | 'd' | 'h' | 'l';
    const n = parseNumber(m[2]);
    if (n == null) continue;
    const unit = (m[3] || unitHint || 'in').toLowerCase().replace(/^inch(es)?$/, 'in');
    const f = UNIT_TO_M[unit] ?? 0.0254;
    if (labelled[axis] == null) labelled[axis] = n * f;
  }
  const lw = labelled.w ?? labelled.l;
  if (lw && labelled.h && (labelled.d || labelled.l)) {
    const d = labelled.d ?? (labelled.w ? labelled.l : undefined);
    if (d) return sane({ w: lw, d, h: labelled.h });
  }

  // 2) Unlabelled triple: 213 x 89 x 84 cm  (assume W x D x H for furniture)
  const tri = t.match(/(\d+(?:[.,]\d+)?)\s*(?:cm|"|in)?\s*x\s*(\d+(?:[.,]\d+)?)\s*(?:cm|"|in)?\s*x\s*(\d+(?:[.,]\d+)?)\s*(cm|mm|m|in|inches|"|ft)?/i);
  if (tri) {
    const unit = (tri[4] || unitHint || 'in').toLowerCase().replace(/^inches$/, 'in');
    const f = UNIT_TO_M[unit] ?? 0.0254;
    return sane({ w: Number(tri[1].replace(',', '.')) * f, d: Number(tri[2].replace(',', '.')) * f, h: Number(tri[3].replace(',', '.')) * f });
  }
  return null;
}

function sane(d: Dims): Dims | null {
  const ok = [d.w, d.d, d.h].every((v) => Number.isFinite(v) && v > 0.005 && v < 6);
  return ok ? { w: round3(d.w), d: round3(d.d), h: round3(d.h) } : null;
}

export const round3 = (v: number) => Math.round(v * 1000) / 1000;
