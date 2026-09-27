// End-to-end check against a running backend: npm run smoke [-- http://host:8787]
const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const j = async (path: string, init?: RequestInit) => {
  const r = await fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const health = await j('/api/health');
console.log('health', health.capabilities, health.baseUrl);
let s = await j('/api/sessions/demo', { method: 'POST', body: JSON.stringify({ prompt: 'Warm japandi living room with oak and linen', budget: 2000 }) });
console.log('session', s.id);
for (let i = 0; i < 60 && s.status !== 'ready' && s.status !== 'error'; i++) { await sleep(2000); s = await j(`/api/sessions/${s.id}`); process.stdout.write(`\r  ${s.status}: ${s.stage}          `); }
console.log(`\nstatus ${s.status}, ${s.categories.length} categories`);
for (const c of s.categories) console.log(`  ${c.label.padEnd(16)} ${c.productIds.length} products  e.g. ${s.products[c.productIds[0]]?.title}`);

const cat = await j('/api/catalog');
console.log(`catalog: ${cat.total} products from ${cat.stores} stores${cat.total ? '' : '  (run `npm run catalog:pull` first)'}; shopping ${cat.shopping.provider}, ${cat.shopping.callsThisMonth}/${cat.shopping.monthlyLimit} calls this month`);
for (const text of ['black leather sofa under 1500', 'anything cheaper?', 'what is the cheapest one']) {
  const a = await j(`/api/sessions/${s.id}/ask`, { method: 'POST', body: JSON.stringify({ text }) });
  console.log(`  ask "${text}" -> ${a.browse?.total ?? 0} matches: ${a.reply}`);
}

// Visa agent checkout: put two picks in the cart, approve, wait for the agent.
for (const c of s.categories.slice(0, 2)) await j(`/api/sessions/${s.id}/cart`, { method: 'POST', body: JSON.stringify({ productId: c.productIds[0], qty: 1 }) });
const quote = await j(`/api/sessions/${s.id}/checkout/quote`);
console.log(`checkout: $${quote.total} from ${quote.groups.length} store(s), Visa ${quote.visa.acceptance}, ${quote.visa.card.label}`);
await j(`/api/sessions/${s.id}/checkout`, { method: 'POST', body: JSON.stringify({ via: 'phone', allowOverBudget: true }) });
let co: any;
for (let i = 0; i < 40; i++) { await sleep(700); co = (await j(`/api/sessions/${s.id}`)).checkout; if (co.status !== 'running') break; }
console.log(`  ${co.status}: ${co.summary}`);
for (const o of co.orders) console.log(`  ${o.store}: ${o.status} ${o.payment?.provider ?? ''} ${o.payment?.id ?? ''}`);
for (const mode of ['valid', 'signature', 'replay', 'over_mandate']) {
  const t = await j('/api/visa/tamper', { method: 'POST', body: JSON.stringify({ mode }) });
  console.log(`  TAP ${mode}: ${t.accepted ? 'accepted' : `rejected (${t.reason})`}`);
}

const picks = s.categories.map((c: any) => c.productIds[0]).filter(Boolean).slice(0, 5);
for (const id of picks) await j(`/api/products/${id}/model`, { method: 'POST', body: JSON.stringify({ generate: false }) });
for (let i = 0; i < 30; i++) {
  const ps = await Promise.all(picks.map((id: string) => j(`/api/products/${id}`)));
  if (ps.every((p: any) => p.model.status === 'ready' || p.model.status === 'failed')) { ps.forEach((p: any) => console.log(`  model ${p.id}: ${p.model.status} ${p.model.kind ?? ''} ${p.model.bytes ?? ''} B ${JSON.stringify(p.dims)}`)); break; }
  await sleep(1000);
}
const geo = {
  floorY: 0, ceilingHeight: 2.6,
  floorPolygon: [{ x: -2, z: -1 }, { x: 2.2, z: -1 }, { x: 2.2, z: 4 }, { x: -2, z: 4 }],
  walls: [], objects: [{ label: 'SCREEN', center: { x: 0.1, y: 1.2, z: 3.95 }, size: { x: 1.2, y: 0.7, z: 0.08 }, yawDeg: 180 }],
};
await j(`/api/sessions/${s.id}/geometry`, { method: 'POST', body: JSON.stringify(geo) });
const lay = await j(`/api/sessions/${s.id}/layout`, { method: 'POST', body: JSON.stringify({ productIds: picks }) });
for (const p of lay.placements) console.log(`  place ${p.productId.padEnd(16)} (${p.position.x}, ${p.position.z}) yaw ${p.yawDeg}°  ${p.reason}`);
console.log('\nOK — open', `${health.baseUrl}/#/s/${s.id}`);
