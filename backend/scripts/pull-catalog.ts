// Fill the local catalog once, then voice + filters search it for free.
//   npm run catalog:pull                     IKEA (free) + the "light" Google Shopping tier (1 query per category)
//   npm run catalog:pull -- --full           all Google Shopping query variants (~40 calls)
//   npm run catalog:pull -- --no-shopping    IKEA only, costs nothing
//   npm run catalog:pull -- --only sofa,rug  just some categories
//   npm run catalog:pull -- --force          re-run queries pulled in the last 14 days
//   npm run catalog:pull -- --yes            don't ask before paid calls
import readline from 'node:readline/promises';
import { config } from '../src/config.js';
import { planShoppingQueries, pullCatalog, type PullTier } from '../src/inventory/pull.js';
import { inventoryStats } from '../src/inventory/inventory.js';
import { shoppingCallsThisMonth } from '../src/inventory/usage.js';

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const shopping: PullTier = flag('--no-shopping') ? 'none' : flag('--full') ? 'full' : 'light';
const onlyIdx = args.indexOf('--only');
const categories = onlyIdx >= 0 ? args[onlyIdx + 1]?.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

const planned = planShoppingQueries({ shopping, categories });
const provider = config.shopping.provider;
console.log(`\nCatalog now: ${inventoryStats().total} products.`);
console.log(`IKEA: free.  Google Shopping: ${provider === 'none' ? 'no key (set SERPER_API_KEY or SERPAPI_KEY) — skipped' : `${planned.length} ${provider} calls planned (${shoppingCallsThisMonth()} used this month; queries pulled in the last 14 days are skipped)`}`);
if (planned.length && !flag('--yes') && process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ok = (await rl.question('Continue? [Y/n] ')).trim().toLowerCase();
  rl.close();
  if (ok === 'n' || ok === 'no') process.exit(0);
}

const t0 = Date.now();
await pullCatalog({ shopping, categories, force: flag('--force'), imageColors: !flag('--no-image-colors') });
const st = inventoryStats();
console.log(`\n${st.total} products, ${st.stores} stores in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log('By category:', st.byCategory);
console.log('By source:  ', st.bySource);
process.exit(0);
