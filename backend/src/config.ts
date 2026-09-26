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
    serpapi: !!config.serpapiKey,
    ikea: true,
    generator: config.gen.provider,
  };
}
