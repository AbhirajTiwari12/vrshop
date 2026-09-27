import { CATEGORIES, matchCategory } from '../catalog.js';
import { COLORS, MATERIALS, STYLES, extractColors, extractMaterials, extractStyles } from '../inventory/attributes.js';
import { normalizeFilters } from '../inventory/filters.js';
import { log, errMsg } from '../util/log.js';
import type { ChatTurn, Filters, Product, RoomAnalysis } from '../types.js';
import { chatJson, hasOpenAI } from './openai.js';

// The shopping assistant: turns what the user says ("black leather sofa", "anything cheaper?", "how much is the
// second one?", "add it to my cart") into the next filter state + an optional question and action. Numbers in the
// answer are computed by the server from real listings afterwards, so the model never makes up prices.

export const QUESTIONS = ['none', 'cheapest', 'most_expensive', 'price_range', 'average_price', 'count', 'best_rated', 'budget_left'] as const;
export type Question = (typeof QUESTIONS)[number];
export const ACTIONS = ['none', 'open', 'add_to_cart', 'remove_from_cart', 'place', 'checkout'] as const;
export type Action = (typeof ACTIONS)[number];

export interface AssistantContext {
  filters: Filters;
  visible: Product[];              // what the user is looking at now (numbered 1..n in the prompt)
  focused?: Product;               // detail view open on the headset / phone
  total: number;
  priceRange: { min: number; max: number; median: number } | null;
  room: RoomAnalysis | null;
  budget: number | null;
  cartTotal: number;
  chat: ChatTurn[];
  stores: string[];                // store names in the catalog, so "from Wayfair" maps to a real value
}

export interface Interpretation {
  filters: Filters;
  question: Question;
  action: Action;
  target?: Product;                // product the question/action refers to
  atPointer: boolean;              // "put it here" while pointing
  reply: string;
  source: 'openai' | 'heuristic';
}

const str = { type: 'string' } as const;
const num = { type: 'number' } as const;
const obj = (properties: Record<string, object>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const enumArr = (values: readonly string[]) => ({ type: 'array', items: { type: 'string', enum: values } });

const SCHEMA = obj({
  filters: obj({
    category: { type: 'string', enum: [...CATEGORIES.map((c) => c.key), 'any'] },
    keywords: { type: 'array', items: str },
    colors: enumArr(COLORS),
    materials: enumArr(MATERIALS),
    styles: enumArr(STYLES),
    stores: { type: 'array', items: str },
    minPrice: num,
    maxPrice: num,
    minRating: num,
    maxWidthM: num,
    maxDepthM: num,
    maxHeightM: num,
    only3d: { type: 'boolean' },
    sort: { type: 'string', enum: ['relevance', 'price_asc', 'price_desc', 'rating'] },
  }),
  question: { type: 'string', enum: QUESTIONS },
  action: { type: 'string', enum: ACTIONS },
  target: { type: 'integer' },
  atPointer: { type: 'boolean' },
  reply: str,
});

const SYSTEM = `You are the voice shopping assistant in a furniture app. The user browses a catalog of real listings and talks to you to narrow it down, ask about prices, and pick things.

Return the COMPLETE filter state after this message:
- Start from the current filters. Keep everything the user didn't change. Remove things they drop ("any color", "forget the price", "show everything" = clear all).
- A different kind of item ("now show me rugs") starts fresh: new category, other filters cleared unless restated.
- category: one of the enum keys, or "any".
- colors / materials / styles: only enum values. Map synonyms (navy -> blue, cream -> beige, vegan leather -> faux leather, walnut/oak -> wood). "leather" already includes faux leather.
- keywords: ONLY concrete features that appear in product titles: sleeper, sectional, round, extendable, storage, swivel, reclining, modular, corner, glass top, queen, king, 8x10. Never colors, materials, styles, the item type itself, or vibes like "cozy".
- Prices in USD; 0 = no limit. "under 800" -> maxPrice 800. "cheaper" -> maxPrice about 15% below the referenced item's price, or below the current median. "more premium" -> minPrice around the current median.
- Sizes in meters (1 in = 0.0254 m, 1 ft = 0.3048 m); 0 = no limit. "fits a 7 foot wall" -> maxWidthM 2.13.
- minRating 0..5, 0 = none. only3d = user wants items with real 3D models.
- sort: "cheapest first" -> price_asc; "best reviewed" -> rating; otherwise keep the current sort.

question (the app answers it with real numbers from the NEW results — never state prices or counts yourself for these):
cheapest, most_expensive, price_range, average_price, count, best_rated, budget_left (budget/cart), or none.

target: 1-based number of the listed item the user refers to ("the second one" = 2, "the black one" = the matching item). 0 = the focused item or none. -1 if nothing specific.
For "the cheapest / most expensive / best rated one" set question accordingly and target -1: the app picks that item from the real results.
action: open (details), add_to_cart ("add it", "I'll take it"), remove_from_cart, place ("show it in my room", "put it here"),
checkout ("buy the room", "check out", "buy everything in my cart" — the app then asks the user to approve the payment; never claim it's paid), or none.
atPointer: true if they refer to a spot ("here", "in this corner", "next to the couch").

reply: one short friendly spoken sentence (max 20 words), or "" when the turn only changes filters or asks an aggregate question (the app already announces "Found N ..." and the numbers — don't repeat what you're searching for). Never say how many results there are or quote aggregate prices. You MAY answer questions about a specific listed item using its data (price, size, store). If the request isn't about shopping, answer briefly and keep the filters.`;

export async function interpret(text: string, ctx: AssistantContext): Promise<Interpretation> {
  if (!hasOpenAI()) return heuristicInterpret(text, ctx);
  try {
    const listed = ctx.visible.slice(0, 8).map((p, i) => `${i + 1}. ${p.title} | ${p.store} | ${p.priceText || 'no price'}${p.rating ? ` | ${p.rating}★ (${p.reviews ?? 0})` : ''}${p.dims ? ` | ${Math.round(p.dims.w * 100)}x${Math.round(p.dims.d * 100)}x${Math.round(p.dims.h * 100)} cm` : ''} | colors: ${p.attrs?.colors.join('/') || '?'} | materials: ${p.attrs?.materials.join('/') || '?'}`);
    const context = [
      `Current filters: ${JSON.stringify(ctx.filters)}`,
      `Current results: ${ctx.total} listings${ctx.priceRange ? `, $${ctx.priceRange.min}–$${ctx.priceRange.max} (median $${ctx.priceRange.median})` : ''}. On screen:`,
      ...(listed.length ? listed : ['(nothing yet)']),
      ctx.focused ? `Focused item (detail view open): ${ctx.focused.title} | ${ctx.focused.store} | ${ctx.focused.priceText}${ctx.focused.dims ? ` | ${Math.round(ctx.focused.dims.w * 100)}x${Math.round(ctx.focused.dims.d * 100)}x${Math.round(ctx.focused.dims.h * 100)} cm` : ''}` : 'Focused item: none',
      ctx.room ? `Room: ${ctx.room.roomType}, style ${ctx.room.styleTags.join(', ')}` : '',
      `Budget: ${ctx.budget ? `$${ctx.budget}` : 'none'}; cart so far $${ctx.cartTotal}`,
      `Stores in the catalog: ${ctx.stores.slice(0, 25).join(', ')}`,
    ].filter(Boolean).join('\n');
    const history = ctx.chat.slice(-6).map((t) => ({ role: t.role, content: t.text }) as const);
    const r = await chatJson<any>({
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: context }, ...history, { role: 'user', content: text }],
      schemaName: 'shopping_turn',
      schema: SCHEMA,
      effort: 'none',
      timeoutMs: 30000,
    });
    const f = { ...r.filters, category: r.filters.category === 'any' ? undefined : r.filters.category };
    const filters = normalizeFilters(f);
    return {
      filters,
      question: QUESTIONS.includes(r.question) ? r.question : 'none',
      action: ACTIONS.includes(r.action) ? r.action : 'none',
      target: pickTarget(r.target, ctx),
      atPointer: !!r.atPointer,
      reply: String(r.reply ?? '').trim(),
      source: 'openai',
    };
  } catch (e) {
    log.warn('assistant', `LLM failed, heuristic: ${errMsg(e)}`);
    return heuristicInterpret(text, ctx);
  }
}

function pickTarget(n: number, ctx: AssistantContext): Product | undefined {
  if (n > 0 && n <= ctx.visible.length) return ctx.visible[n - 1];
  if (n === 0) return ctx.focused;
  return undefined;
}

// ------------------------------------------------------------------------------------------ no-key fallback

/** 1869 -> 1850, 187 -> 180: a price a person would say. */
const niceDown = (v: number) => (v > 200 ? Math.floor(v / 50) * 50 : Math.floor(v / 10) * 10);
const ORDINAL_RE = /\b(first|second|third|fourth|fifth|sixth|last|1st|2nd|3rd|4th|5th|6th)\b/;
const ORDINALS: Record<string, number> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, sixth: 6, '6th': 6, last: -1 };
const num$ = (s: string) => Number(s.replace(/[,$]/g, '').replace(/k$/i, '000'));

export function heuristicInterpret(text: string, ctx: AssistantContext): Interpretation {
  const t = text.toLowerCase();
  const reset = /\b(start over|reset|clear (all|everything|filters)|show (me )?everything|show all)\b/.test(t);
  const category = matchCategory(t);
  const fresh = reset || (category && category !== ctx.filters.category);
  let f: Filters = fresh ? {} : { ...ctx.filters };
  if (category) f.category = category;

  const colors = extractColors(t), materials = extractMaterials(t), styles = extractStyles(t);
  if (/\bany colou?r\b/.test(t)) delete f.colors; else if (colors.length) f.colors = colors;
  if (/\bany material\b/.test(t)) delete f.materials; else if (materials.length) f.materials = materials;
  if (styles.length) f.styles = styles;

  const between = t.match(/\bbetween \$?([\d,.]+k?) and \$?([\d,.]+k?)/) ?? t.match(/\$?([\d,.]+k?)\s*(?:to|-)\s*\$?([\d,.]+k?)\s*(?:dollars|bucks|\$)?/);
  const under = t.match(/\b(?:under|below|less than|at most|max(?:imum)?|cheaper than|up to)\s*\$?([\d,.]+k?)/);
  const over = t.match(/\b(?:over|above|more than|at least|min(?:imum)?)\s*\$?([\d,.]+k?)/);
  if (between && /\d/.test(between[1]) && /\d/.test(between[2])) { f.minPrice = num$(between[1]); f.maxPrice = num$(between[2]); }
  else {
    if (under) f.maxPrice = num$(under[1]);
    if (over) f.minPrice = num$(over[1]);
  }
  if (/\bany price\b|\bno budget\b|forget the price/.test(t)) { delete f.minPrice; delete f.maxPrice; }
  if (/\bcheaper\b/.test(t) && !under) {
    const ref = ctx.focused?.price ?? ctx.priceRange?.median;
    if (ref) f.maxPrice = niceDown(ref * 0.85);
  }
  if (/\b3d\b/.test(t)) f.only3d = true;
  if (/\b(sleeper|sectional|round|extendable|storage|swivel|reclining|recliner|modular|corner)\b/.test(t)) {
    f.keywords = [...new Set([...(f.keywords ?? []), ...(t.match(/\b(sleeper|sectional|round|extendable|storage|swivel|reclining|modular|corner)\b/g) ?? [])])];
  }
  if (/\b(cheapest first|sort by price|lowest price)\b/.test(t)) f.sort = 'price_asc';
  if (/\b(best (rated|reviewed)|highest rated|top rated)\b/.test(t)) f.sort = 'rating';

  const question: Question =
    /\bcheapest\b/.test(t) ? 'cheapest'
      : /\b(most expensive|priciest)\b/.test(t) ? 'most_expensive'
        : /\baverage\b/.test(t) ? 'average_price'
          : /\bhow many\b/.test(t) ? 'count'
            : /\b(budget|left to spend|spent)\b/.test(t) ? 'budget_left'
              : /\b(price range|how much|what do .* cost|prices?)\b/.test(t) && !ctx.focused && !ORDINAL_RE.test(t) ? 'price_range'
                : /\b(best rated|top rated|best reviewed)\b/.test(t) ? 'best_rated' : 'none';

  const ord = Object.entries(ORDINALS).find(([w]) => new RegExp(`\\b${w}\\b`).test(t));
  const target = ord ? (ord[1] === -1 ? ctx.visible[ctx.visible.length - 1] : ctx.visible[ord[1] - 1]) : /\b(this|that|it)\b/.test(t) ? ctx.focused : undefined;
  const action: Action =
    /\b(check ?out|buy (it all|everything|the (whole )?room|my cart)|place (the|my) order|pay for (it all|everything))\b/.test(t) ? 'checkout'
      : /\b(add|put)\b.*\bcart\b|\bi'?ll take\b|\bbuy\b/.test(t) ? 'add_to_cart'
      : /\bremove\b.*\bcart\b/.test(t) ? 'remove_from_cart'
        : /\b(place|show (it|me) in (my|the) room|put (it|this) (here|there))\b/.test(t) ? 'place'
          : /\b(open|details|tell me (more )?about)\b/.test(t) ? 'open' : 'none';

  const filters = normalizeFilters(f);
  let reply = '';
  if (target && /\bhow much\b/.test(t)) reply = `${target.title} is ${target.priceText || 'not priced'} at ${target.store}.`;
  else if (JSON.stringify(filters) === JSON.stringify(normalizeFilters(ctx.filters)) && question === 'none' && action === 'none' && !reset) reply = `Try something like “a black leather sofa under $1,000”.`;
  return { filters, question, action, target, atPointer: /\b(here|there|this corner|that corner)\b/.test(t), reply, source: 'heuristic' };
}

// ------------------------------------------------------------------------------------------ answers from data

const money = (v: number) => `$${v % 1 === 0 ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const short = (p: Product) => p.title.length > 60 ? `${p.title.slice(0, 57).trim()}…` : p.title;

/** The single listing a superlative question points at ("add the cheapest one"). */
export function superlative(q: Question, matches: Product[]): Product | undefined {
  const priced = matches.filter((p) => p.price != null);
  if (q === 'cheapest') return [...priced].sort((a, b) => a.price! - b.price!)[0];
  if (q === 'most_expensive') return [...priced].sort((a, b) => b.price! - a.price!)[0];
  if (q === 'best_rated') return [...matches].filter((x) => x.rating && (x.reviews ?? 0) >= 3).sort((a, b) => b.rating! - a.rating! || (b.reviews ?? 0) - (a.reviews ?? 0))[0];
  return undefined;
}

/** The factual part of the answer, computed from the listings (all matches, not just the first page). */
export function answer(q: Question, matches: Product[], session: { budget: number | null; cartTotal: number }): string {
  const priced = matches.filter((p) => p.price != null) as (Product & { price: number })[];
  switch (q) {
    case 'cheapest': {
      const p = [...priced].sort((a, b) => a.price - b.price)[0];
      return p ? `The cheapest is ${short(p)} at ${money(p.price)} from ${p.store}.` : '';
    }
    case 'most_expensive': {
      const p = [...priced].sort((a, b) => b.price - a.price)[0];
      return p ? `The most expensive is ${short(p)} at ${money(p.price)} from ${p.store}.` : '';
    }
    case 'best_rated': {
      const p = [...matches].filter((x) => x.rating && (x.reviews ?? 0) >= 3).sort((a, b) => b.rating! - a.rating! || (b.reviews ?? 0) - (a.reviews ?? 0))[0];
      return p ? `Top rated is ${short(p)}: ${p.rating}★ from ${p.reviews} reviews, ${p.priceText}.` : 'None of these have enough reviews to compare yet.';
    }
    case 'price_range': {
      if (!priced.length) return '';
      const s = priced.map((p) => p.price).sort((a, b) => a - b);
      return `They run from ${money(s[0])} to ${money(s[s.length - 1])}, most around ${money(s[Math.floor(s.length / 2)])}.`;
    }
    case 'average_price': {
      if (!priced.length) return '';
      const avg = priced.reduce((a, p) => a + p.price, 0) / priced.length;
      return `The average price is ${money(Math.round(avg))} across ${priced.length} options.`;
    }
    case 'count':
      return matches.length === 1 ? 'There’s just 1.' : `There are ${matches.length}.`;
    case 'budget_left':
      return session.budget
        ? `Your cart is ${money(session.cartTotal)} of your ${money(session.budget)} budget, so ${session.cartTotal <= session.budget ? `${money(Math.round(session.budget - session.cartTotal))} left` : `${money(Math.round(session.cartTotal - session.budget))} over`}.`
        : `Your cart is ${money(session.cartTotal)} so far; no budget set.`;
    default:
      return '';
  }
}
