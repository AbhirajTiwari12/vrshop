import { CATEGORIES, categoryDef, pluralLabel } from '../catalog.js';
import { canonicalColor, canonicalMaterial, canonicalStyle } from './attributes.js';
import type { Filters } from '../types.js';

const SORTS = ['relevance', 'price_asc', 'price_desc', 'rating'] as const;
const KEYS = new Set(CATEGORIES.map((c) => c.key));

const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : typeof v === 'string' && Number(v) > 0 ? Number(v) : undefined);
const list = (v: unknown, map: (s: string) => string | undefined = (s) => s) =>
  Array.isArray(v) ? [...new Set(v.map((x) => map(String(x).trim().toLowerCase())).filter((x): x is string => !!x))] : [];

/** Sanitize filters from a client or the LLM: known categories, canonical colors/materials, positive numbers. */
export function normalizeFilters(raw: any): Filters {
  const f: Filters = {};
  if (!raw || typeof raw !== 'object') return f;
  const cat = String(raw.category ?? '').trim().toLowerCase();
  if (KEYS.has(cat)) f.category = cat;
  const keywords = list(raw.keywords).filter((k) => k.length > 1 && k.length < 40).slice(0, 4);
  const colors = list(raw.colors, canonicalColor);
  const materials = list(raw.materials, canonicalMaterial);
  const styles = list(raw.styles, canonicalStyle);
  const stores = list(raw.stores).slice(0, 6);
  if (keywords.length) f.keywords = keywords;
  if (colors.length) f.colors = colors;
  if (materials.length) f.materials = materials;
  if (styles.length) f.styles = styles;
  if (stores.length) f.stores = stores;
  f.minPrice = pos(raw.minPrice);
  f.maxPrice = pos(raw.maxPrice);
  if (f.minPrice && f.maxPrice && f.minPrice > f.maxPrice) [f.minPrice, f.maxPrice] = [f.maxPrice, f.minPrice];
  const r = pos(raw.minRating);
  if (r) f.minRating = Math.min(5, r);
  f.maxWidthM = pos(raw.maxWidthM);
  f.maxDepthM = pos(raw.maxDepthM);
  f.maxHeightM = pos(raw.maxHeightM);
  if (raw.only3d === true || raw.only3d === 'true') f.only3d = true;
  if (SORTS.includes(raw.sort)) f.sort = raw.sort;
  for (const k of Object.keys(f) as (keyof Filters)[]) if (f[k] === undefined) delete f[k];
  return f;
}

export const isEmpty = (f: Filters) => Object.keys(f).filter((k) => k !== 'sort').length === 0;

const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;

/** "black leather sofas under $800 from Wayfair" — used in replies and as the results heading. */
export function describeFilters(f: Filters, count?: number): string {
  const words = [
    ...(f.colors ?? []).slice(0, 2).join(' or ').split(' ').filter(Boolean),
    ...(f.styles ?? []).slice(0, 1),
    ...(f.keywords ?? []),
    ...(f.materials ?? []).slice(0, 2).join(' or ').split(' ').filter(Boolean),
  ];
  const noun = f.category ? (count === 1 ? categoryDef(f.category).label : pluralLabel(f.category)).toLowerCase() : count === 1 ? 'piece' : 'pieces';
  let s = [...words, noun].join(' ');
  if (f.minPrice && f.maxPrice) s += ` ${money(f.minPrice)}–${money(f.maxPrice)}`;
  else if (f.maxPrice) s += ` under ${money(f.maxPrice)}`;
  else if (f.minPrice) s += ` over ${money(f.minPrice)}`;
  const dims = [f.maxWidthM && `${Math.round(f.maxWidthM * 100)} cm wide`, f.maxDepthM && `${Math.round(f.maxDepthM * 100)} cm deep`, f.maxHeightM && `${Math.round(f.maxHeightM * 100)} cm tall`].filter(Boolean);
  if (dims.length) s += `, at most ${dims.join(' / ')}`;
  if (f.minRating) s += `, rated ${f.minRating}+`;
  if (f.stores?.length) s += ` from ${f.stores.join(' or ')}`;
  if (f.only3d) s += ' with official 3D models';
  return s;
}
