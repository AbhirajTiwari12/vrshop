import fs from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from '../config.js';

// Paid-search meter. Every Google Shopping call (Serper.dev or SerpAPI) is counted per calendar month so live
// searches stop before the free tier runs out. The bulk pull is explicit and prints its planned cost instead.

const FILE = path.join(DATA_DIR, 'usage.json');
type Usage = Record<string, Record<string, number>>; // month -> provider -> calls

function read(): Usage {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) as Usage; } catch { return {}; }
}

const month = () => new Date().toISOString().slice(0, 7);

export function recordShoppingCall(provider: string, n = 1) {
  const u = read();
  const m = (u[month()] ??= {});
  m[provider] = (m[provider] ?? 0) + n;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(u, null, 1));
}

export function shoppingCallsThisMonth(provider = config.shopping.provider): number {
  return read()[month()]?.[provider] ?? 0;
}

/** Live (per-question) searches allowed right now? The bulk pull does not use this. */
export function liveSearchBudgetLeft(): number {
  if (config.shopping.provider === 'none') return 0;
  return Math.max(0, config.shopping.monthlyLiveLimit - shoppingCallsThisMonth());
}
