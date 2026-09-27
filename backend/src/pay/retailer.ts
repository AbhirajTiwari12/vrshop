import crypto from 'node:crypto';
import express from 'express';
import { authorize } from './acceptance.js';
import { checkMandate, findMandate, storeSlug } from './mandate.js';
import { keyDirectory, TAG_PAY, verifyContainer, verifyRequest, type PaymentContainer } from './tap.js';
import type { AuthResult } from './acceptance.js';
import type { OrderStep } from '../types.js';

const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Simulated retailer checkout endpoints (one per store: /retailer/<store>/checkout). What a merchant that accepts
// trusted AI agents would run: verify the agent's TAP signature against the agent key directory, check the order
// against the shopper's mandate, then authorize the card with Visa Acceptance as the merchant of record.
// Fulfilment is simulated; the signature checks and the Visa authorization are real.

export interface RetailerOrder {
  mandateId: string;
  orderId: string;
  store: string;
  amount: number;
  currency: string;
  items: { productId: string; title: string; qty: number; unitPrice: number }[];
  agenticPaymentContainer?: PaymentContainer;
  dryRun?: boolean; // tamper demo: verify only, never authorize
}

export interface RetailerResponse {
  ok: boolean;
  reason?: string;
  merchantOrderId?: string;
  steps: OrderStep[];
  tap: { verified: boolean; reason?: string; keyId?: string; nonce?: string; tag?: string };
  payment?: AuthResult;
}

// The merchant's view of the key directory. A real merchant would fetch and cache the agent's JWKS by keyid.
const resolveKey = (kid: string) => keyDirectory().keys.find((k) => k.kid === kid);

export const retailerRouter = express.Router();

retailerRouter.post('/:store/checkout', async (req, res) => {
  const steps: OrderStep[] = [];
  const step = (label: string, ok: boolean, detail?: string) => steps.push({ at: Date.now(), label, ok, detail });
  const body = req.body as RetailerOrder;
  const store = body?.store ?? String(req.params.store);

  const v = verifyRequest(
    { authority: String(req.headers.host ?? ''), path: req.baseUrl + req.path, signatureInput: req.header('signature-input'), signature: req.header('signature') },
    { expectTag: TAG_PAY, resolveKey },
  );
  step(v.ok ? 'Verified the agent’s Visa TAP signature' : 'Rejected: agent signature check failed', v.ok, v.ok ? `Ed25519 · key ${v.keyId?.slice(0, 10)}… · tag ${v.tag}` : v.reason);
  if (!v.ok) return void res.status(401).json({ ok: false, reason: v.reason, steps, tap: { verified: false, ...v } } satisfies RetailerResponse);

  const pcProblem = verifyContainer(body.agenticPaymentContainer, v.nonce, resolveKey) ?? (body.agenticPaymentContainer?.mandateId !== body.mandateId ? 'Payment container is for a different mandate' : null);
  step(pcProblem ? 'Rejected: payment container check failed' : 'Verified the agentic payment container', !pcProblem, pcProblem ?? `Visa •••• ${body.agenticPaymentContainer!.cardMetadata.lastFour} · PAR ${body.agenticPaymentContainer!.cardMetadata.paymentAccountReference.slice(0, 10)}… · nonce bound to signature`);
  if (pcProblem) return void res.status(401).json({ ok: false, reason: pcProblem, steps, tap: { verified: true, ...v } } satisfies RetailerResponse);

  const amount = Math.round(Number(body.amount) * 100) / 100;
  const sum = Math.round((body.items ?? []).reduce((a, i) => a + i.unitPrice * i.qty, 0) * 100) / 100;
  if (!(amount > 0) || Math.abs(sum - amount) > 0.01) {
    step('Rejected: order total doesn’t match its items', false, `items ${usd(sum)} vs charged ${usd(amount)}`);
    return void res.status(400).json({ ok: false, reason: 'Order total mismatch', steps, tap: { verified: true, ...v } } satisfies RetailerResponse);
  }

  const mandate = findMandate(body.mandateId);
  const problem = checkMandate(mandate, store, amount);
  step(problem ? 'Rejected: outside the shopper’s mandate' : 'Order is within the shopper’s mandate', !problem, problem ?? `${usd(amount)} ≤ ${usd(mandate!.merchants.find((m) => storeSlug(m.store) === storeSlug(store))!.cap)} approved for ${store} · mandate ${mandate!.id}`);
  if (problem) return void res.status(403).json({ ok: false, reason: problem, steps, tap: { verified: true, ...v } } satisfies RetailerResponse);

  if (body.dryRun) {
    step('Dry run: no payment taken', true);
    return void res.json({ ok: true, steps, tap: { verified: true, ...v } } satisfies RetailerResponse);
  }

  const payment = await authorize({ reference: body.orderId, amount, currency: body.currency || 'USD', merchantName: store, mandateId: body.mandateId });
  step(
    payment.ok ? `Visa authorization ${payment.status}` : `Visa authorization ${payment.status}`,
    payment.ok,
    [payment.provider === 'visa_acceptance' ? 'Visa Acceptance sandbox' : 'simulated', payment.id && `id ${payment.id}`, payment.approvalCode && `approval ${payment.approvalCode}`, payment.message].filter(Boolean).join(' · '),
  );
  const merchantOrderId = payment.ok ? `${store.slice(0, 3).toUpperCase()}-${crypto.randomInt(100000, 999999)}` : undefined;
  if (merchantOrderId) step('Order confirmed by the retailer', true, `order ${merchantOrderId} · fulfilment simulated`);
  res.status(payment.ok ? 200 : 402).json({ ok: payment.ok, reason: payment.ok ? undefined : payment.message ?? payment.status, merchantOrderId, steps, tap: { verified: true, ...v }, payment } satisfies RetailerResponse);
});
