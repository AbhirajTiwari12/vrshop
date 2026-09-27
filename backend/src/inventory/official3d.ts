import { ikeaModelStatus } from '../search/ikea.js';
import { mapLimit, sleep } from '../util/http.js';
import type { Product } from '../types.js';
import { inventoryProduct, saveInventory, setOfficialModel } from './inventory.js';

// Which products have an official (IKEA) 3D model. Checking is a free HEAD request to IKEA's CDN; the answer is stored
// on the catalog product so each item is only ever checked once (npm run catalog:check-3d fills it for the whole catalog).

/** Official model available? Uses the stored answer, otherwise asks IKEA and stores a definite answer (on `p` too).
 *  IKEA rate-limits bursts (429): an unanswered check returns false for now but stays unchecked, so it's retried later. */
export async function hasOfficialModel(p: Product): Promise<boolean> {
  return (await officialModelStatus(p)) === true;
}

async function officialModelStatus(p: Product): Promise<boolean | null> {
  if (p.source !== 'ikea' || !p.ikeaItemNo) return false;
  const known = p.officialModel ?? inventoryProduct(p.id)?.officialModel;
  if (known !== undefined) return (p.officialModel = known);
  const has = await ikeaModelStatus(p.ikeaItemNo);
  if (has === null) return null;
  setOfficialModel(p.id, has);
  return (p.officialModel = has);
}

/** Check every product that hasn't been checked yet (or all of them with `force`). */
export async function checkOfficialModels(ps: Product[], opts: { force?: boolean; onProgress?: (done: number, total: number, found: number) => void } = {}) {
  const todo = ps.filter((p) => p.source === 'ikea' && p.ikeaItemNo && (opts.force || p.officialModel === undefined));
  if (opts.force) for (const p of todo) p.officialModel = undefined;
  let done = 0, found = 0, unknown = 0;
  let pauseUntil = 0; // shared: one 429 slows every worker down
  await mapLimit(todo, 3, async (p) => {
    let status: boolean | null = null;
    for (let attempt = 0; attempt < 5 && status === null; attempt++) {
      if (Date.now() < pauseUntil) await sleep(pauseUntil - Date.now());
      status = await officialModelStatus(p);
      if (status === null) pauseUntil = Math.max(pauseUntil, Date.now() + 5000 * 2 ** attempt);
    }
    if (status) found++;
    if (status === null) unknown++;
    if (++done % 100 === 0 || done === todo.length) opts.onProgress?.(done, todo.length, found);
  });
  saveInventory(true);
  return { checked: todo.length - unknown, found, unknown };
}

/** Keep only products with an official model (checking unknown ones first). */
export async function withOfficialModels(ps: Product[]): Promise<Product[]> {
  const ok = await Promise.all(ps.map(hasOfficialModel));
  return ps.filter((_, i) => ok[i]);
}
