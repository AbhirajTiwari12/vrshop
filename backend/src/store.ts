import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import type { Product, Session } from './types.js';

// Tiny JSON-file store. Fine for a hackathon: one process, a few hundred records.
const DB_FILE = path.join(DATA_DIR, 'db.json');

export const dirs = {
  uploads: path.join(DATA_DIR, 'uploads'),
  models: path.join(DATA_DIR, 'models'),
  raw: path.join(DATA_DIR, 'raw'),
  img: path.join(DATA_DIR, 'img'),
};
for (const d of [DATA_DIR, ...Object.values(dirs)]) fs.mkdirSync(d, { recursive: true });

interface Db { sessions: Record<string, Session>; products: Record<string, Product> }

const db: Db = load();

function load(): Db {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) as Db;
    // Jobs that were mid-flight when the server stopped will never finish; reset them.
    for (const p of Object.values(parsed.products ?? {})) {
      if (p.model.status === 'queued' || p.model.status === 'processing') p.model = { status: 'none' };
    }
    for (const s of Object.values(parsed.sessions ?? {})) {
      if (s.status === 'analyzing' || s.status === 'searching') {
        s.status = 'error';
        s.error = 'Server restarted during processing';
      }
    }
    return { sessions: parsed.sessions ?? {}, products: parsed.products ?? {} };
  } catch {
    return { sessions: {}, products: {} };
  }
}

let saveTimer: NodeJS.Timeout | null = null;
export function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 250);
}

export function newId(len = 6): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const hash = (s: string, n = 12) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);

// ---- sessions ----
export function saveSession(s: Session) {
  s.updatedAt = Date.now();
  db.sessions[s.id] = s;
  persist();
  return s;
}
export const getSession = (id: string) => db.sessions[id];
export function listSessions(): Session[] {
  return Object.values(db.sessions).sort((a, b) => b.createdAt - a.createdAt);
}

// ---- products ----
export function upsertProduct(p: Product): Product {
  const existing = db.products[p.id];
  if (existing) {
    // keep model state + enrichment we already paid for
    p.model = existing.model.status !== 'none' ? existing.model : p.model;
    p.dims = existing.dims ?? p.dims;
    p.dimsSource = existing.dimsSource ?? p.dimsSource;
    if (existing.storeLinkResolved) {
      p.productUrl = existing.productUrl;
      p.storeLinkResolved = true;
    }
  }
  db.products[p.id] = p;
  persist();
  return p;
}
export const getProduct = (id: string) => db.products[id];
export function updateProduct(id: string, patch: Partial<Product>) {
  const p = db.products[id];
  if (!p) return undefined;
  Object.assign(p, patch);
  // Clients poll sessions with ?since=updatedAt; bump the sessions that show this product so
  // model progress (queued -> ready) and resolved store links reach them.
  const now = Date.now();
  for (const s of Object.values(db.sessions)) {
    if (s.categories.some((c) => c.productIds.includes(id)) || s.cart.some((c) => c.productId === id) || s.placements.some((pl) => pl.productId === id)) s.updatedAt = now;
  }
  persist();
  return p;
}
