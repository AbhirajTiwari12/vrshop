# VRShop × Visa: Reimagine Shopping with Generative AI

**One line:** talk to an AI shopper while you stand in your own room in VR, see true-scale 3D versions of real products
in it, then approve once and let an AI agent **buy the whole room on Visa rails**: signed with Visa Trusted Agent
Protocol, capped by a spending mandate, and authorized through Visa Acceptance.

## The journey, stage by stage

| Stage | What VRShop does | Where |
|---|---|---|
| **Discovery** | Photograph the room, and AI plans what it needs. Or just talk: "black leather sofa under $1,500". Answers come from thousands of real listings (IKEA, Amazon, Wayfair and others). | `ai/designer.ts`, `ai/assistant.ts`, `inventory/` |
| **Personalization** | Picks are ranked for your room's style, palette and free space. Lighting is matched to the room. | `ai/designer.ts` |
| **Decision-making** | See the real product at true scale in your room: walk around it and fit-check it against your furniture. Ask "what's the cheapest?", "how much is the second one?" or "anything cheaper?", and the numbers come from real listings, never invented by the model. | Unity app, `ai/assistant.ts` |
| **Budget management** | The room budget follows you everywhere. If the cart goes over, the **AI budget coach** finds cheaper look-alikes (same kind of piece, same color/material) with one-tap swaps. | `pay/quote.ts` |
| **Checkout** | **Buy the room**: approve once (a trigger press in the headset, or one tap on the phone). An AI agent then checks out at every retailer. | `pay/agent.ts` |
| **Payments (trust + security)** | Each order is signed with **Visa Trusted Agent Protocol**, checked against the shopper's **mandate** (the budget is the cap), and authorized with **Visa Acceptance**. | `pay/tap.ts`, `pay/mandate.ts`, `pay/retailer.ts`, `pay/acceptance.ts` |
| **Post-purchase** | Live per-store receipts (Visa authorization id, approval code), one-tap **cancel = Visa reversal**, and **split with a roommate** via Visa Pay by Link. | phone cart, `pay/agent.ts` |

## Visa technology used

| Visa product | Status | What it does here |
|---|---|---|
| **Visa Acceptance (Cybersource) REST API**: `POST /pts/v2/payments`, `/reversals` | **Real** with sandbox keys. The HTTP Signature signer was verified live against the sandbox: authorization `AUTHORIZED`, then reversal `REVERSED`. Without keys it falls back to a clearly labelled simulator. | The retailer authorizes the agent's order with `capture: false`. Cancel reverses it. |
| **Visa Acceptance Pay by Link**: `POST /ipl/v2/payment-links` | Real request shape. It needs Pay by Link enabled on the sandbox merchant; otherwise the app falls back to a labelled simulated link. | A roommate pays their share on a hosted Visa page. |
| **Visa Trusted Agent Protocol** | **Real protocol**, our own verifier. | Covered below. |
| **Visa Intelligent Commerce** payment instruction | Shape only. Enforcement is local, because VIC credentials are gated. | The shopper's approval is rendered exactly as a VIC `/vacp/v1/instructions` payload: `declineThreshold` = what each merchant may charge, `effectiveUntilTime` = the 15-minute expiry, MCC 5712. Open "View as a Visa Intelligent Commerce instruction" on the receipt. |

How TAP is used:
- The agent signs every checkout request with **Ed25519 RFC 9421 HTTP message signatures**:
  - covers `@authority` and `@path`;
  - an 8-minute window;
  - a single-use nonce;
  - the tag `agent-payer-auth`.
- Each order also carries a signed **agentic payment container** (card last four and PAR, never the card number), bound
  to the same nonce.
- The retailers verify against the agent's public **JWKS** at `/.well-known/jwks`.

### Try to break it (tamper demo)

In the cart's "How the agent is trusted" panel, each button sends a deliberately broken agent order to a retailer.
Every attack is rejected with a precise reason:

| Attack | Retailer says |
|---|---|
| Valid agent order | accepted (dry run, no charge) |
| Forged signature | Signature does not verify for this merchant and path |
| Expired signature | Signature expired N s ago |
| Replayed request | Nonce already used: replayed request |
| Signed for another store | Signature does not verify for this merchant and path |
| Unknown agent key | Unknown agent key (not in the key directory) |
| Browsing tag used to pay | Wrong tag "agent-browser-auth": this endpoint needs "agent-payer-auth" |
| Stolen payment container | Payment container nonce doesn't match the request signature |
| Charge over the mandate | $899.00 exceeds the $500.00 approved for Demo Store |
| Unsigned bot | Missing Signature-Input / Signature headers (not a trusted agent) |

## How a "buy the room" order flows

```
Shopper (Quest trigger / phone tap)
  └─ approve once ──► Mandate { cap = room budget, per-store caps = subtotals, expires 15 min }   (VIC-shaped)
                        │
AI agent, per retailer: ├─ check the order against the mandate
                        ├─ sign the request: Visa TAP (Ed25519, RFC 9421, tag agent-payer-auth, nonce)
                        ├─ attach the signed agentic payment container (last four + PAR, same nonce)
                        └─ POST /retailer/<store>/checkout
Retailer (simulated):   ├─ verify the TAP signature against the agent JWKS (window, nonce, tag, authority/path)
                        ├─ verify the payment container
                        ├─ check the mandate (per-store cap, total cap, expiry)
                        └─ Visa Acceptance: POST /pts/v2/payments (capture=false) ──► AUTHORIZED + approval code
Receipts ──► headset + phone, live. Cancel ──► /pts/v2/payments/{id}/reversals
```

## Setup (5 minutes)

1. Create a Visa Acceptance sandbox account: https://developer.visaacceptance.com/hello-world/sandbox.html
2. Go to Business Center → Payment Configuration → Key Management → **Generate key** → **REST – Shared Secret**.
3. Put the merchant id, key id and secret in `backend/.env`:
   - `VISA_ACCEPTANCE_MERCHANT_ID`
   - `VISA_ACCEPTANCE_KEY_ID`
   - `VISA_ACCEPTANCE_SECRET_KEY`
4. Optional: enable Pay by Link on the sandbox merchant for real roommate links.
5. Run `npm run smoke`. The checkout lines should say `visa_acceptance` with a real transaction id, which then shows up
   in the sandbox Business Center under Transaction Management.

The demo card is Visa's published sandbox test card, `4111 1111 1111 1111`. No real card is ever used.

## Demo script (Visa beats, about 90 s inside the 3-minute demo)

1. **Discover by voice.** In the headset, hold X: *"black leather sofa under fifteen hundred"*. Then *"what's the
   cheapest?"*, then *"add the second one to my cart"*.
2. **Budget coach.** Add a pricey rug. Now *"buy the room"*. The Visa panel opens: $180 over budget. Press **Swap, save
   $300**, and it's back under.
3. **Approve once.** Press Approve with Visa (haptic). Watch the agent go store by store:
   - it checks the mandate;
   - it signs with TAP;
   - the retailer verifies;
   - Visa **AUTHORIZED** with an approval code.

   Then the toast: *"Room bought: 2 stores, $1,412 of $1,500 via Visa Acceptance."*
4. **Trust.** On the phone, tap **Forged signature**, **Replayed request** and **Charge over the mandate**. All are
   rejected.
5. **Post-purchase.** Split with Sam gives a Pay by Link. Cancel one order gives a Visa reversal.

## Honesty (say this in the pitch)

- **Real:**
  - Visa Acceptance sandbox authorizations and reversals (with keys);
  - TAP signatures and verification;
  - mandate enforcement;
  - the product catalog and 3D models.
- **Simulated:**
  - the retailers' checkout endpoints and fulfilment. We run them, one sandbox merchant authorizes for all stores, and
    authorizations are never captured;
  - the VIC instruction, which is shown in VIC's format but not sent (VIC access is gated);
  - Pay by Link, unless it is enabled on the merchant.
