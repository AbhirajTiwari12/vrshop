import { config } from '../config.js';
import { fetchJson } from '../util/http.js';
import { log, errMsg } from '../util/log.js';
import { hash } from '../store.js';
import { parseDims } from '../catalog.js';
import type { Dims, Product } from '../types.js';
import { formatPrice } from './ikea.js';
import { extractAttributes } from '../inventory/attributes.js';
import { recordShoppingCall } from '../inventory/usage.js';

// Google Shopping: real listings from Amazon, Wayfair, Target, Walmart, etc., via one of two providers:
//  - Serper.dev (POST google.serper.dev/shopping): 2,500 free queries, then ~$1 / 1k. Preferred when its key is set.
//  - SerpApi (engine=google_shopping): 250 free / month. About 40 results per call; Google's current layout has
//    no pagination, so the bulk pull spreads over query variants instead of pages.
// Both return a Google product link; SerpApi's google_immersive_product (1 extra search) resolves the direct
// store link + more images/specs; we call it lazily, only for items the user adds to the cart.

const SERP = 'https://serpapi.com/search.json';
const SERPER = 'https://google.serper.dev/shopping';

export interface ShoppingOpts { maxPrice?: number; limit?: number }

export async function searchShopping(query: string, opts: ShoppingOpts = {}): Promise<Product[]> {
  const provider = config.shopping.provider;
  if (provider === 'none') return [];
  try {
    recordShoppingCall(provider);
    const rows = provider === 'serper' ? await serper(query, opts) : await serpapi(query, opts);
    return rows
      .filter((r) => r.title && r.image && (!opts.maxPrice || r.price == null || r.price <= opts.maxPrice))
      .slice(0, opts.limit ?? 16)
      .map(toProduct);
  } catch (e) {
    log.warn('shopping', `${provider} "${query}" failed: ${errMsg(e)}`);
    return [];
  }
}

interface Row { id?: string; title: string; store: string; price: number | null; priceText?: string; rating?: number; reviews?: number; image: string; link: string; direct: boolean; text: string; token?: string }

async function serpapi(query: string, opts: ShoppingOpts): Promise<Row[]> {
  const params = new URLSearchParams({ engine: 'google_shopping', q: query, gl: 'us', hl: 'en', api_key: config.serpapiKey });
  if (opts.maxPrice) params.set('max_price', String(Math.round(opts.maxPrice)));
  const data = await fetchJson<any>(`${SERP}?${params}`, { timeoutMs: 25000, retries: 1 });
  return (data?.shopping_results ?? []).map((r: any): Row => ({
    id: r.product_id,
    title: r.title,
    store: String(r.source ?? 'Store'),
    price: typeof r.extracted_price === 'number' ? r.extracted_price : parsePrice(r.price),
    priceText: r.price,
    rating: r.rating ?? undefined,
    reviews: r.reviews ?? undefined,
    image: r.thumbnail || r.serpapi_thumbnail,
    link: r.product_link || r.link || '',
    direct: !!r.link && !String(r.link).includes('google.'),
    text: `${r.snippet ?? ''} ${(r.extensions ?? []).join(' ')}`,
    token: r.immersive_product_page_token,
  }));
}

async function serper(query: string, opts: ShoppingOpts): Promise<Row[]> {
  // More than 10 results costs 2 credits on Serper; still ~2 cents per 1k results at paid rates.
  const body: Record<string, unknown> = { q: query, gl: 'us', hl: 'en' };
  if ((opts.limit ?? 16) > 10) body.num = Math.min(100, Math.max(20, opts.limit ?? 40));
  const data = await fetchJson<any>(SERPER, {
    method: 'POST',
    timeoutMs: 20000,
    retries: 1,
    headers: { 'X-API-KEY': config.serperKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (data?.shopping ?? []).map((r: any): Row => ({
    id: r.productId,
    title: r.title,
    store: String(r.source ?? 'Store'),
    price: typeof r.price === 'number' ? r.price : parsePrice(r.price),
    priceText: typeof r.price === 'string' ? r.price : undefined,
    rating: typeof r.rating === 'number' ? r.rating : undefined,
    reviews: typeof r.ratingCount === 'number' ? r.ratingCount : undefined,
    image: r.imageUrl || r.thumbnailUrl,
    link: r.link || '',
    direct: !!r.link && !String(r.link).includes('google.'),
    text: `${r.delivery ?? ''} ${r.offers ?? ''}`,
  }));
}

/** "$1,299.99" | "1.299,99 €" | "$89.99/mo" -> 1299.99 */
export function parsePrice(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,(?=\d{3}\b)/g, '').match(/\d+(?:\.\d{1,2})?/);
  return m ? Number(m[0]) : null;
}

function toProduct(r: Row): Product {
  const dims = parseDims(`${r.title} ${r.text}`);
  const store = r.store.replace(/^www\./, '');
  return {
    id: `gs-${hash(r.id || r.title + store)}`,
    source: 'google_shopping',
    store,
    title: r.title,
    category: '',
    price: r.price,
    currency: 'USD',
    priceText: r.priceText ?? (r.price != null ? formatPrice(r.price) : ''),
    rating: r.rating,
    reviews: r.reviews,
    imageUrl: r.image,
    images: [r.image],
    productUrl: r.link,
    storeLinkResolved: r.direct,
    dims: dims ?? undefined,
    dimsSource: dims ? 'listing' : undefined,
    description: r.text.trim() || undefined,
    attrs: extractAttributes(`${r.title} ${r.text}`),
    model: { status: 'none' },
    serpImmersiveToken: r.token,
  };
}

export interface ImmersiveDetails { storeUrl?: string; store?: string; price?: number; images: string[]; dims?: Dims; description?: string }

/** Resolve the direct store link, extra product images and (sometimes) dimensions. Costs 1 search. */
export async function immersiveDetails(pageToken: string): Promise<ImmersiveDetails | null> {
  if (!config.serpapiKey || !pageToken) return null;
  const params = new URLSearchParams({ engine: 'google_immersive_product', page_token: pageToken, more_stores: 'true', api_key: config.serpapiKey });
  try {
    const data = await fetchJson<any>(`${SERP}?${params}`, { timeoutMs: 25000 });
    const pr = data?.product_results ?? {};
    const stores: any[] = pr.stores ?? [];
    const best = stores.find((s) => s.link && !String(s.link).includes('google.')) ?? stores[0];
    const features: any[] = pr.about_the_product?.features ?? [];
    const specText = features.map((f) => `${f.title}: ${f.value}`).join(' ; ');
    const dims = parseDims(specText) ?? parseDims(pr.about_the_product?.description ?? '');
    const thumbs: string[] = (pr.thumbnails ?? []).map((t: any) => (typeof t === 'string' ? t : t?.link || t?.image)).filter(Boolean);
    return {
      storeUrl: best?.link,
      store: best?.name,
      price: best?.extracted_price,
      images: thumbs,
      dims: dims ?? undefined,
      description: pr.about_the_product?.description,
    };
  } catch (e) {
    log.warn('serp', `immersive failed: ${errMsg(e)}`);
    return null;
  }
}
