// Find out which catalog products have an official IKEA 3D model (free; ~8 parallel HEAD requests). The answer is
// stored on each product, so this only checks new ones unless --force. DEMO_3D_ONLY=on then offers only those.
//   npm run catalog:check-3d            check products not checked yet
//   npm run catalog:check-3d -- --force re-check everything
import { allInventory } from '../src/inventory/inventory.js';
import { checkOfficialModels } from '../src/inventory/official3d.js';

const t0 = Date.now();
const r = await checkOfficialModels(allInventory(), {
  force: process.argv.includes('--force'),
  onProgress: (done, total, found) => console.log(`  ${done}/${total} checked, ${found} with official 3D`),
});
console.log(`\nChecked ${r.checked} (${r.found} with official 3D; ${r.unknown} unanswered, run again later) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const byCat = new Map<string, { has: number; total: number }>();
for (const p of allInventory().filter((p) => p.source === 'ikea')) {
  const c = byCat.get(p.category) ?? { has: 0, total: 0 };
  c.total++;
  if (p.officialModel) c.has++;
  byCat.set(p.category, c);
}
console.log('\nIKEA products with an official 3D model, by category:');
for (const [cat, c] of [...byCat.entries()].sort((a, b) => b[1].has - a[1].has)) console.log(`  ${cat.padEnd(14)} ${String(c.has).padStart(4)} / ${c.total}`);
process.exit(0);
