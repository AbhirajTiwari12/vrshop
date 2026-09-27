import crypto from 'node:crypto';
import { config } from '../config.js';
import { getSession, saveSession } from '../store.js';
import { log, errMsg } from '../util/log.js';
import { sleep } from '../util/http.js';
import { createPaymentLink, reverse } from './acceptance.js';
import { checkMandate, newMandateId, registerEphemeral, storeSlug } from './mandate.js';
import { buildQuote } from './quote.js';
import { paymentContainer, signRequest, TAG_BROWSE, TAG_PAY } from './tap.js';
import { visaStatus } from './visa.js';
import type { RetailerOrder, RetailerResponse } from './retailer.js';
import type { Checkout, Mandate, Order, OrderStep } from '../types.js';

const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// "Buy the room": after the shopper approves once (headset trigger or phone), the agent checks out at every retailer
// in the cart. Per store it: checks the order against the mandate, signs the request with Visa TAP, sends it to the
// retailer, and records the retailer's verification + the Visa authorization. The mandate caps total spend at the
// room budget, so the agent can't overspend even if a retailer asks for more.

const STEP_DELAY_MS = Number(process.env.CHECKOUT_STEP_DELAY_MS ?? 450); // pacing so the timeline is watchable in VR
const MANDATE_TTL_MS = 15 * 60e3;
const round2 = (v: number) => Math.round(v * 100) / 100;
const retailerBase = () => `http://127.0.0.1:${config.port}/retailer`;

const httpErr = (status: number, message: string) => Object.assign(new Error(message), { status });

export function startCheckout(sessionId: string, opts: { via: Mandate['approval']['via']; allowOverBudget?: boolean }): Checkout {
  const s = getSession(sessionId);
  if (!s) throw httpErr(404, 'Session not found');
  if (s.checkout?.status === 'running') throw httpErr(409, 'A checkout is already running');
  const q = buildQuote(s);
  if (!q.groups.length) throw httpErr(400, 'The cart is empty (or has no priced items)');
  if (q.overBy > 0 && !opts.allowOverBudget) throw httpErr(409, `The cart is ${usd(q.overBy)} over your budget. Apply the suggested swaps or approve the higher amount.`);

  // The cap is the room budget; only an explicit "approve the higher amount" raises it to the basket total.
  const totalCap = q.budget && !(q.overBy > 0 && opts.allowOverBudget) ? q.budget : q.total;
  const visa = visaStatus();
  const mandate: Mandate = {
    id: newMandateId(),
    sessionId,
    createdAt: Date.now(),
    expiresAt: Date.now() + MANDATE_TTL_MS,
    status: 'active',
    currency: q.currency,
    totalCap: round2(totalCap),
    spent: 0,
    merchants: q.groups.map((g) => ({ store: g.store, cap: g.subtotal, items: g.items.map(({ productId, title, qty, unitPrice }) => ({ productId, title, qty, unitPrice })) })),
    approval: { via: opts.via, at: Date.now(), text: `Buy ${q.groups.reduce((a, g) => a + g.items.length, 0)} items from ${q.groups.length} stores for up to ${usd(round2(totalCap))} with ${visa.card.label}` },
    card: visa.card,
  };
  const orders: Order[] = mandate.merchants.map((m) => ({
    id: `ord_${crypto.randomBytes(6).toString('hex')}`,
    mandateId: mandate.id,
    store: m.store,
    items: m.items,
    amount: m.cap,
    currency: q.currency,
    status: 'pending',
    steps: [],
    createdAt: Date.now(),
  }));
  const checkout: Checkout = { status: 'running', mandate, orders };
  saveSession({ ...s, checkout, pastCheckouts: [...(s.pastCheckouts ?? []), ...(s.checkout ? [s.checkout] : [])].slice(-5) });
  log.info('checkout', `${sessionId} mandate ${mandate.id}: $${mandate.totalCap} across ${orders.length} stores (${visa.acceptance})`);
  void runAgent(sessionId).catch((e) => log.error('checkout', errMsg(e)));
  return checkout;
}

/** Mutate the session's running checkout and persist (polling clients see each step). */
function update(sessionId: string, fn: (c: Checkout) => void) {
  const s = getSession(sessionId);
  if (!s?.checkout) return;
  const checkout = structuredClone(s.checkout);
  fn(checkout);
  saveSession({ ...getSession(sessionId)!, checkout });
}

function addStep(sessionId: string, orderId: string, step: Omit<OrderStep, 'at'>) {
  update(sessionId, (c) => c.orders.find((o) => o.id === orderId)?.steps.push({ at: Date.now(), ...step }));
}

async function runAgent(sessionId: string) {
  const first = getSession(sessionId)!.checkout!;
  for (const order of first.orders) {
    const c = getSession(sessionId)!.checkout!;
    const problem = checkMandate(c.mandate, order.store, order.amount);
    addStep(sessionId, order.id, { label: problem ? 'Agent stopped: order is outside the mandate' : 'Agent checked the order against your mandate', ok: !problem, detail: problem ?? `${usd(order.amount)} of ${usd((c.mandate.totalCap - c.mandate.spent))} remaining` });
    if (problem) { update(sessionId, (cc) => { cc.orders.find((o) => o.id === order.id)!.status = 'rejected'; }); continue; }
    await sleep(STEP_DELAY_MS);

    const url = `${retailerBase()}/${storeSlug(order.store)}/checkout`;
    const signed = signRequest(url, TAG_PAY);
    addStep(sessionId, order.id, { label: 'Agent signed the checkout with Visa Trusted Agent Protocol', ok: true, detail: `Ed25519 · RFC 9421 · ${new URL(url).host}${new URL(url).pathname} · valid ${Math.round((signed.params.expires - signed.params.created) / 60)} min` });
    update(sessionId, (cc) => { cc.orders.find((o) => o.id === order.id)!.tap = { keyId: signed.params.keyid, nonce: signed.params.nonce, tag: signed.params.tag, verified: false }; });
    await sleep(STEP_DELAY_MS);

    const payload: RetailerOrder = {
      mandateId: c.mandate.id, orderId: order.id, store: order.store, amount: order.amount, currency: order.currency, items: order.items,
      agenticPaymentContainer: paymentContainer(signed.params.nonce, c.mandate.card.last4, c.mandate.id),
    };
    let r: RetailerResponse;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Signature-Input': signed['Signature-Input'], Signature: signed.Signature }, body: JSON.stringify(payload) });
      r = (await res.json()) as RetailerResponse;
    } catch (e) {
      r = { ok: false, reason: `Retailer unreachable: ${errMsg(e)}`, steps: [], tap: { verified: false } };
    }
    update(sessionId, (cc) => {
      const o = cc.orders.find((x) => x.id === order.id)!;
      o.steps.push(...r.steps);
      o.tap = { ...o.tap!, verified: r.tap.verified, reason: r.tap.reason };
      o.merchantOrderId = r.merchantOrderId;
      if (r.payment) o.payment = { provider: r.payment.provider, id: r.payment.id, status: r.payment.status, approvalCode: r.payment.approvalCode, reconciliationId: r.payment.reconciliationId, message: r.payment.message };
      o.status = r.ok ? 'authorized' : r.payment ? 'declined' : r.tap.verified ? 'rejected' : 'error';
      if (r.ok) cc.mandate.spent = round2(cc.mandate.spent + o.amount);
    });
    // Bought items leave the cart (they're in the order now).
    const cur = getSession(sessionId)!;
    if (r.ok) saveSession({ ...cur, cart: cur.cart.filter((ci) => !order.items.some((it) => it.productId === ci.productId)) });
    await sleep(STEP_DELAY_MS);
  }
  update(sessionId, (c) => {
    const ok = c.orders.filter((o) => o.status === 'authorized');
    c.status = ok.length === c.orders.length ? 'done' : ok.length ? 'partial' : 'failed';
    c.mandate.status = 'completed';
    const via = c.orders.some((o) => o.payment?.provider === 'visa_acceptance') ? 'Visa Acceptance' : 'Visa (simulated)';
    c.summary = ok.length
      ? `Room bought: ${ok.length} of ${c.orders.length} store${c.orders.length === 1 ? '' : 's'}, ${usd(c.mandate.spent)} of ${usd(c.mandate.totalCap)} approved, via ${via}.`
      : 'Nothing was bought: every retailer declined or rejected the order.';
  });
  log.info('checkout', `${sessionId}: ${getSession(sessionId)!.checkout!.summary}`);
}

/** Cancel one order after the fact: reverse its Visa authorization and give the amount back to the mandate. */
export async function voidOrder(sessionId: string, orderId: string): Promise<Order> {
  const s = getSession(sessionId);
  const o = s?.checkout?.orders.find((x) => x.id === orderId);
  if (!s || !o) throw httpErr(404, 'Order not found');
  if (o.status !== 'authorized' || !o.payment?.id) throw httpErr(409, `Order is ${o.status}; only authorized orders can be cancelled`);
  const r = await reverse(o.payment.id, o.amount, o.currency, o.id);
  update(sessionId, (c) => {
    const x = c.orders.find((y) => y.id === orderId)!;
    x.steps.push({ at: Date.now(), label: r.ok ? 'Cancelled: Visa authorization reversed' : 'Cancel failed', ok: r.ok, detail: [r.provider === 'visa_acceptance' ? 'Visa Acceptance sandbox' : 'simulated', r.id, r.message].filter(Boolean).join(' · ') });
    if (r.ok) { x.status = 'voided'; x.payment = { ...x.payment!, reversalId: r.id }; c.mandate.spent = round2(c.mandate.spent - x.amount); }
  });
  return getSession(sessionId)!.checkout!.orders.find((y) => y.id === orderId)!;
}

// ------------------------------------------------------------------------------------------ split with a roommate

/** Ask a roommate to pay their share of the room with a Visa Acceptance Pay by Link page. */
export async function splitWithRoommate(sessionId: string, to: string, share: number) {
  const s = getSession(sessionId);
  if (!s) throw httpErr(404, 'Session not found');
  const bought = s.checkout && s.checkout.status !== 'running' ? s.checkout.orders.filter((o) => o.status === 'authorized') : [];
  const items = bought.length ? bought.flatMap((o) => o.items) : buildQuote(s).groups.flatMap((g) => g.items);
  const total = items.reduce((a, i) => a + i.unitPrice * i.qty, 0);
  if (!(total > 0)) throw httpErr(400, 'Nothing to split yet');
  const f = Math.min(1, Math.max(0.05, share || 0.5));
  const amount = round2(total * f);
  const reference = `split${Date.now().toString(36)}`;
  let link = await createPaymentLink({ reference, amount, currency: 'USD', items: [{ name: `${Math.round(f * 100)}% of our room (${items.length} pieces)`, sku: 'VRSHOP-ROOM', qty: 1, unitPrice: amount }] });
  let note = link.message;
  if (!link.ok && link.provider === 'visa_acceptance') {
    // e.g. Pay by Link not enabled on this sandbox merchant: keep the demo going, say why.
    note = `Visa Acceptance: ${link.message}. Showing a simulated link.`;
    link = { provider: 'simulated', ok: true, id: `SIMLINK${crypto.randomInt(1e9)}`, url: `/pay/sim/${reference}?amount=${amount.toFixed(2)}` };
  }
  const split = { id: link.id ?? reference, createdAt: Date.now(), to: to || 'Roommate', amount, url: link.url!, provider: link.provider, note };
  saveSession({ ...getSession(sessionId)!, splits: [...(getSession(sessionId)!.splits ?? []), split].slice(-10) });
  return split;
}

// ------------------------------------------------------------------------------------------ tamper demo

export const TAMPER_MODES = ['valid', 'signature', 'expired', 'replay', 'wrong_merchant', 'unknown_key', 'wrong_tag', 'stolen_container', 'over_mandate', 'unsigned'] as const;
export type TamperMode = (typeof TAMPER_MODES)[number];

/**
 * Send a (deliberately broken) agent order to a demo retailer and return what the retailer said. Uses a throwaway
 * $500 mandate for "Demo Store" and dryRun, so nothing is ever charged.
 */
export async function tamperDemo(mode: TamperMode): Promise<{ mode: TamperMode; accepted: boolean; reason?: string; steps: OrderStep[]; attempts?: number }> {
  const store = 'Demo Store';
  const mandate: Mandate = {
    id: newMandateId(), sessionId: 'demo', createdAt: Date.now(), expiresAt: Date.now() + 5 * 60e3, status: 'active', currency: 'USD', totalCap: 500, spent: 0,
    merchants: [{ store, cap: 500, items: [] }], approval: { via: 'phone', at: Date.now(), text: 'Tamper demo' }, card: visaStatus().card,
  };
  registerEphemeral(mandate);
  const amount = mode === 'over_mandate' ? 899 : 249;
  const url = `${retailerBase()}/${storeSlug(store)}/checkout`;
  const now = Math.floor(Date.now() / 1000);
  const signed =
    mode === 'expired' ? signRequest(url, TAG_PAY, { created: now - 900, expires: now - 420 })
      : mode === 'wrong_merchant' ? signRequest(url, TAG_PAY, { path: '/retailer/another-store/checkout' })
        : mode === 'unknown_key' ? signRequest(url, TAG_PAY, { keyid: crypto.randomBytes(32).toString('base64url') })
          : mode === 'wrong_tag' ? signRequest(url, TAG_BROWSE)
            : signRequest(url, TAG_PAY);
  const payload: RetailerOrder = {
    mandateId: mandate.id, orderId: `demo_${mode}`, store, amount, currency: 'USD', items: [{ productId: 'demo', title: 'Demo armchair', qty: 1, unitPrice: amount }], dryRun: true,
    // A container lifted from another request (different nonce) is rejected too.
    agenticPaymentContainer: paymentContainer(mode === 'stolen_container' ? crypto.randomBytes(32).toString('base64') : signed.params.nonce, mandate.card.last4, mandate.id),
  };
  let sig = signed.Signature;
  if (mode === 'signature') sig = sig.replace(/:(.)/, (_m, ch: string) => `:${ch === 'A' ? 'B' : 'A'}`);
  const send = async () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (mode !== 'unsigned') { headers['Signature-Input'] = signed['Signature-Input']; headers.Signature = sig; }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    return (await res.json()) as RetailerResponse;
  };
  let r = await send();
  let attempts = 1;
  if (mode === 'replay' && r.ok) { r = await send(); attempts = 2; }
  return { mode, accepted: r.ok, reason: r.reason, steps: r.steps, attempts };
}
