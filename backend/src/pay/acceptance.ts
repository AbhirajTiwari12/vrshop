import crypto from 'node:crypto';
import { config } from '../config.js';
import { fetchWithTimeout } from '../util/http.js';
import { log, errMsg } from '../util/log.js';

// Visa Acceptance Solutions (Cybersource) REST API, sandbox. Every request is authenticated with an HTTP Signature:
// HMAC-SHA256 (shared secret) over host, date, request-target, body digest and merchant id.
// Authorizations are sent with capture=false: the card is authorized for the store subtotal, nothing is settled.
// Without keys we fall back to a simulator whose results are clearly labelled "simulated".

export const acceptanceLive = () => !!(config.visa.merchantId && config.visa.keyId && config.visa.secret);

export interface AuthResult {
  provider: 'visa_acceptance' | 'simulated';
  ok: boolean;
  id?: string;
  status: string;               // AUTHORIZED | DECLINED | INVALID_REQUEST | ...
  approvalCode?: string;
  reconciliationId?: string;
  message?: string;
}

function signedHeaders(method: 'GET' | 'POST', resource: string, body: string) {
  const { host, merchantId, keyId, secret } = config.visa;
  const date = new Date().toUTCString();
  const digest = `SHA-256=${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}`;
  const withBody = method === 'POST';
  // Matches the official cybersource-rest-client-node signer (HTTPSigToken.js): "date" (not v-c-date) and
  // "request-target" without parentheses; digest only for requests with a body.
  const headerNames = withBody ? 'host date request-target digest v-c-merchant-id' : 'host date request-target v-c-merchant-id';
  const signingString = [
    `host: ${host}`,
    `date: ${date}`,
    `request-target: ${method.toLowerCase()} ${resource}`,
    ...(withBody ? [`digest: ${digest}`] : []),
    `v-c-merchant-id: ${merchantId}`,
  ].join('\n');
  const signature = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(signingString, 'utf8').digest('base64');
  return {
    'v-c-merchant-id': merchantId,
    Date: date, // fetch sets Host from the URL, which is the signed host
    ...(withBody ? { Digest: digest, 'Content-Type': 'application/json;charset=utf-8' } : {}),
    Signature: `keyid="${keyId}", algorithm="HmacSHA256", headers="${headerNames}", signature="${signature}"`,
  };
}

async function call(method: 'GET' | 'POST', resource: string, payload?: unknown): Promise<{ status: number; data: any }> {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const res = await fetchWithTimeout(`https://${config.visa.host}${resource}`, {
    method,
    timeoutMs: 30000,
    headers: signedHeaders(method, resource, body),
    body: method === 'POST' ? body : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 300) }; }
  return { status: res.status, data };
}

export interface AuthorizeInput {
  reference: string;            // our order id; shows up in the Visa Acceptance merchant portal
  amount: number;
  currency: string;
  merchantName: string;         // the retailer this authorization is for (demo: one sandbox merchant for all)
  mandateId: string;
}

export async function authorize(input: AuthorizeInput): Promise<AuthResult> {
  if (!acceptanceLive()) return simulateAuthorize(input);
  const c = config.visa.card;
  const payload = {
    clientReferenceInformation: { code: input.reference, comments: `VRShop agent checkout · ${input.merchantName} · mandate ${input.mandateId}` },
    processingInformation: { capture: false, commerceIndicator: 'internet' },
    paymentInformation: { card: { number: c.number, expirationMonth: c.expMonth, expirationYear: c.expYear, securityCode: c.cvv } },
    orderInformation: {
      amountDetails: { totalAmount: input.amount.toFixed(2), currency: input.currency },
      billTo: config.visa.billTo,
    },
  };
  try {
    const { status, data } = await call('POST', '/pts/v2/payments', payload);
    const st = String(data?.status ?? (status >= 400 ? 'ERROR' : 'UNKNOWN'));
    const ok = status === 201 && st === 'AUTHORIZED';
    log.info('visa', `authorize ${input.reference} $${input.amount} -> HTTP ${status} ${st} ${data?.id ?? ''}`);
    return {
      provider: 'visa_acceptance',
      ok,
      id: data?.id,
      status: st,
      approvalCode: data?.processorInformation?.approvalCode,
      reconciliationId: data?.reconciliationId,
      message: ok ? undefined : errorText(data, status),
    };
  } catch (e) {
    log.warn('visa', `authorize failed: ${errMsg(e)}`);
    return { provider: 'visa_acceptance', ok: false, status: 'ERROR', message: errMsg(e) };
  }
}

/** Release an authorization (order cancelled after the fact). */
export async function reverse(id: string, amount: number, currency: string, reference: string): Promise<AuthResult> {
  if (!acceptanceLive() || id.startsWith('SIM')) return { provider: 'simulated', ok: true, id: `SIMREV${crypto.randomInt(1e9)}`, status: 'REVERSED' };
  try {
    const { status, data } = await call('POST', `/pts/v2/payments/${encodeURIComponent(id)}/reversals`, {
      clientReferenceInformation: { code: reference },
      reversalInformation: { amountDetails: { totalAmount: amount.toFixed(2), currency }, reason: 'Customer cancelled the order' },
    });
    const st = String(data?.status ?? `HTTP ${status}`);
    return { provider: 'visa_acceptance', ok: status === 201 && st === 'REVERSED', id: data?.id, status: st, message: data?.errorInformation?.message ?? data?.message };
  } catch (e) {
    return { provider: 'visa_acceptance', ok: false, status: 'ERROR', message: errMsg(e) };
  }
}

export interface LinkResult { provider: 'visa_acceptance' | 'simulated'; ok: boolean; id?: string; url?: string; status?: string; message?: string }

/** Visa Acceptance Pay by Link: a hosted checkout page anyone can pay (the roommate's share). */
export async function createPaymentLink(input: { reference: string; amount: number; currency: string; items: { name: string; sku: string; qty: number; unitPrice: number }[] }): Promise<LinkResult> {
  if (!acceptanceLive()) {
    const id = `SIMLINK${crypto.randomInt(1e9)}`;
    return { provider: 'simulated', ok: true, id, url: `/pay/sim/${id}?amount=${input.amount.toFixed(2)}`, status: 'ACTIVE', message: 'Simulated: add Visa Acceptance sandbox keys (with Pay by Link enabled) for a real link' };
  }
  try {
    const { status, data } = await call('POST', '/ipl/v2/payment-links', {
      clientReferenceInformation: { code: input.reference },
      processingInformation: { linkType: 'PURCHASE', requestPhone: false, requestShipping: false },
      purchaseInformation: { purchaseNumber: input.reference.replace(/[^A-Za-z0-9]/g, '').slice(-20) }, // letters and digits only
      orderInformation: {
        amountDetails: { totalAmount: input.amount.toFixed(2), currency: input.currency },
        lineItems: input.items.map((i) => ({ productName: i.name.slice(0, 60), productSku: i.sku.slice(0, 30), quantity: i.qty, unitPrice: i.unitPrice.toFixed(2) })),
      },
    });
    const url = data?.purchaseInformation?.paymentLink;
    return { provider: 'visa_acceptance', ok: status === 201 && !!url, id: data?.id, url, status: data?.status, message: url ? undefined : errorText(data, status) };
  } catch (e) {
    return { provider: 'visa_acceptance', ok: false, message: errMsg(e) };
  }
}

/** "Field validation errors (orderInformation.lineItems[0].productSku: INVALID)" */
function errorText(data: any, status: number): string {
  const base = data?.errorInformation?.message ?? data?.message ?? data?.reason ?? `HTTP ${status}`;
  const details: any[] = data?.details ?? data?.errorInformation?.details ?? [];
  return details.length ? `${base} (${details.map((d) => `${d.field}: ${d.reason ?? d.message ?? ''}`).join('; ')})` : base;
}

function simulateAuthorize(input: AuthorizeInput): AuthResult {
  // Sandbox-style behaviour so the demo can also show a decline: amounts ending in .13 decline.
  const declined = Math.round(input.amount * 100) % 100 === 13;
  return {
    provider: 'simulated',
    ok: !declined,
    id: `SIM${Date.now()}${crypto.randomInt(1000, 9999)}`,
    status: declined ? 'DECLINED' : 'AUTHORIZED',
    approvalCode: declined ? undefined : String(crypto.randomInt(100000, 999999)),
    reconciliationId: String(crypto.randomInt(1e9, 9e9)),
    message: declined ? 'Simulated decline' : 'Simulated: add Visa Acceptance sandbox keys for a real authorization',
  };
}
