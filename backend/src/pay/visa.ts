import { config } from '../config.js';
import { acceptanceLive } from './acceptance.js';
import { agentKey } from './tap.js';

/** What the Visa layer is running on right now, shown in the apps so the demo is honest about it. */
export function visaStatus() {
  const live = acceptanceLive();
  return {
    acceptance: live ? ('sandbox' as const) : ('simulated' as const),
    acceptanceHost: live ? config.visa.host : null,
    tapKeyId: agentKey().keyId,
    card: { brand: 'Visa' as const, last4: config.visa.card.number.slice(-4), label: `Visa •••• ${config.visa.card.number.slice(-4)}` },
  };
}
