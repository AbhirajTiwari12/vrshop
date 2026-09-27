import type { Product } from '../types.js';

// Design styles for "Design my room in a ___ style". Each profile steers product choice twice: a free heuristic
// score over the catalog (colors, materials, title words, IKEA ranges known to fit) that picks the candidates,
// and a brief the designer model uses to choose one coherent set from them.

export interface StyleProfile {
  key: string;
  label: string;
  blurb: string;              // one line under the style card in the headset
  brief: string;              // what the designer model should aim for
  colors: string[];           // canonical colors (inventory/attributes.ts) that suit the style
  avoidColors: string[];
  materials: string[];
  avoidMaterials: string[];
  words: string[];            // title words that signal the style
  avoidWords: string[];
  ranges: string[];           // IKEA range names that read as this style
  swatches: string[];         // three hex colors for the style card
  synonyms: string[];         // how people say it
}

export const STYLE_PROFILES: StyleProfile[] = [
  {
    key: 'modern', label: 'Modern', blurb: 'Clean lines, soft neutrals, a little metal',
    brief: 'Contemporary and uncluttered: low clean-lined upholstery in gray, white or black, simple wood or metal tables, one or two graphic accents.',
    colors: ['gray', 'white', 'black', 'beige'], avoidColors: ['multicolor'], materials: ['metal', 'glass', 'fabric', 'leather'], avoidMaterials: ['rattan'],
    words: ['modern', 'contemporary', 'sleek', 'glass', 'chrome', 'low'], avoidWords: ['rustic', 'ornate', 'antique', 'distressed'],
    ranges: ['KIVIK', 'VIMLE', 'SÖDERHAMN', 'FRIHETEN', 'LACK', 'BESTÅ', 'GLADOM', 'LISTERBY', 'JÄTTEBO', 'HAVBERG', 'KLIPPAN', 'MICKE', 'ALEX', 'KALLAX', 'STRANDMON'],
    swatches: ['#2B2B2B', '#B9BDC1', '#F2F1EE'], synonyms: ['modern', 'contemporary', 'sleek'],
  },
  {
    key: 'victorian', label: 'Victorian', blurb: 'Dark woods, velvet, wingbacks, gilt',
    brief: 'Victorian drawing room: rich dark wood, deep jewel tones (burgundy, forest green, navy) or leather, wingback and rolled-arm silhouettes, turned legs, traditional rugs, gilt or brass accents, framed classic art.',
    colors: ['brown', 'red', 'green', 'blue', 'gold', 'black'], avoidColors: ['white', 'multicolor'], materials: ['velvet', 'leather', 'wood', 'wool'], avoidMaterials: ['plastic', 'glass', 'rattan'],
    words: ['wing', 'wingback', 'chesterfield', 'tufted', 'velvet', 'classic', 'traditional', 'antique', 'ornate', 'carved', 'turned', 'damask', 'persian', 'oriental', 'vintage', 'dark brown', 'black brown', 'brass', 'gold', 'leather', 'rolled arm'],
    avoidWords: ['modern', 'minimal', 'industrial', 'metal', 'plastic', 'gaming', 'rattan'],
    ranges: ['STRANDMON', 'EKTORP', 'HEMNES', 'HAVSTA', 'LIATORP', 'STOCKSUND', 'JENNYLUND', 'LANDSKRONA', 'INGATORP', 'TOMMARYD', 'GRÖNLID', 'VEDBO', 'EKENÄSET'],
    swatches: ['#5B1F24', '#2F4A3A', '#B08A4A'], synonyms: ['victorian', 'edwardian', 'antique', 'old world', 'period'],
  },
  {
    key: 'scandinavian', label: 'Scandinavian', blurb: 'Light oak, white, wool and linen',
    brief: 'Scandinavian: light oak or birch, white and warm gray, soft wool and linen, simple rounded shapes, cozy but airy.',
    colors: ['white', 'beige', 'gray'], avoidColors: ['red', 'purple', 'gold', 'multicolor'], materials: ['wood', 'wool', 'linen', 'fabric'], avoidMaterials: ['velvet', 'glass'],
    words: ['oak', 'birch', 'white', 'light', 'wool', 'linen', 'nordic', 'scandinavian'], avoidWords: ['ornate', 'glam', 'velvet', 'gold', 'dark'],
    ranges: ['LISABO', 'EKEDALEN', 'NORDVIKEN', 'POÄNG', 'SÖDERHAMN', 'STOCKHOLM', 'VIMLE', 'KNOPPARP', 'EKTORP', 'LACK', 'BILLY', 'IVAR', 'HEMNES', 'MÖRBYLÅNGA', 'EKERÖ'],
    swatches: ['#F4F1EA', '#D8C6A6', '#9A9A9A'], synonyms: ['scandinavian', 'scandi', 'nordic', 'swedish', 'hygge'],
  },
  {
    key: 'mid-century', label: 'Mid-century', blurb: 'Walnut, tapered legs, mustard and teal',
    brief: 'Mid-century modern: walnut or teak wood, tapered legs, low-slung sofas, leather or tweed, accents of mustard, olive, orange or teal.',
    colors: ['brown', 'orange', 'yellow', 'green', 'blue'], avoidColors: ['pink', 'purple', 'silver'], materials: ['wood', 'leather', 'fabric'], avoidMaterials: ['plastic', 'rattan'],
    words: ['mid century', 'mid-century', 'retro', 'tapered', 'walnut', 'teak', 'mustard', 'tweed'], avoidWords: ['ornate', 'rustic', 'farmhouse'],
    ranges: ['VEDBO', 'KOARP', 'STOCKHOLM', 'EKERÖ', 'LISABO', 'VIMLE', 'LANDSKRONA', 'GLOSTAD', 'MÖCKELBY', 'BJÖRKSNÄS', 'STOCKSUND'],
    swatches: ['#7A4A2A', '#C9962F', '#2E6A6A'], synonyms: ['mid century', 'midcentury', 'mid-century', 'mcm', 'retro', 'sixties', '60s'],
  },
  {
    key: 'industrial', label: 'Industrial', blurb: 'Black steel, raw wood, worn leather',
    brief: 'Industrial loft: black metal frames, raw or dark wood, cognac or black leather, charcoal fabrics, exposed-bulb lighting.',
    colors: ['black', 'brown', 'gray'], avoidColors: ['pink', 'purple', 'white', 'multicolor'], materials: ['metal', 'wood', 'leather'], avoidMaterials: ['velvet', 'rattan', 'boucle'],
    words: ['industrial', 'metal', 'steel', 'iron', 'reclaimed', 'pipe', 'black', 'leather', 'loft'], avoidWords: ['ornate', 'glam', 'pastel'],
    ranges: ['VITTSJÖ', 'FJÄLLBO', 'BROR', 'HYLLIS', 'NORRÅKER', 'SANDSBERG', 'LANDSKRONA', 'RÅSKOG', 'OMAR', 'TORSHULT', 'NORRHULT'],
    swatches: ['#1F1F1F', '#6B4A33', '#8A8C8E'], synonyms: ['industrial', 'loft', 'warehouse', 'urban'],
  },
  {
    key: 'japandi', label: 'Japandi', blurb: 'Low, calm, natural wood and linen',
    brief: 'Japandi: low calm silhouettes, natural wood and bamboo, linen and paper textures, muted beige, black and warm brown, very little decoration.',
    colors: ['beige', 'brown', 'black', 'white'], avoidColors: ['red', 'pink', 'purple', 'multicolor', 'gold'], materials: ['wood', 'linen', 'rattan', 'cotton', 'ceramic'], avoidMaterials: ['velvet', 'glass', 'plastic'],
    words: ['bamboo', 'oak', 'low', 'linen', 'natural', 'paper', 'japanese', 'rattan'], avoidWords: ['ornate', 'glam', 'tufted', 'gaming'],
    ranges: ['BJÖRKSNÄS', 'LISABO', 'SINNERLIG', 'NORDKISA', 'SKOGSTA', 'TOSTERÖ', 'AGEN', 'STOCKHOLM', 'MÅRUM', 'SVALLERUP', 'ÄLMSTA'],
    swatches: ['#E6DCCB', '#8B6B4A', '#2A2724'], synonyms: ['japandi', 'japanese', 'zen', 'wabi sabi'],
  },
  {
    key: 'boho', label: 'Boho', blurb: 'Rattan, jute, plants and pattern',
    brief: 'Bohemian: rattan and wicker, jute and patterned rugs, warm terracotta, mustard and green, lots of plants, relaxed layered comfort.',
    colors: ['orange', 'beige', 'green', 'multicolor', 'yellow', 'brown'], avoidColors: ['silver', 'gray'], materials: ['rattan', 'jute', 'cotton', 'wool', 'wood'], avoidMaterials: ['glass', 'metal', 'plastic'],
    words: ['rattan', 'wicker', 'woven', 'jute', 'macrame', 'boho', 'pattern', 'terracotta', 'cane'], avoidWords: ['chrome', 'gaming', 'glass'],
    ranges: ['BUSKBO', 'SINNERLIG', 'GLADOM', 'ÄLMSTA', 'NORDKISA', 'TOLKNING', 'AGEN', 'LOHALS', 'SKOTTORP', 'KLIPPAN', 'VIMLE'],
    swatches: ['#C46A3C', '#D9B44A', '#5E7B5A'], synonyms: ['boho', 'bohemian', 'eclectic', 'hippie'],
  },
  {
    key: 'coastal', label: 'Coastal', blurb: 'Whites, sea blues, linen and light wood',
    brief: 'Coastal: crisp white and sand, soft sea blues, washed light wood, linen slipcovers, rattan and jute accents, airy and bright.',
    colors: ['white', 'blue', 'beige'], avoidColors: ['black', 'red', 'purple'], materials: ['linen', 'cotton', 'rattan', 'jute', 'wood'], avoidMaterials: ['leather', 'velvet', 'metal'],
    words: ['coastal', 'beach', 'linen', 'white', 'blue', 'rattan', 'jute', 'washed', 'light'], avoidWords: ['dark', 'industrial', 'ornate'],
    ranges: ['EKTORP', 'HEMNES', 'LOHALS', 'BUSKBO', 'NORDVIKEN', 'LACK', 'GLADOM', 'KLIPPAN', 'SÖDERHAMN', 'UPPLAND'],
    swatches: ['#F7F5F0', '#7FA3C0', '#D8C6A6'], synonyms: ['coastal', 'beach', 'nautical', 'seaside', 'hamptons'],
  },
  {
    key: 'farmhouse', label: 'Farmhouse', blurb: 'Warm wood, white paint, cozy textures',
    brief: 'Modern farmhouse: warm natural or painted wood, white and cream, black iron accents, slipcovered sofas, woven textures.',
    colors: ['white', 'brown', 'beige', 'black'], avoidColors: ['purple', 'pink', 'silver'], materials: ['wood', 'cotton', 'linen', 'jute', 'metal'], avoidMaterials: ['glass', 'velvet', 'plastic'],
    words: ['farmhouse', 'rustic', 'distressed', 'barn', 'shaker', 'pine', 'reclaimed', 'cottage'], avoidWords: ['glam', 'chrome', 'gaming'],
    ranges: ['HEMNES', 'INGATORP', 'EKTORP', 'HAVSTA', 'LIATORP', 'NORDVIKEN', 'TARVA', 'ODGER', 'LERHAMN', 'BJURSTA', 'MÖCKELBY'],
    swatches: ['#F4EFE6', '#9C7652', '#2B2B2B'], synonyms: ['farmhouse', 'rustic', 'country', 'cottage'],
  },
  {
    key: 'glam', label: 'Art Deco', blurb: 'Velvet, brass, marble, bold geometry',
    brief: 'Art Deco glam: velvet in emerald, navy or blush, polished brass and gold, marble and glass surfaces, curved and channel-tufted shapes, mirrors.',
    colors: ['gold', 'green', 'blue', 'pink', 'black'], avoidColors: ['beige', 'orange'], materials: ['velvet', 'marble', 'glass', 'metal', 'stone'], avoidMaterials: ['rattan', 'jute'],
    words: ['velvet', 'gold', 'brass', 'marble', 'glass', 'channel', 'tufted', 'mirrored', 'glam', 'art deco', 'curved'], avoidWords: ['rustic', 'farmhouse', 'distressed'],
    ranges: ['STOCKSUND', 'KLIPPAN', 'LANDSKRONA', 'VEDBO', 'GLADOM', 'VITTSJÖ', 'STOCKHOLM', 'TOMMARYD', 'SÖDERHAMN'],
    swatches: ['#1F4D3A', '#B8934A', '#1C1C24'], synonyms: ['art deco', 'deco', 'glam', 'glamorous', 'hollywood', 'luxe', 'luxury'],
  },
  {
    key: 'minimalist', label: 'Minimalist', blurb: 'Fewer, simpler pieces in quiet tones',
    brief: 'Minimalist: few pieces, simple geometric forms, white, gray, black and pale wood, no ornament and no pattern.',
    colors: ['white', 'gray', 'black', 'beige'], avoidColors: ['multicolor', 'red', 'orange', 'pink', 'purple', 'gold'], materials: ['wood', 'metal', 'fabric'], avoidMaterials: ['velvet', 'rattan'],
    words: ['minimal', 'simple', 'white', 'low', 'slim'], avoidWords: ['ornate', 'tufted', 'pattern', 'carved'],
    ranges: ['LACK', 'MICKE', 'ALEX', 'KALLAX', 'BESTÅ', 'SÖDERHAMN', 'LISABO', 'VIMLE', 'MALM', 'BRIMNES', 'KLIPPAN', 'LINNMON'],
    swatches: ['#FFFFFF', '#C9C9C9', '#1E1E1E'], synonyms: ['minimalist', 'minimal', 'simple', 'clean'],
  },
  {
    key: 'traditional', label: 'Traditional', blurb: 'Classic shapes, warm wood, rolled arms',
    brief: 'Classic traditional: rolled-arm sofas, warm medium wood, cream and navy or sage, patterned rugs, symmetric arrangement, framed art.',
    colors: ['beige', 'brown', 'blue', 'green', 'white'], avoidColors: ['multicolor', 'silver'], materials: ['wood', 'fabric', 'leather', 'wool'], avoidMaterials: ['plastic', 'glass'],
    words: ['classic', 'traditional', 'rolled', 'wing', 'turned', 'panel'], avoidWords: ['industrial', 'gaming', 'minimal'],
    ranges: ['EKTORP', 'HEMNES', 'STRANDMON', 'HAVSTA', 'LIATORP', 'STOCKSUND', 'JENNYLUND', 'INGATORP', 'TOMMARYD', 'LANDSKRONA'],
    swatches: ['#1F3050', '#E9E0CF', '#8A6A48'], synonyms: ['traditional', 'classic', 'timeless', 'transitional'],
  },
];

const BY_KEY = new Map(STYLE_PROFILES.map((s) => [s.key, s]));
export const styleProfile = (key: string | null | undefined) => (key ? BY_KEY.get(key) : undefined);

const normalize = (s: string) => ` ${s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** "make it victorian", "mid century", "scandi please" -> style key (longest synonym wins). */
export function matchStyle(text: string): string | null {
  const t = normalize(text);
  let best: { key: string; len: number } | null = null;
  for (const s of STYLE_PROFILES) {
    for (const w of [s.key, s.label, ...s.synonyms]) {
      const n = normalize(w).trim();
      if (n && t.includes(` ${n} `) && (!best || n.length > best.len)) best = { key: s.key, len: n.length };
    }
  }
  return best?.key ?? null;
}

/** "Design my room in a Victorian style", "redo it mid-century", "furnish the room" -> a design request. */
export function designRequest(text: string): { style: string | null } | null {
  const t = normalize(text);
  const style = matchStyle(text);
  // The verb has to act on the room ("design my room", "redo it"): "I like this design" is not a request.
  if (/^ (what|which|how|who|is|are|does|do you like)\b/.test(t) && !/\b(can|could|would|will) you\b/.test(t)) return null; // a question about a design
  if (/\b(design|redesign|decorate|redecorate|furnish|refurnish|restyle|redo|stage)\b(?: \w+){0,4}? (room|space|place|apartment|it|everything|bedroom|office|den)\b/.test(t)) return { style };
  if (/\b(style|do|fill)\b(?: \w+){0,3}? (room|space|apartment|bedroom|office|den)\b/.test(t)) return { style };
  if (/\bmake ?over\b/.test(t)) return { style };
  // "make it victorian", "turn my room art deco", "go full japandi"
  if (style && /\b(make|turn|go|switch|change|convert)\b/.test(t) && /\b(room|it|this|everything|space)\b/.test(t)) return { style };
  return null;
}

const ownWords = (text: string) => normalize(text);

/**
 * How well a listing fits a style, from its text and attributes (roughly -2..+3). Free, so it can score the whole
 * catalog; the designer model then chooses among the top of this list.
 */
export function styleScore(p: Product, s: StyleProfile): number {
  const t = ownWords(`${p.title} ${p.description ?? ''}`);
  const range = p.source === 'ikea' ? p.title.split(/[\s,]/)[0].toUpperCase() : '';
  let sc = 0;
  if (range && s.ranges.includes(range)) sc += 0.9;
  const colors = p.attrs?.colors ?? [];
  const materials = p.attrs?.materials ?? [];
  if (colors[0] && s.colors.includes(colors[0])) sc += 0.55;
  else if (colors.some((c) => s.colors.includes(c))) sc += 0.3;
  if (colors.some((c) => s.avoidColors.includes(c))) sc -= 0.55;
  if (materials.some((m) => s.materials.includes(m))) sc += 0.4;
  if (materials.some((m) => s.avoidMaterials.includes(m))) sc -= 0.5;
  let hits = 0;
  for (const w of s.words) if (t.includes(` ${normalize(w).trim()} `)) hits++;
  sc += Math.min(3, hits) * 0.35;
  for (const w of s.avoidWords) if (t.includes(` ${normalize(w).trim()} `)) sc -= 0.45;
  if (p.attrs?.styles?.includes(s.key)) sc += 0.5;
  if (p.rating && (p.reviews ?? 0) >= 3) sc += (p.rating - 4) * 0.25;
  return sc;
}
