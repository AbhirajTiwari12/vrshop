import { getProduct } from '../store.js';
import { queryInventory } from '../inventory/inventory.js';
import { visaStatus } from './visa.js';
import type { Product, Session } from '../types.js';

// What "Buy the room" would charge: the cart grouped by retailer, against the room budget, plus AI budget
// coaching — when the basket is over budget, cheaper look-alikes from the catalog that bring it back under.

export interface QuoteItem { productId: string; title: string; qty: number; unitPrice: number; imageUrl: string }
export interface Swap { from: QuoteItem; to: { productId: string; title: string; price: number; store: string; imageUrl: string }; saves: number; why: string }
export interface Quote {
  currency: string;
  total: number;
  budget: number | null;
  overBy: number;
  groups: { store: string; subtotal: number; items: QuoteItem[] }[];
  unpriced: string[];                  // titles we can't charge for (no listed price)
  swaps: Swap[];
  visa: ReturnType<typeof visaStatus>;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function buildQuote(s: Session): Quote {
  const groups = new Map<string, QuoteItem[]>();
  const unpriced: string[] = [];
  for (const c of s.cart) {
    const p = getProduct(c.productId);
    if (!p) continue;
    if (p.price == null) { unpriced.push(p.title); continue; }
    const list = groups.get(p.store) ?? [];
    list.push({ productId: p.id, title: p.title, qty: c.qty, unitPrice: p.price, imageUrl: p.imageUrl });
    groups.set(p.store, list);
  }
  const g = [...groups.entries()].map(([store, items]) => ({ store, items, subtotal: round2(items.reduce((a, i) => a + i.unitPrice * i.qty, 0)) }))
    .sort((a, b) => b.subtotal - a.subtotal);
  const total = round2(g.reduce((a, x) => a + x.subtotal, 0));
  const overBy = s.budget ? Math.max(0, round2(total - s.budget)) : 0;
  return {
    currency: 'USD',
    total,
    budget: s.budget,
    overBy,
    groups: g,
    unpriced,
    swaps: overBy > 0 ? budgetSwaps(g.flatMap((x) => x.items), overBy) : [],
    visa: visaStatus(),
  };
}

/** Cheaper items of the same kind that share the original's color or material, biggest savings first. */
function budgetSwaps(items: QuoteItem[], overBy: number): Swap[] {
  const out: Swap[] = [];
  let saved = 0;
  const inCart = new Set(items.map((i) => i.productId));
  for (const it of [...items].sort((a, b) => b.unitPrice * b.qty - a.unitPrice * a.qty)) {
    if (saved >= overBy || out.length >= 3) break;
    const p = getProduct(it.productId);
    if (!p?.category) continue;
    const look = { colors: p.attrs?.colors?.slice(0, 1), materials: p.attrs?.materials?.filter((m) => m !== 'fabric').slice(0, 1) };
    const pick = (f: { colors?: string[]; materials?: string[] }) =>
      queryInventory({ category: p.category, maxPrice: it.unitPrice * 0.8, ...(f.colors?.length ? { colors: f.colors } : {}), ...(f.materials?.length ? { materials: f.materials } : {}) }, { limit: 10, boostText: p.title })
        .products.filter((c) => c.price != null && !inCart.has(c.id));
    // Same color + material, then same color, then anything of that kind.
    const cands = [...pick(look), ...pick({ colors: look.colors }), ...pick({})];
    const best = cands.find((c) => (c.rating ?? 4) >= 3.8) ?? cands[0];
    if (!best) continue;
    const saves = round2((it.unitPrice - best.price!) * it.qty);
    out.push({ from: it, to: { productId: best.id, title: best.title, price: best.price!, store: best.store, imageUrl: best.imageUrl }, saves, why: why(p, best) });
    saved += saves;
    inCart.add(best.id);
  }
  return out;
}

function why(from: Product, to: Product): string {
  const shared = [...(to.attrs?.colors ?? []).filter((c) => from.attrs?.colors?.includes(c)), ...(to.attrs?.materials ?? []).filter((m) => from.attrs?.materials?.includes(m))];
  const bits = [shared.length ? `same ${shared.slice(0, 2).join(' ')} look` : 'same kind of piece'];
  if (to.rating && (to.reviews ?? 0) >= 5) bits.push(`${to.rating}★ from ${to.reviews} reviews`);
  if (to.source === 'ikea') bits.push('official 3D model');
  return bits.join(', ');
}
