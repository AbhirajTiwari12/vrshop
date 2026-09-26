import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..');
export const DATA_DIR = path.resolve(ROOT_DIR, process.env.DATA_DIR || 'data');
export const PUBLIC_DIR = path.resolve(ROOT_DIR, 'public');

const env = (k: string, d = '') => (process.env[k] ?? d).trim();

export type GenProvider = 'fal' | 'meshy' | 'tripo' | 'none';

function pickGenProvider(): GenProvider {
  const wanted = env('GEN_PROVIDER', 'auto').toLowerCase();
  const has = { fal: !!env('FAL_KEY'), meshy: !!env('MESHY_API_KEY'), tripo: !!env('TRIPO_API_KEY') };
  if (wanted === 'none') return 'none';
  if (wanted === 'fal' || wanted === 'meshy' || wanted === 'tripo') return has[wanted] ? wanted : 'none';
  if (has.fal) return 'fal';
  if (has.meshy) return 'meshy';
  if (has.tripo) return 'tripo';
  return 'none';
}

export type ShoppingProvider = 'serper' | 'serpapi' | 'none';

function pickShoppingProvider(): ShoppingProvider {
  const wanted = env('SHOPPING_PROVIDER', 'auto').toLowerCase();
  const has = { serper: !!env('SERPER_API_KEY'), serpapi: !!env('SERPAPI_KEY') };
  if (wanted === 'none') return 'none';
  if (wanted === 'serper' || wanted === 'serpapi') return has[wanted] ? wanted : 'none';
  if (has.serper) return 'serper'; // 2,500 free queries, then ~$1 / 1k
  if (has.serpapi) return 'serpapi'; // 250 free / month, then ~$15-25 / 1k
  return 'none';
}

export const config = {
  port: Number(env('PORT', '8787')),
  publicBaseUrl: env('PUBLIC_BASE_URL').replace(/\/$/, ''),
  openai: {
    key: env('OPENAI_API_KEY'),
    model: env('OPENAI_MODEL', 'gpt-6-luna'),
    visionModel: env('OPENAI_VISION_MODEL', 'gpt-6-sol'),
    transcribeModel: env('OPENAI_TRANSCRIBE_MODEL', 'gpt-transcribe'),
    baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
  },
  serpapiKey: env('SERPAPI_KEY'),
  serperKey: env('SERPER_API_KEY'),
  shopping: {
    provider: pickShoppingProvider(),
    // Voice/typed questions search live stores only when the pulled catalog has fewer matches than this.
    liveMode: (env('LIVE_SEARCH', 'fallback').toLowerCase() === 'off' ? 'off' : 'fallback') as 'off' | 'fallback',
    liveMinResults: Number(env('LIVE_MIN_RESULTS', '6')),
    // Hard stop for live Google Shopping calls per calendar month (the bulk pull is counted too).
    monthlyLiveLimit: Number(env('SHOPPING_MONTHLY_LIMIT', '200')),
  },
  ikea: { country: env('IKEA_COUNTRY', 'us'), lang: env('IKEA_LANG', 'en') },
  gen: {
    provider: pickGenProvider(),
    falKey: env('FAL_KEY'),
    falModel: env('FAL_MODEL', 'trellis2'),
    meshyKey: env('MESHY_API_KEY'),
    tripoKey: env('TRIPO_API_KEY'),
  },
};

export function lanAddress(): string {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return 'localhost';
}

/** Base URL that devices on the network (Quest, phone) should use. */
export function baseUrl(): string {
  return config.publicBaseUrl || `http://${lanAddress()}:${config.port}`;
}

export function capabilities() {
  return {
    openai: !!config.openai.key,
    serpapi: config.shopping.provider !== 'none', // "Google Shopping available" (via Serper.dev or SerpAPI)
    shopping: config.shopping.provider,
    ikea: true,
    generator: config.gen.provider,
  };
}
