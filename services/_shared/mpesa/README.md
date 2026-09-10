# services/_shared/mpesa

Daraja (M-Pesa) adapter. **Owner: Arsema (Payments + integrity).**

Lives in `_shared/` because the interface is a boundary two services reason
about — Payments calls it, Commission is forbidden from calling it — but only
`services/payments` may import it. See [ADR-002](../../../docs/adrs/ADR-002-idempotency-and-replay-safety.md).

| File | What it is |
|---|---|
| `interface.js` | The contract. Typedefs, result codes, error classes. No implementation. |
| `fake.js` | Deterministic in-process fake. What CI and k6 run against. |
| `signature.js` | HMAC-SHA256 callback auth, shared by signer and verifier. |
| `index.js` | `createMpesaClient()` — picks the implementation from `MPESA_MODE`. |
| `daraja.js` | Real sandbox wrapper. **Not written yet** (G3). |

## The interface

Four methods, matching the four Daraja calls the money path needs:

```js
const { createMpesaClient } = require('../../_shared/mpesa');
const mpesa = createMpesaClient();               // MPESA_MODE, defaults to fake

await mpesa.stkPush({ shortcode, amountMinor, msisdn, accountReference,
                      transactionDesc, callbackUrl });   // → StkPushResult
await mpesa.stkQuery({ shortcode, checkoutRequestId });  // → StkQueryResult
mpesa.verifyCallback(rawBody, headers);                  // → { valid, reason }
await mpesa.b2c({ shortcode, amountMinor, msisdn, remarks,
                  originatorConversationId });           // → B2CResult
```

`daraja.js` will export exactly this and nothing more, so nothing downstream
changes when it lands.

## Determinism

Outcome is a pure function of the request — no RNG, no wall clock (time is
injected via `options.now`), no network. Pick the path you want by picking the
payer's MSISDN:

| MSISDN | Constant | Behaviour |
|---|---|---|
| `254700000000` | `TEST_MSISDNS.SUCCESS` | accepted → success callback (`ResultCode: 0`) |
| `254700000001` | `TEST_MSISDNS.INSUFFICIENT_FUNDS` | accepted → callback `ResultCode: 1` |
| `254700000002` | `TEST_MSISDNS.CANCELLED` | accepted → callback `ResultCode: 1032` |
| `254700000003` | `TEST_MSISDNS.PUSH_TIMEOUT` | `stkPush` **throws** `MpesaTimeoutError` |
| `254700000004` | `TEST_MSISDNS.NO_CALLBACK` | accepted, then **silence** — needs reconcile |

Any other last digit behaves as success.

`checkoutRequestId`, `merchantRequestId` and the M-Pesa receipt are all SHA-256
derivations of the request, so a replayed push produces the *same* correlation
ids — which is exactly what makes replay-safety testable.

### Why 3 and 4 are different

Both leave the payment `pending`, and neither may ever produce `failed` — but
they are distinct failures to know something:

- **`PUSH_TIMEOUT` (3)** — we never learned whether the command was executed.
  The fake still records it in-flight, so a later `stkQuery` can settle it.
- **`NO_CALLBACK` (4)** — the command was accepted and then nothing came back.

`1032` (cancelled) and `1037` (no user response) look alike on the wire and
mean opposite things: 1032 is a decision, 1037 is silence. Silence is not a
decline. This distinction is the reason ADR-002 exists.

## Test-only helpers

Not part of `MpesaClient`; present on the fake only:

- `buildCallback(checkoutRequestId, overrides)` — the exact Daraja envelope
  (`Body.stkCallback`). Returns `null` for the two silent outcomes.
  `overrides` lets a test forge a wrong amount, a wrong id, or a bad result code.
- `signBody(body, atMs)` — `{ raw, headers }` signed as the transport would.
- `settle(checkoutRequestId, outcome)` — simulate a late reconciliation.
- `reset()` — clear in-flight state between tests.

## Callback authentication

`X-TillFlow-Signature: t=<unix>,v1=<hex hmac-sha256>` over `${t}.${rawBody}`,
constant-time compared, 300s tolerance.

**Daraja does not sign its callbacks.** This HMAC is applied at our own edge,
not by Safaricom — see the "Callback authenticity" section of
[docs/threat-model.md](../../../docs/threat-model.md) for what that does and
does not buy, and why the signature is never the only control.

## Rules

1. CI and k6 use `MPESA_MODE=fake`. Always. Abuse case 9 in the threat model.
2. `createMpesaClient()` **throws** rather than defaulting to the real sandbox,
   so a misconfigured job fails loudly instead of quietly reaching Safaricom.
3. Only `services/payments` imports this. Commission disburses via the Payments
   API — never directly. Enforced by CODEOWNERS and ADR-002.
4. Real credentials live in Secrets Manager (`devops-g10/daraja`), never in Git.
