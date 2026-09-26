export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
  }
}

export interface FetchOpts extends RequestInit {
  timeoutMs?: number;
  retries?: number;
}

export async function fetchWithTimeout(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { timeoutMs = 20000, retries = 0, ...init } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (res.status >= 500 && attempt < retries) {
        lastErr = new HttpError(res.status, `HTTP ${res.status} for ${url}`);
        await sleep(400 * (attempt + 1));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

export async function fetchJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await fetchWithTimeout(url, opts);
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} for ${redact(url)}: ${text.slice(0, 300)}`, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(res.status, `Invalid JSON from ${redact(url)}: ${text.slice(0, 200)}`, text);
  }
}

export async function fetchBuffer(url: string, opts: FetchOpts = {}): Promise<Buffer> {
  const res = await fetchWithTimeout(url, { timeoutMs: 60000, ...opts });
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} downloading ${redact(url)}`);
  return Buffer.from(await res.arrayBuffer());
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Strip API keys from URLs before logging. */
export function redact(url: string): string {
  return url.replace(/(api_key|key|token)=[^&]+/gi, '$1=***');
}

/** Run async tasks with bounded concurrency, preserving input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
