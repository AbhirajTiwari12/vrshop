import { config } from '../config.js';
import { BROWSER_UA, fetchJson, fetchWithTimeout } from '../util/http.js';
import { log, errMsg } from '../util/log.js';
import type { Dims, Product } from '../types.js';
import { round3 } from '../catalog.js';

// IKEA's public (unofficial) search API. No key, CORS *, returns price/images/rating.
// Official true-scale GLBs live at web-api.ikea.com/.../rotera/static/models/{itemNo}-mini.glb and
// must be fetched server-side (they 403 any browser Origin other than ikea.com).
// Demo use only: IKEA's ToS limit this to personal, non-commercial use. See docs/PLAN.md.

const { country, lang } = config.ikea;

export async function searchIkea(query: string, size = 12): Promise<Product[]> {
  const url = `https://sik.search.blue.cdtapps.com/${country}/${lang}/search-result-page?q=${encodeURIComponent(query)}&size=${size}&types=PRODUCT`;
  try {
    const data = await fetchJson<any>(url, { timeoutMs: 12000, retries: 1, headers: { 'User-Agent': BROWSER_UA } });
    const items: any[] = data?.searchResultPage?.products?.main?.items ?? [];
    return items
      .map((it) => it?.product)
      .filter((p) => p && p.itemNo && p.salesPrice)
      .map((p): Product => {
        const price = typeof p.salesPrice?.numeral === 'number' ? p.salesPrice.numeral : null;
        const currency = p.salesPrice?.currencyCode ?? 'USD';
        const images: string[] = (p.allProductImage ?? []).map((i: any) => i.url).filter(Boolean);
        return {
          id: `ikea-${p.itemNo}`,
          source: 'ikea',
          store: 'IKEA',
          title: `${p.name} ${p.typeName}${p.validDesignText ? `, ${p.validDesignText}` : ''}`,
          brand: 'IKEA',
          category: '',
          price,
          currency,
          priceText: price != null ? formatPrice(price, currency) : '',
          rating: p.ratingValue ?? undefined,
          reviews: p.ratingCount ?? undefined,
          imageUrl: p.mainImageUrl ?? images[0] ?? '',
          images: images.length ? images : [p.mainImageUrl].filter(Boolean),
          productUrl: p.pipUrl,
          storeLinkResolved: true,
          colors: (p.colors ?? []).map((c: any) => `#${c.hex}`),
          model: { status: 'none' },
          ikeaItemNo: String(p.itemNo),
        };
      });
  } catch (e) {
    log.warn('ikea', `search "${query}" failed: ${errMsg(e)}`);
    return [];
  }
}

export function ikeaModelUrl(itemNo: string): string {
  const id = itemNo.replace(/^s/i, '');
  return `https://web-api.ikea.com/${country}/${lang}/rotera/static/models/${id}-mini.glb`;
}

const modelExistsCache = new Map<string, boolean>();

/** True if IKEA publishes an official 3D model for this item (cached HEAD/GET probe). */
export async function ikeaHasModel(itemNo: string): Promise<boolean> {
  if (modelExistsCache.has(itemNo)) return modelExistsCache.get(itemNo)!;
  let ok = false;
  try {
    // No Origin header on purpose: the CDN rejects third-party origins.
    const res = await fetchWithTimeout(ikeaModelUrl(itemNo), { method: 'HEAD', timeoutMs: 8000, headers: { 'User-Agent': BROWSER_UA } });
    ok = res.ok;
    if (res.status === 405) {
      const g = await fetchWithTimeout(ikeaModelUrl(itemNo), { timeoutMs: 15000, headers: { 'User-Agent': BROWSER_UA, Range: 'bytes=0-15' } });
      ok = g.ok || g.status === 206;
    }
  } catch {
    ok = false;
  }
  modelExistsCache.set(itemNo, ok);
  return ok;
}

/** Product (not packaging) measurements from the product page. Best effort; the GLB bounds are the fallback. */
export async function fetchIkeaDims(pipUrl: string): Promise<Dims | null> {
  try {
    const res = await fetchWithTimeout(pipUrl, { timeoutMs: 15000, headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US' } });
    if (!res.ok) return null;
    const html = await res.text();
    // Product measurements use {"measure","name"} entries; packaging uses {"label","type","text"}.
    const m = html.match(/"measurements":(\[\{"measure".*?\}\])/);
    if (!m) return null;
    const arr = JSON.parse(m[1]) as { measure: string; name: string }[];
    const get = (...names: string[]) => {
      const e = arr.find((x) => names.some((n) => x.name.toLowerCase() === n));
      return e ? measureToMeters(e.measure) : null;
    };
    const w = get('width') ?? get('length') ?? get('diameter', 'base diameter', 'shade diameter');
    const d = get('depth') ?? get('diameter', 'base diameter', 'shade diameter') ?? w;
    const h = get('height') ?? get('max. height') ?? get('thickness');
    if (w && d && h) return { w: round3(w), d: round3(d), h: round3(h) };
    return null;
  } catch {
    return null;
  }
}

/** '26 3/4 "' | '59 "' | '3 \' 3 "' | '80 cm' -> meters */
function measureToMeters(s: string): number | null {
  const t = s.replace(/¼/g, ' 1/4').replace(/½/g, ' 1/2').replace(/¾/g, ' 3/4').replace(/⅛/g, ' 1/8').replace(/⅜/g, ' 3/8').replace(/⅝/g, ' 5/8').replace(/⅞/g, ' 7/8');
  const num = (x: string) => {
    const parts = x.trim().split(/\s+/);
    let v = 0;
    for (const p of parts) {
      if (p.includes('/')) { const [a, b] = p.split('/').map(Number); if (b) v += a / b; }
      else if (!Number.isNaN(Number(p))) v += Number(p);
    }
    return v;
  };
  const ft = t.match(/([\d\s/.]+)'\s*([\d\s/.]+)?"?/);
  if (ft && t.includes("'")) return num(ft[1]) * 0.3048 + (ft[2] ? num(ft[2]) * 0.0254 : 0);
  if (t.includes('"')) return num(t.replace(/".*/, '')) * 0.0254;
  const cm = t.match(/([\d.,]+)\s*cm/);
  if (cm) return Number(cm[1].replace(',', '.')) / 100;
  const mm = t.match(/([\d.,]+)\s*mm/);
  if (mm) return Number(mm[1].replace(',', '.')) / 1000;
  return null;
}

export function formatPrice(v: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: v % 1 === 0 ? 0 : 2 }).format(v);
  } catch {
    return `$${v}`;
  }
}
