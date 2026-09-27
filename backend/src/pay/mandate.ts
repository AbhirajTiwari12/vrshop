import crypto from 'node:crypto';
import { listSessions } from '../store.js';
import type { Mandate } from '../types.js';

const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Mandate registry: plays the role of the network-side record of what the shopper approved (Visa Intelligent
// Commerce keeps this with the tokenized credential). Merchants check every agent order against it.

const ephemeral = new Map<string, Mandate>(); // tamper-demo mandates, not tied to a session

export const newMandateId = () => `mdt_${crypto.randomBytes(8).toString('hex')}`;

export function findMandate(id: string): Mandate | undefined {
  if (ephemeral.has(id)) return ephemeral.get(id);
  for (const s of listSessions()) {
    if (s.checkout?.mandate.id === id) return s.checkout.mandate;
    const past = s.pastCheckouts?.find((c) => c.mandate.id === id);
    if (past) return past.mandate;
  }
  return undefined;
}

export function registerEphemeral(m: Mandate) {
  ephemeral.set(m.id, m);
  setTimeout(() => ephemeral.delete(m.id), 30 * 60e3).unref();
}

/**
 * The same approval expressed as a Visa Intelligent Commerce payment instruction (POST /vacp/v1/instructions, shape
 * from github.com/visa/ai). VIC needs issued credentials, so we enforce the mandate locally and show this payload.
 */
export function vicInstruction(m: Mandate) {
  return {
    clientReferenceId: m.id,
    appInstance: { applicationName: 'VRShop', countryCode: 'US', userAgent: m.approval.via === 'headset' ? 'VRShop/Quest' : 'VRShop/Web', deviceData: { type: m.approval.via === 'headset' ? 'HEADSET' : 'MOBILE' } },
    consumerId: `vrshop-${m.sessionId}`,
    tokenId: `vts-token-for-visa-${m.card.last4}`,
    assuranceData: [{ verificationType: 'DEVICE', verificationEntity: '10', verificationEvents: ['01'], verificationMethod: '02', verificationResults: '01', verificationTimestamp: String(Math.floor(m.approval.at / 1000)) }],
    mandates: m.merchants.map((x) => ({
      mandateId: `${m.id}-${storeSlug(x.store)}`,
      preferredMerchantName: x.store,
      merchantCategory: 'Home Furnishings',
      merchantCategoryCode: '5712', // furniture stores
      declineThreshold: { amount: x.cap.toFixed(2), currencyCode: m.currency },
      effectiveUntilTime: String(Math.floor(m.expiresAt / 1000)),
      quantity: String(x.items.reduce((a, i) => a + i.qty, 0)),
      description: x.items.map((i) => i.title).join('; ').slice(0, 250),
    })),
    consumerPrompt: m.approval.text,
    // Our extension: the room budget as an overall cap across merchants.
    totalDeclineThreshold: { amount: m.totalCap.toFixed(2), currencyCode: m.currency },
  };
}

export const storeSlug = (store: string) => store.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'store';

/** Would this merchant order stay inside the mandate? Returns the reason it wouldn't. */
export function checkMandate(m: Mandate | undefined, store: string, amount: number): string | null {
  if (!m) return 'Unknown mandate';
  if (m.status === 'revoked') return 'Mandate revoked by the shopper';
  if (Date.now() > m.expiresAt) return 'Mandate expired';
  if (m.status !== 'active') return `Mandate is ${m.status}`;
  const merchant = m.merchants.find((x) => storeSlug(x.store) === storeSlug(store));
  if (!merchant) return `${store} is not a merchant this mandate allows`;
  if (amount > merchant.cap + 0.005) return `${usd(amount)} exceeds the ${usd(merchant.cap)} approved for ${merchant.store}`;
  if (m.spent + amount > m.totalCap + 0.005) return `${usd(amount)} would take the total past the ${usd(m.totalCap)} cap`;
  return null;
}
