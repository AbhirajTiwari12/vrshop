import { config } from '../config.js';
import { fetchJson } from '../util/http.js';
import { log, errMsg } from '../util/log.js';
import { hash } from '../store.js';
import { parseDims } from '../catalog.js';
import type { Dims, Product } from '../types.js';
import { formatPrice } from './ikea.js';

// Google Shopping via SerpApi: real listings from Amazon, Wayfair, Target, Walmart, etc.
// google_shopping returns ~40 items with price/thumbnail/source but only a Google product link.
// google_immersive_product (1 extra search) resolves the direct store link + more images/specs;
// we call it lazily, only for items the user places or adds to the cart.

const SERP = 'https://serpapi.com/search.json';

export async function searchShopping(query: string, opts: { maxPrice?: number; limit?: number } = {}): Promise<Product[]> {
  if (!config.serpapiKey) return [];
  const params = new URLSearchParams({ engine: 'google_shopping', q: query, gl: 'us', hl: 'en', api_key: config.serpapiKey });
  if (opts.maxPrice) params.set('max_price', String(Math.round(opts.maxPrice)));
  try {
    const data = await fetchJson<any>(`${SERP}?${params}`, { timeoutMs: 25000, retries: 1 });
    const results: any[] = data?.shopping_results ?? [];
    return results
      .filter((r) => r.title && (r.thumbnail || r.serpapi_thumbnail))
      .slice(0, opts.limit ?? 16)
      .map((r): Product => {
        const price = typeof r.extracted_price === 'number' ? r.extracted_price : null;
        const dims = parseDims(`${r.title} ${r.snippet ?? ''} ${(r.extensions ?? []).join(' ')}`);
        const store = String(r.source ?? 'Store').replace(/^www\./, '');
        return {
          id: `gs-${hash(r.product_id || r.title + store)}`,
          source: 'google_shopping',
          store,
          title: r.title,
          category: '',
          price,
          currency: 'USD',
          priceText: r.price ?? (price != null ? formatPrice(price) : ''),
          rating: r.rating ?? undefined,
          reviews: r.reviews ?? undefined,
          imageUrl: r.thumbnail || r.serpapi_thumbnail,
          images: [r.thumbnail || r.serpapi_thumbnail].filter(Boolean),
          productUrl: r.product_link || r.link || '',
          storeLinkResolved: !!r.link && !String(r.link).includes('google.'),
          dims: dims ?? undefined,
          dimsSource: dims ? 'listing' : undefined,
          model: { status: 'none' },
          serpImmersiveToken: r.immersive_product_page_token,
        };
      });
  } catch (e) {
    log.warn('serp', `shopping "${query}" failed: ${errMsg(e)}`);
    return [];
  }
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
