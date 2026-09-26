import { config } from '../config.js';
import { searchIkea } from '../search/ikea.js';
import { searchShopping } from '../search/serp.js';
import { mapLimit } from '../util/http.js';
import { log } from '../util/log.js';
import { colorsFromImage } from './attributes.js';
import { addProducts, allInventory, hasQuery, inventoryStats, markPulled, queryKey, recordQuery, setImageColors } from './inventory.js';

// One-time bulk pull that fills the local catalog. IKEA is free and returns its whole result set in one call, so
// it gets broad queries. Google Shopping (Serper.dev / SerpAPI) returns ~40 listings per paid call with no
// pagination, so we spread over material / style variants to get variety across stores.

interface PlanRow { category: string; ikea: string[]; shopping: string[] }

// shopping[0] is the "light" tier; the rest are added in the "full" tier.
export const PULL_PLAN: PlanRow[] = [
  { category: 'sofa', ikea: ['sofa', 'sectional', 'sleeper sofa'], shopping: ['sofa', 'leather sofa', 'velvet sofa', 'sectional sofa', 'modern sofa couch'] },
  { category: 'armchair', ikea: ['armchair'], shopping: ['accent chair', 'leather armchair', 'boucle accent chair'] },
  { category: 'coffee_table', ikea: ['coffee table'], shopping: ['coffee table', 'wood coffee table', 'marble coffee table'] },
  { category: 'side_table', ikea: ['side table'], shopping: ['side table', 'end table'] },
  { category: 'rug', ikea: ['rug'], shopping: ['area rug 8x10', 'area rug 5x8', 'jute rug'] },
  { category: 'floor_lamp', ikea: ['floor lamp'], shopping: ['floor lamp', 'arc floor lamp'] },
  { category: 'table_lamp', ikea: ['table lamp'], shopping: ['table lamp'] },
  { category: 'bookshelf', ikea: ['bookcase'], shopping: ['bookshelf', 'wood bookcase'] },
  { category: 'tv_stand', ikea: ['tv unit'], shopping: ['tv stand', 'media console'] },
  { category: 'dining_table', ikea: ['dining table'], shopping: ['dining table', 'round dining table'] },
  { category: 'dining_chair', ikea: ['dining chair'], shopping: ['dining chairs'] },
  { category: 'desk', ikea: ['desk'], shopping: ['desk', 'standing desk'] },
  { category: 'office_chair', ikea: ['office chair'], shopping: ['office chair'] },
  { category: 'bed', ikea: ['bed frame'], shopping: ['bed frame', 'upholstered bed frame'] },
  { category: 'nightstand', ikea: ['nightstand'], shopping: ['nightstand'] },
  { category: 'dresser', ikea: ['dresser', 'sideboard'], shopping: ['dresser', 'sideboard buffet'] },
  { category: 'cabinet', ikea: ['cabinet', 'wardrobe'], shopping: ['storage cabinet'] },
  { category: 'ottoman', ikea: ['ottoman', 'pouf'], shopping: ['ottoman'] },
  { category: 'bench', ikea: ['bench'], shopping: ['entryway bench'] },
  { category: 'plant', ikea: ['artificial plant'], shopping: ['artificial plant tall'] },
  { category: 'wall_art', ikea: ['wall art', 'picture'], shopping: ['wall art'] },
  { category: 'mirror', ikea: ['mirror'], shopping: ['wall mirror', 'floor mirror'] },
];

export type PullTier = 'none' | 'light' | 'full';

export interface PullOptions {
  shopping: PullTier;           // how many paid Google Shopping queries to run
  categories?: string[];        // default: all
  ikeaSize?: number;            // IKEA listings per query (free)
  imageColors?: boolean;        // guess colors from photos when the title has none (free, slower)
  force?: boolean;              // re-run queries pulled in the last 14 days
  onProgress?: (msg: string) => void;
}

export function planShoppingQueries(o: Pick<PullOptions, 'shopping' | 'categories'>) {
  if (o.shopping === 'none' || config.shopping.provider === 'none') return [];
  return PULL_PLAN.filter((r) => !o.categories?.length || o.categories.includes(r.category))
    .flatMap((r) => (o.shopping === 'light' ? r.shopping.slice(0, 1) : r.shopping).map((q) => ({ category: r.category, q })));
}

export interface PullStatus { running: boolean; startedAt?: number; finishedAt?: number; message: string; added: number; shoppingCalls: number; error?: string }
export const pullStatus: PullStatus = { running: false, message: 'idle', added: 0, shoppingCalls: 0 };

export async function pullCatalog(o: PullOptions) {
  if (pullStatus.running) throw new Error('A catalog pull is already running');
  Object.assign(pullStatus, { running: true, startedAt: Date.now(), finishedAt: undefined, message: 'starting', added: 0, shoppingCalls: 0, error: undefined });
  const say = (m: string) => { pullStatus.message = m; o.onProgress?.(m); log.info('catalog', m); };
  try {
    const rows = PULL_PLAN.filter((r) => !o.categories?.length || o.categories.includes(r.category));

    // 1) IKEA (free): broad queries, big pages.
    const ikeaJobs = rows.flatMap((r) => r.ikea.map((q) => ({ category: r.category, q })));
    let done = 0;
    await mapLimit(ikeaJobs, 3, async (j) => {
      const key = queryKey('ikea', j.q);
      if (!o.force && hasQuery(key)) { done++; return; }
      const found = await searchIkea(j.q, o.ikeaSize ?? 300);
      const { added, kept } = addProducts(found, j.category);
      recordQuery(key, kept.length, 'pull');
      pullStatus.added += added;
      say(`IKEA ${++done}/${ikeaJobs.length}: "${j.q}" → ${kept.length} kept (${found.length - kept.length} parts/other skipped)`);
    });

    // 2) Google Shopping (paid per call): many stores.
    const shopJobs = planShoppingQueries(o);
    done = 0;
    await mapLimit(shopJobs, 3, async (j) => {
      const key = queryKey(config.shopping.provider, j.q);
      if (!o.force && hasQuery(key)) { done++; return; }
      const found = await searchShopping(j.q, { limit: 100 });
      pullStatus.shoppingCalls++;
      const { added, kept } = addProducts(found, j.category);
      recordQuery(key, kept.length, 'pull');
      pullStatus.added += added;
      say(`Google Shopping ${++done}/${shopJobs.length}: "${j.q}" → ${kept.length} kept`);
    });

    // 3) Colors from product photos for listings whose text names none (free; IKEA always names colors).
    if (o.imageColors !== false) {
      const todo = allInventory().filter((p) => !p.attrs?.colors.length && !p.attrs?.colorFromImage && (!o.categories?.length || o.categories.includes(p.category)));
      let n = 0, hit = 0;
      await mapLimit(todo, 8, async (p) => {
        const colors = await colorsFromImage(p.imageUrl);
        if (colors.length) { setImageColors(p.id, colors); hit++; }
        if (++n % 50 === 0 || n === todo.length) say(`Photo colors ${n}/${todo.length} (${hit} found)`);
      });
    }

    markPulled();
    const st = inventoryStats();
    say(`Done: ${st.total} products from ${st.stores} stores (+${pullStatus.added} new, ${pullStatus.shoppingCalls} Google Shopping calls)`);
  } catch (e) {
    pullStatus.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    pullStatus.running = false;
    pullStatus.finishedAt = Date.now();
  }
}
