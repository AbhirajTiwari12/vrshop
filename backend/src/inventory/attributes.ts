import sharp from 'sharp';
import { BROWSER_UA, fetchBuffer } from '../util/http.js';
import type { ProductAttrs } from '../types.js';

// Canonical filter vocabularies. Listing text is mapped onto these so "onyx", "jet black" and "black" all
// filter the same way, and the voice assistant can only pick values that exist here.

// phrase -> canonical color. Longest phrase wins and consumes its words ("golden brown" is brown, not gold).
const COLOR_PHRASES: Record<string, string> = {
  black: 'black', 'jet black': 'black', onyx: 'black', ebony: 'black', 'black brown': 'brown',
  white: 'white', 'off white': 'white', ivory: 'white', snow: 'white', 'bright white': 'white',
  gray: 'gray', grey: 'gray', charcoal: 'gray', anthracite: 'gray', graphite: 'gray', slate: 'gray', 'dark gray': 'gray', 'light gray': 'gray', 'dark grey': 'gray', 'light grey': 'gray', silver: 'silver', chrome: 'silver', 'stainless steel': 'silver',
  beige: 'beige', cream: 'beige', oatmeal: 'beige', oat: 'beige', sand: 'beige', linen: 'beige', natural: 'beige', taupe: 'beige', khaki: 'beige', ecru: 'beige', greige: 'beige', 'light beige': 'beige',
  brown: 'brown', tan: 'brown', camel: 'brown', cognac: 'brown', chocolate: 'brown', espresso: 'brown', walnut: 'brown', chestnut: 'brown', mocha: 'brown', caramel: 'brown', 'golden brown': 'brown', 'dark brown': 'brown', rust: 'orange', terracotta: 'orange',
  blue: 'blue', navy: 'blue', 'navy blue': 'blue', teal: 'blue', indigo: 'blue', 'sky blue': 'blue', denim: 'blue', turquoise: 'blue', aqua: 'blue', cobalt: 'blue',
  green: 'green', sage: 'green', olive: 'green', emerald: 'green', 'forest green': 'green', mint: 'green', 'dark green': 'green', 'gray green': 'green',
  red: 'red', burgundy: 'red', maroon: 'red', wine: 'red', crimson: 'red', cherry: 'red',
  pink: 'pink', blush: 'pink', rose: 'pink', 'dusty pink': 'pink', coral: 'pink', mauve: 'pink',
  yellow: 'yellow', mustard: 'yellow', ochre: 'yellow', 'dark yellow': 'yellow', lemon: 'yellow',
  orange: 'orange', 'burnt orange': 'orange', amber: 'orange',
  purple: 'purple', lavender: 'purple', lilac: 'purple', violet: 'purple', plum: 'purple',
  gold: 'gold', brass: 'gold', golden: 'gold', 'rose gold': 'gold', bronze: 'gold',
  multicolor: 'multicolor', 'multi color': 'multicolor', multicolored: 'multicolor',
};
export const COLORS = ['black', 'white', 'gray', 'beige', 'brown', 'blue', 'green', 'red', 'pink', 'yellow', 'orange', 'purple', 'gold', 'silver', 'multicolor'];

const MATERIAL_PHRASES: Record<string, string> = {
  leather: 'leather', 'genuine leather': 'leather', 'top grain': 'leather', 'full grain': 'leather', 'top grain leather': 'leather', 'bonded leather': 'leather', grann: 'leather',
  'faux leather': 'faux leather', 'vegan leather': 'faux leather', leatherette: 'faux leather', 'pu leather': 'faux leather', 'coated fabric': 'faux leather', bomstad: 'faux leather', kimstad: 'faux leather',
  velvet: 'velvet', velour: 'velvet', boucle: 'boucle', bouclé: 'boucle', sherpa: 'boucle', teddy: 'boucle',
  linen: 'linen', cotton: 'cotton', wool: 'wool', jute: 'jute', sisal: 'jute', chenille: 'chenille', microfiber: 'microfiber', polyester: 'fabric',
  fabric: 'fabric', upholstered: 'fabric', textile: 'fabric', tweed: 'fabric', corduroy: 'fabric',
  wood: 'wood', wooden: 'wood', 'solid wood': 'wood', oak: 'wood', walnut: 'wood', pine: 'wood', acacia: 'wood', teak: 'wood', mango: 'wood', birch: 'wood', beech: 'wood', ash: 'wood', bamboo: 'wood', rubberwood: 'wood', veneer: 'wood', mdf: 'wood', plywood: 'wood', 'engineered wood': 'wood',
  metal: 'metal', steel: 'metal', iron: 'metal', aluminum: 'metal', aluminium: 'metal', brass: 'metal', chrome: 'metal', 'wrought iron': 'metal',
  glass: 'glass', 'tempered glass': 'glass', marble: 'marble', travertine: 'stone', stone: 'stone', granite: 'stone', terrazzo: 'stone', concrete: 'stone',
  rattan: 'rattan', wicker: 'rattan', cane: 'rattan', seagrass: 'rattan', 'woven': 'rattan',
  plastic: 'plastic', acrylic: 'plastic', polypropylene: 'plastic', resin: 'plastic', ceramic: 'ceramic', porcelain: 'ceramic',
};
export const MATERIALS = ['leather', 'faux leather', 'velvet', 'boucle', 'linen', 'cotton', 'wool', 'jute', 'chenille', 'microfiber', 'fabric', 'wood', 'metal', 'glass', 'marble', 'stone', 'rattan', 'plastic', 'ceramic'];

/** A filter value also matches these more specific materials ("leather" includes faux; "fabric" includes velvet). */
export const MATERIAL_FAMILY: Record<string, string[]> = {
  leather: ['leather', 'faux leather'],
  fabric: ['fabric', 'velvet', 'boucle', 'linen', 'cotton', 'wool', 'chenille', 'microfiber'],
  stone: ['stone', 'marble'],
};

const STYLE_PHRASES: Record<string, string> = {
  modern: 'modern', contemporary: 'modern', 'mid century': 'mid-century', midcentury: 'mid-century', 'mid century modern': 'mid-century', mcm: 'mid-century',
  scandinavian: 'scandinavian', scandi: 'scandinavian', nordic: 'scandinavian', japandi: 'japandi', japanese: 'japandi',
  industrial: 'industrial', farmhouse: 'farmhouse', rustic: 'rustic', boho: 'boho', bohemian: 'boho', coastal: 'coastal', 'beach': 'coastal',
  traditional: 'traditional', classic: 'traditional', transitional: 'traditional', minimalist: 'minimalist', minimal: 'minimalist',
  glam: 'glam', luxe: 'glam', luxury: 'glam', 'art deco': 'glam', vintage: 'vintage', retro: 'vintage',
};
export const STYLES = ['modern', 'mid-century', 'scandinavian', 'japandi', 'industrial', 'farmhouse', 'rustic', 'boho', 'coastal', 'traditional', 'minimalist', 'glam', 'vintage'];

const normText = (s: string) => ` ${s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;

function sortedPhrases(map: Record<string, string>) {
  return Object.keys(map).map((k) => [normText(k).trim(), map[k]] as const).sort((a, b) => b[0].length - a[0].length);
}
const COLOR_LIST = sortedPhrases(COLOR_PHRASES);
const MATERIAL_LIST = sortedPhrases(MATERIAL_PHRASES);
const STYLE_LIST = sortedPhrases(STYLE_PHRASES);

// "walnut legs", "brass hardware", "black metal frame": describes a part, not the product's main color/material.
const PART = /^(?:(?:metal|wood|wooden|finish|finished|tone|toned|colored|color)\s+)?(?:legs?|feet|frame|base|hardware|accents|trim|handles?|knobs?|piping|nailheads?|stitching|buttons?|tufting|casters?)\b/;

function scan(text: string, list: readonly (readonly [string, string])[]): string[] {
  let t = normText(text);
  const out: string[] = [];
  for (const [phrase, canon] of list) {
    const needle = ` ${phrase} `;
    let at = t.indexOf(needle);
    let main = false;
    while (at >= 0) {
      if (!PART.test(t.slice(at + needle.length))) main = true;
      at = t.indexOf(needle, at + 1);
    }
    if (!t.includes(needle)) continue;
    if (main && !out.includes(canon)) out.push(canon);
    t = t.split(needle).join(' | '); // consume so shorter phrases inside it don't match again
  }
  return out;
}

export const extractColors = (text: string) => scan(text, COLOR_LIST);
export const extractMaterials = (text: string) => scan(text, MATERIAL_LIST);
export const extractStyles = (text: string) => scan(text, STYLE_LIST);

/** Colors/materials/styles from the listing text. `extraColors` are store-provided color names (IKEA). */
export function extractAttributes(text: string, extraColors: string[] = []): ProductAttrs {
  const colors = [...new Set([...extraColors.flatMap((c) => extractColors(c)), ...extractColors(text)])];
  // "walnut" and "oak" are both a color and a material; that's fine. Drop "gold" when it only came from "brass" hardware? Keep simple.
  return { colors, materials: extractMaterials(text), styles: extractStyles(text) };
}

/** Map any spoken/typed value onto the canonical vocabulary ("navy" -> "blue", "vegan leather" -> "faux leather"). */
export function canonicalColor(v: string) { return COLORS.includes(v) ? v : extractColors(v)[0]; }
export function canonicalMaterial(v: string) { return MATERIALS.includes(v) ? v : extractMaterials(v)[0]; }
export function canonicalStyle(v: string) { return STYLES.includes(v) ? v : extractStyles(v)[0]; }

// ---------------------------------------------------------------------------------------------
// Color from the product photo (free, used only when the title names no color). Studio shots sit on
// white, so near-white/near-transparent pixels are treated as background and ignored.
// ---------------------------------------------------------------------------------------------

function classifyPixel(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
  const v = max, s = max === 0 ? 0 : (max - min) / max;
  let h = 0;
  if (max !== min) {
    const d = (max - min) * 255;
    if (max * 255 === r) h = ((g - b) / d) % 6;
    else if (max * 255 === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  if (v < 0.18) return 'black';
  if (s < 0.13) return v > 0.86 ? 'white' : 'gray';
  if (h >= 12 && h < 48) {
    if (s < 0.38 && v > 0.62) return 'beige';
    if (v < 0.62 || s < 0.5) return 'brown';
    return h < 35 ? 'orange' : 'yellow';
  }
  if (h >= 48 && h < 70) return s < 0.35 ? 'beige' : 'yellow';
  if (h >= 70 && h < 170) return 'green';
  if (h >= 170 && h < 260) return 'blue';
  if (h >= 260 && h < 295) return 'purple';
  if (h >= 295 && h < 345) return 'pink';
  return v > 0.75 && s < 0.5 ? 'pink' : 'red';
}

export async function colorsFromImage(url: string): Promise<string[]> {
  if (!url) return [];
  try {
    const buf = await fetchBuffer(url, { timeoutMs: 8000, headers: { 'User-Agent': BROWSER_UA, Accept: 'image/avif,image/webp,image/*' } });
    const img = sharp(buf).flatten({ background: '#ffffff' });
    const meta = await img.metadata();
    const w = meta.width ?? 0, h = meta.height ?? 0;
    if (!w || !h) return [];
    // Center 70%: product, not the margins.
    const { data, info } = await img
      .extract({ left: Math.round(w * 0.15), top: Math.round(h * 0.15), width: Math.max(1, Math.round(w * 0.7)), height: Math.max(1, Math.round(h * 0.7)) })
      .resize(32, 32, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const counts = new Map<string, number>();
    let fg = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 232 && g > 232 && b > 232) continue; // background
      fg++;
      const c = classifyPixel(r, g, b);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    if (fg < 60) return []; // almost all background: probably a white product; don't guess
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const out = ranked.filter(([, n], i) => (i === 0 ? n / fg > 0.3 : n / fg > 0.28)).slice(0, 2).map(([c]) => c);
    return out;
  } catch {
    return [];
  }
}
