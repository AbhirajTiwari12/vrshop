import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

type JsonWebKey = { kty?: string; crv?: string; x?: string; [k: string]: unknown };

// Visa Trusted Agent Protocol (github.com/visa/trusted-agent-protocol): the shopping agent signs every request it
// sends to a merchant with an HTTP Message Signature (RFC 9421, Ed25519) that covers the merchant's authority and
// the path, with a short validity window, a single-use nonce and a tag that says what the agent is doing
// ("agent-browser-auth" while browsing, "agent-payer-auth" when paying). The merchant fetches the agent's public
// key from a key directory by keyid and verifies before it accepts the order.

export const TAG_BROWSE = 'agent-browser-auth';
export const TAG_PAY = 'agent-payer-auth';
export const MAX_WINDOW_S = 8 * 60; // TAP: signatures are short-lived (max 8 minutes)

interface AgentKey { keyId: string; privateKey: crypto.KeyObject; publicJwk: JsonWebKey & { kid: string } }

let cached: AgentKey | null = null;

/** The agent's Ed25519 keypair: TAP_PRIVATE_KEY (PEM) from .env, else generated once and kept in data/. */
export function agentKey(): AgentKey {
  if (cached) return cached;
  const file = path.join(DATA_DIR, 'tap-agent-key.pem');
  let pem = (process.env.TAP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim();
  if (!pem) {
    if (!fs.existsSync(file)) {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    pem = fs.readFileSync(file, 'utf8');
  }
  const privateKey = crypto.createPrivateKey(pem);
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  // keyid = RFC 7638 JWK thumbprint of the public key.
  const keyId = crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest('base64url');
  cached = { keyId, privateKey, publicJwk: { ...jwk, kid: keyId, use: 'sig', alg: 'EdDSA' } as JsonWebKey & { kid: string } };
  return cached;
}

/** Public key directory (JWKS) the merchant resolves keyids against, served at /.well-known/jwks. */
export function keyDirectory() {
  return { keys: [agentKey().publicJwk] };
}

export interface SignedHeaders { 'Signature-Input': string; Signature: string }
export interface SignParams { created: number; expires: number; keyid: string; nonce: string; tag: string }

const COMPONENTS = ['@authority', '@path'] as const;

// Parameter order and spelling follow the TAP spec's example (developer.visa.com TAP specifications).
function paramsString(p: SignParams): string {
  return `(${COMPONENTS.map((c) => `"${c}"`).join(' ')});created=${p.created};keyid="${p.keyid}";alg="Ed25519";expires=${p.expires};nonce="${p.nonce}";tag="${p.tag}"`;
}

/** RFC 9421 signature base over @authority and @path. */
export function signatureBase(authority: string, pathname: string, params: string): string {
  return `"@authority": ${authority.toLowerCase()}\n"@path": ${pathname}\n"@signature-params": ${params}`;
}

/** Sign a request URL for a merchant. `overrides` exist only for the tamper demo. */
export function signRequest(url: string, tag: string, overrides: Partial<SignParams> & { authority?: string; path?: string } = {}): SignedHeaders & { params: SignParams; base: string } {
  const u = new URL(url);
  const key = agentKey();
  const now = Math.floor(Date.now() / 1000);
  const params: SignParams = {
    created: overrides.created ?? now,
    expires: overrides.expires ?? now + MAX_WINDOW_S,
    keyid: overrides.keyid ?? key.keyId,
    nonce: overrides.nonce ?? crypto.randomBytes(32).toString('base64'),
    tag: overrides.tag ?? tag,
  };
  const ps = paramsString(params);
  const base = signatureBase(overrides.authority ?? u.host, overrides.path ?? u.pathname, ps);
  const sig = crypto.sign(null, Buffer.from(base, 'utf8'), key.privateKey).toString('base64');
  return { 'Signature-Input': `sig1=${ps}`, Signature: `sig1=:${sig}:`, params, base };
}

// ------------------------------------------------------------------------------------------ payment container

/**
 * TAP "agentic payment container" carried in the order body: card metadata (never the card number) bound to the
 * same nonce as the request signature, signed by the agent. The spec doesn't pin down the signed bytes yet
 * (visa/trusted-agent-protocol issue #23), so we sign the canonical JSON of the other fields.
 */
export interface PaymentContainer { nonce: string; cardMetadata: { lastFour: string; paymentAccountReference: string }; mandateId: string; kid: string; alg: 'Ed25519'; signature: string }

const canonical = (c: Omit<PaymentContainer, 'signature'>) => JSON.stringify({ nonce: c.nonce, cardMetadata: c.cardMetadata, mandateId: c.mandateId, kid: c.kid, alg: c.alg });

export function paymentContainer(nonce: string, lastFour: string, mandateId: string): PaymentContainer {
  const key = agentKey();
  const par = `V0010013018${crypto.createHash('sha256').update(`par:${lastFour}:${key.keyId}`).digest('hex').slice(0, 18).toUpperCase()}`;
  const body = { nonce, cardMetadata: { lastFour, paymentAccountReference: par }, mandateId, kid: key.keyId, alg: 'Ed25519' as const };
  return { ...body, signature: crypto.sign(null, Buffer.from(canonical(body)), key.privateKey).toString('base64') };
}

export function verifyContainer(c: PaymentContainer | undefined, headerNonce: string | undefined, resolveKey: (kid: string) => JsonWebKey | undefined): string | null {
  if (!c) return 'Missing agentic payment container';
  if (c.nonce !== headerNonce) return 'Payment container nonce doesn’t match the request signature';
  const jwk = resolveKey(c.kid);
  if (!jwk) return 'Payment container signed with an unknown key';
  try {
    const { signature, ...rest } = c;
    const ok = crypto.verify(null, Buffer.from(canonical(rest)), crypto.createPublicKey({ key: jwk as crypto.JsonWebKeyInput['key'], format: 'jwk' }), Buffer.from(signature, 'base64'));
    return ok ? null : 'Payment container signature invalid';
  } catch {
    return 'Payment container signature invalid';
  }
}

// ------------------------------------------------------------------------------------------ merchant side

const seenNonces = new Map<string, number>(); // nonce -> expiry (s)

function parseInput(h: string) {
  const m = h.match(/^\s*([\w-]+)=\(([^)]*)\)(.*)$/);
  if (!m) return null;
  const label = m[1];
  const components = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  const params: Record<string, string> = {};
  for (const pm of m[3].matchAll(/;\s*([\w-]+)=("([^"]*)"|[^;]+)/g)) params[pm[1]] = pm[3] ?? pm[2];
  return { label, components, params, raw: h.slice(h.indexOf('=') + 1).trim() };
}

export interface VerifyResult { ok: boolean; reason?: string; keyId?: string; nonce?: string; tag?: string }

/**
 * Merchant-side verification. `resolveKey` plays the role of the TAP key directory lookup.
 * Checks, in order: header shape, covered components, tag, window, known key, signature, nonce replay.
 */
export function verifyRequest(
  req: { authority: string; path: string; signatureInput?: string; signature?: string },
  opts: { expectTag: string; resolveKey: (kid: string) => JsonWebKey | undefined },
): VerifyResult {
  if (!req.signatureInput || !req.signature) return { ok: false, reason: 'Missing Signature-Input / Signature headers (not a trusted agent)' };
  const inp = parseInput(req.signatureInput);
  if (!inp) return { ok: false, reason: 'Malformed Signature-Input' };
  const { params, components } = inp;
  const base = { keyId: params.keyid, nonce: params.nonce, tag: params.tag };
  if (!COMPONENTS.every((c) => components.includes(c))) return { ...base, ok: false, reason: 'Signature must cover @authority and @path' };
  if (params.tag !== opts.expectTag) return { ...base, ok: false, reason: `Wrong tag "${params.tag}": this endpoint needs "${opts.expectTag}"` };
  const now = Math.floor(Date.now() / 1000);
  const created = Number(params.created), expires = Number(params.expires);
  if (!created || !expires || expires - created > MAX_WINDOW_S) return { ...base, ok: false, reason: `Validity window must be ≤ ${MAX_WINDOW_S / 60} minutes` };
  if (created > now + 30) return { ...base, ok: false, reason: 'Signature created in the future' };
  if (expires < now) return { ...base, ok: false, reason: `Signature expired ${now - expires} s ago` };
  const jwk = opts.resolveKey(params.keyid);
  if (!jwk) return { ...base, ok: false, reason: `Unknown agent key "${String(params.keyid).slice(0, 12)}…" (not in the key directory)` };
  const sigM = req.signature.match(new RegExp(`${inp.label}=:([^:]+):`));
  if (!sigM) return { ...base, ok: false, reason: `No signature labelled "${inp.label}"` };
  const signed = signatureBase(req.authority, req.path, inp.raw);
  let valid = false;
  try { valid = crypto.verify(null, Buffer.from(signed, 'utf8'), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sigM[1], 'base64')); } catch { valid = false; }
  if (!valid) return { ...base, ok: false, reason: 'Signature does not verify for this merchant and path (tampered, or signed for someone else)' };
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
  if (seenNonces.has(params.nonce)) return { ...base, ok: false, reason: 'Nonce already used: replayed request' };
  seenNonces.set(params.nonce, expires);
  return { ...base, ok: true };
}
