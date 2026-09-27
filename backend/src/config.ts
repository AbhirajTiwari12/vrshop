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

const demo3dOnly = ['on', 'true', '1'].includes(env('DEMO_3D_ONLY', 'off').toLowerCase());

function pickGenProvider(): GenProvider {
  if (demo3dOnly) return 'none'; // demo mode never pays for generation (e.g. when an IKEA download fails)
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
    liveMinResults: Number(env('LIVE_MIN_RESULTS', '1')),
    // Hard stop for every Google Shopping call per calendar month (bulk pull, live top-ups, new rooms).
    monthlyLiveLimit: Number(env('SHOPPING_MONTHLY_LIMIT', '200')),
  },
  // Demo mode: only offer products with an official 3D model (IKEA); no paid searches, no paid 3D generation.
  demo3dOnly,
  ikea: { country: env('IKEA_COUNTRY', 'us'), lang: env('IKEA_LANG', 'en') },
  // Visa Acceptance (Cybersource) sandbox for real authorizations during agent checkout. Without keys: simulated.
  visa: {
    host: env('VISA_ACCEPTANCE_HOST', 'apitest.cybersource.com'),
    merchantId: env('VISA_ACCEPTANCE_MERCHANT_ID'),
    keyId: env('VISA_ACCEPTANCE_KEY_ID'),
    secret: env('VISA_ACCEPTANCE_SECRET_KEY'),
    // Card on file for the demo shopper: Visa's published sandbox test card (never a real card).
    card: {
      number: env('VISA_TEST_CARD_NUMBER', '4111111111111111'),
      expMonth: env('VISA_TEST_CARD_EXP_MONTH', '12'),
      expYear: env('VISA_TEST_CARD_EXP_YEAR', '2031'),
      cvv: env('VISA_TEST_CARD_CVV', '123'),
    },
    billTo: {
      firstName: env('VISA_BILLTO_FIRST', 'Alex'),
      lastName: env('VISA_BILLTO_LAST', 'Shopper'),
      address1: env('VISA_BILLTO_ADDRESS', '1 Market St'),
      locality: env('VISA_BILLTO_CITY', 'San Francisco'),
      administrativeArea: env('VISA_BILLTO_STATE', 'CA'),
      postalCode: env('VISA_BILLTO_ZIP', '94105'),
      country: env('VISA_BILLTO_COUNTRY', 'US'),
      email: env('VISA_BILLTO_EMAIL', 'test@cybs.com'),
    },
  },
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
