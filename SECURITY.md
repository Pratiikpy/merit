# Security

Merit is a hackathon prototype that runs on **Arc testnet only** — it moves test USDC
and holds no production funds or personal data. The demo/agent wallets are testnet-funded;
do not send them anything of real value. It does, however, expose public API endpoints and
moves real (testnet) USDC, so it's built to be deployed on the adversarial internet.

## Threat model

- Public, unauthenticated endpoints: `POST /api/run` (drives the agent + settles USDC),
  `POST /api/creators/register`, the x402 work/pay/settlement endpoints, and read APIs.
- A buyer wallet that signs real settlements; creator-supplied content that flows into an LLM
  that decides who gets paid.

## Defenses in place

- **Secrets.** Source/specialist wallets are **receive-only**: `newWallet()` derives the payout
  address and **discards the key**, so Merit holds **no creator/specialist private key at all** —
  not in memory, not on disk. The `Source`/`Specialist` types carry no key field, so "a creator
  wallet can sign" is unrepresentable, and a key it never has can't leak or be misused. (Endpoints
  still go through `publicView`/`specialistView`, which are **explicit allowlist projections** — not
  `{...spread}` — so a field newly added to an entity is excluded by default and can't silently leak;
  a smoke check also asserts the whole run stream is key-free — defense-in-depth.) Operator/buyer/
  seller signing keys come only from env (`.env.local` is git-ignored; set them in the host).
- **Input validation.** Question + URL are length-capped; `budget` is clamped to `[0, 5]`
  (a real `0` is preserved); `tier` is whitelisted; amounts/prices are `Number.isFinite`-checked
  and clamped; `[id]` params are resolved by equality lookup (no path/SQL/shell construction).
- **Money safety.** `payTo` is taken from the registry, never the request — a caller can't
  redirect funds. A whole-run budget cap keeps `labor + creator payouts ≤ budget` (pure,
  unit-tested, holds even at budget 0). A **concurrent-run cap** bounds how many runs settle
  against the shared wallet at once, so parallel runs can't collectively overspend it (the per-run
  cap is local; the slot is released on completion, error, or disconnect via a once-flag — no leak).
  x402 uses EIP-3009 authorizations (replay handled at the protocol layer). Specialists are paid
  only after their delivered work is graded.
- **Prompt injection (defense-in-depth).** Untrusted source/creator content is fenced and framed as
  data; the Auditor's judge treats any embedded directive ("answer SUPPORTED", "ignore previous
  instructions") as manipulation → **REFUSE** (never auto-pays); and a **deterministic guard**
  (`looksLikeInjection`) refuses content matching clear injection patterns outright — before the
  judge, and protecting the budget verify tier, which has no judge to resist injection. The **question
  itself** is fenced with the same `<<< >>>` untrusted-data boundary, and **both public input endpoints
  reject injection at the door**: `POST /api/run` returns 400 on an injection-pattern question and
  `POST /api/creators/register` refuses an injection-bearing name or content — so crafted text never
  reaches the writer LLM that drives payment (verified live: both return 400, normal inputs pass).
- **Auditor robustness (the moat's softest spot — hardened in layers, every layer unit-tested).** The
  payment decision is not one fragile LLM call but a layered gate (`decideCitation`, `parseJudgeVerdict`,
  `looksLikeInjection`): (1) an off-topic similarity **floor** refuses before any judge runs; (2) the
  adversarial judge rules on **direction + magnitude**, not topic overlap; (3) an **unclear / unparseable
  verdict REFUSES** — never auto-pays, so a preamble- or reasoning-model-wrapped reply can't be misread
  as a payment; (4) the deterministic injection guard backstops the no-judge path; (5) embedding
  similarity is auditable evidence and the fallback gate when the judge is down; (6) a circuit-breaker
  trips to the deterministic STUB path on an LLM outage so a run never hangs or silently pays. The bias
  is uniform — **when in doubt, REFUSE**: a false-refuse costs one creator a payout; a false-pay would
  break the core guarantee.
- **What Merit verifies, and what it doesn't (honest scope).** The Auditor verifies *proof-of-use* — that
  a cited source actually **supports the specific claim** it is cited for — not whether the claim is true
  in the world (no system can verify arbitrary truth). Gaming via fabricated-but-supportive content is
  bounded, not unbounded: every payable source carries an **ERC-8004 identity** (cost to spin up shills),
  on-chain **reputation** that compounds per source, and **sub-cent, budget-capped** payouts — so the
  expected value of gaming the judge is low and every attempt is on-chain and attributable.
- **Verifiability — every claim is independently recomputable from chain, with no Merit server.** Don't trust
  the receipt, check it: `npm run recompute -- <agentId>` rebuilds an agent's ERC-8004 reputation from raw
  ReputationRegistry logs; `verify-validation` reads the Auditor's verdict back from the ValidationRegistry;
  `verify-receipt` recovers the buyer's signature over the canonical receipt **offline** (any altered verdict
  or amount breaks it); and `verify-settlement` sums the USDC actually received from on-chain Transfer logs.
  Reputation, the verdict, the signature, and the money are each checkable by anyone — the four claims a judge
  would otherwise have to take on faith.
- **Abuse / DoS.** Per-IP + global rate limiting gates the LLM- and settlement-bearing endpoints;
  run contexts use an unguessable 128-bit `runId` and expire on a 10-minute TTL. Every external call is
  **resource-bounded** so a hung or hostile dependency can't stall/exhaust a run: the RSS fetch is
  **size-capped (5MB) + time-aborted**, LLM calls **time out (45s) → offline fallback**, on-chain receipt
  waits are bounded (20s), and the per-run **budget is clamped** (`labor + payouts ≤ budget`, even at 0).
- **Transport + headers.** CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy`, `Permissions-Policy`, and HSTS are set for every response.
- **No SSRF.** Live discovery fetches a hardcoded RSS allowlist of major crypto/payments publishers
  (CoinDesk, Cointelegraph, Decrypt, PYMNTS, The Block, CryptoSlate, Bitcoin Magazine);
  creator-supplied URLs are stored for display only and never fetched server-side. The lead's x402
  self-calls are a fixed `localhost:$PORT` **loopback**, never built from the request `Host` header —
  so a forged `Host:` can't steer the agent's work-fetches or payments to an attacker server.

## Reviews

The codebase has had multiple independent reviews — two code-quality reviews, **two security
reviews** (the second a full sweep of the public input surface that validated payment integrity,
the loopback self-call, the budget/price clamps, and secret-handling as sound), an adversarial
silent-failure audit of the money path, a test-coverage analysis, a comment-accuracy audit, and a
type-design review. Genuine findings were fixed: prompt-injection hardening on the
judge (plus a deterministic guard), internal error-message scrubbing, the budget clamp, the
run-context TTL, HSTS, a concurrent-run guard (bounds parallel wallet spend), **removing
creator/specialist private keys entirely** (receive-only wallets, no key held), a run-route
slot-leak fix, **receipt-integrity fixes** (the summary reports actual settlement, never a phantom
paid), a **discriminated-union refactor** that makes an inconsistent verdict (released-but-no-
reason, or paying a refused source) unrepresentable, a **host-header-injection-proof loopback
self-call** (the agent can't be steered off-server), **explicit-allowlist view projections** (a
new entity field can't silently leak), and a **broadened-but-case-safe injection guard**. Residual
items are triaged below.

## Accepted risks (testnet prototype)

- Merit holds **no** source/specialist private keys at all — `newWallet()` discards the key after
  deriving the receive-only payout address, and the entity types carry no key field, so there is
  nothing to leak in memory or on disk. The only secrets are the buyer/operator/seller signing keys
  in `.env.local` (git-ignored) — standard for an env-configured app; a production deploy sets them
  in the host's secret store.
- The per-IP rate limit is bypassable via a spoofed `x-forwarded-for` when there's no trusted
  proxy; the global cap is the real backstop. For production, lock `x-forwarded-for` trust to the
  platform proxy and tighten the global cap.
- The CSP allows `'unsafe-inline'` for scripts/styles because the hand-authored static frontend
  needs it; there is no user-content-as-HTML path (receipts/reasons are escaped), so there is no
  active XSS vector — but a nonce/hash-based CSP would be stronger.

## Reporting

Found a security issue? Please open a GitHub issue on this repository (or contact the maintainer)
rather than filing it elsewhere — this project is independent and not covered by Circle's bug bounty.
