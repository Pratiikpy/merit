# @merit/verify

Gate any payment on whether the work is actually correct.

[Merit](https://onmerit.xyz) is a verification-first payment layer on Arc (Circle's stablecoin L1): a claim and
its cited source go through a deterministic numeric gate, an NLI factual-consistency check, and an adversarial
judge, and come back as a **keccak256-signed verdict**. This SDK is the one-line integration — designed so the
guarantees are contracts, not conventions.

```ts
import { MeritClient } from "@merit/verify";

const merit = new MeritClient({ failureMode: "fail-closed" }); // REQUIRED: pre-commit your outage behavior

// The paved path: pay only if the work verifies — and the verdict is BOUND to this exact payment.
const { paid } = await merit.verifyThenPay({
  claim: "TollBit works with roughly 7,000 publisher sites.",
  source: "TollBit has onboarded roughly 7,000 publisher sites and raised $31M.",
  amount: 0.002,
  payee: "0xCreatorWallet",
  pay: async (verdict) => sendUsdc(verdict.binding!.payee, verdict.binding!.amount),
});
```

## Why this SDK is different

- **`failureMode` is a required constructor argument** (`fail-open` | `fail-closed` | `last-good-verdict`).
  You decide at design time what happens when the verifier is unreachable — an outage can never silently flip
  a deployed agent's payment behavior. Synthesized verdicts are clearly labeled `merit.sdk.synthetic/v1`.
- **Signatures are checked locally.** `verifyLocal` recovers the signer with viem over the canonical verdict
  body and compares it to a pinned or discovered (`/api/verify/signer`, rotation-safe) address. You never trust
  a boolean over the wire.
- **The payment binding is server-signed.** Ask for a verdict with `amount` + `payee` and the server folds
  `bindingHash = keccak256(canonical {amount, payee, claim, sourceHash})` *inside the signed body*.
  `verifyThenPay` recomputes it before your `pay` callback runs — a receipt for $5 to payee A can never
  authorize $50 to payee B.

## API

- `new MeritClient({ failureMode, baseUrl?, apiKey?, trustedSigner?, lastGoodTtlMs? })`
- `verify(claim, source, { sourceIsUrl?, amount?, payee?, depth? })` → signed `Verdict`
- `verifyLocal(verdict, expected?)` → `{ ok, signed, signerOk, bindingOk, reason }`
- `verifyThenPay({ claim, source, amount, payee, pay })` → runs `pay` only on a locally-checked SUPPORTED
- `gate({ claim, citedPassage | citedURL, tollUsdc?, publisher? })` → the citation-toll `release`/`refuse` gate
- `computeBindingHash(amount, payee, claim, sourceHash)` — the versioned binding spec, recomputable anywhere

## For coding agents

The whole SDK is one dependency-free-except-viem file. If you'd rather paste than install, take
[`llms.txt`](./llms.txt) — it contains the complete source and the integration contract.

Verification is keyless (real verdicts, no signup). Settling tiers take an API key from
[onmerit.xyz](https://onmerit.xyz). Apache-2.0.
