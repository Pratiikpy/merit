# AGENTS.md — Merit, for agents (and humans) working on it

Merit is a **multi-agent research economy on Circle's Arc L1**. Given a question + a USDC budget, a lead
agent hires specialist sub-agents (search → write → verify), pays each in real sub-cent USDC **only for
work that verifies**, then pays the **creators** whose sources it actually cited — refusing (refunding)
everything that doesn't check out. The moat is **proof-of-citation**: an adversarial LLM *Auditor* rules
whether each source actually backs the specific claim citing it. Reputation accrues on-chain (ERC-8004)
for agents *and* creators and governs who gets hired next. *Anyone can pay; only Merit decides who earned it.*

## Architecture (request → settlement)

```
POST /api/run (SSE)  →  lib/agent.ts runAgent()
  discover   pick/seed sources (curated registry, or live RSS via lib/discover.ts)
  hire       lib/specialists.ts — lead hires the highest-reputation specialist per role (search/write/verify)
  answer     lib/llm.ts writeAnswer() — cited answer, inline [[Source]] markers, untrusted-data framed
  verify     lib/llm.ts verifyCitations() — the Auditor; deterministic numeric check + identity gate + similarity + LLM judge
  release    lib/pay.ts settlePayment() — x402 + Circle Gateway USDC to verified sources; refuse the rest
  reputation lib/reputation.ts — ERC-8004 Identity (mint) + Reputation (giveFeedback) + Validation (verdict)
```

- **Frontend**: hand-authored `public/index.html` (served at `/`) — design is protected; only zero-visual a11y edits unasked.
- **Money**: viem EOAs. BUYER = the Auditor/validator (settles + writes validation). OPERATOR = identity owner (mints + reputation).
- **Self-healing identities**: `operatorOwnsIdentity()` drops any persisted agentId the operator no longer owns (STUB-fake / prior-key / testnet-reset) and re-mints, so all 3 registries write on every live run.

## Run it

```
npm run dev            # or: npm run build && npm run start   (long-lived Node host; SSE needs a real process)
# open / , hit Run agent. Env: STUB=1 = offline/simulated; REPUTATION_ONCHAIN=1 = real on-chain writes.
```

Wallets/keys via `.env.local` (`BUYER_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY`, the LLM key, `ARC_RPC_URL`). Fund the wallets at faucet.circle.com.

## Don't trust — verify (server-free CLI suite)

| command | proves |
|---|---|
| `recompute -- <agentId>` | an agent's ERC-8004 reputation, rebuilt from raw Arc logs (no server, no cache) |
| `verify-validation` / `verify-receipt` / `verify-settlement` | the on-chain verdict / the signed receipt / the money moved |
| `verify-all -- <receipt>` | every paid/refused decision cross-checked against the ValidationRegistry — the receipt **cannot lie** |
| `challenge -- "<source>" "<claim>"` | re-derives the Auditor's verdict live — the judgment is appealable, not a black box |
| `prove -- <receipt>` | the whole run honest in one command (verify-all + challenge) |
| `judge-eval` | the Auditor's **measured** accuracy/precision/recall on a labeled gold set — the moat, quantified |
| `leaderboard` | the two-sided reputation economy ranked by on-chain merit |
| `moat-value` / `audit-demo` / `compare-crews` | the economic case · the moat head-to-head · pro vs economy crew |
| `mcp` | exposes Merit as one MCP tool (`merit_research`, annotated destructive/non-idempotent — it spends USDC) |

## Tests (three layers — run the cheap ones first)

1. **Offline unit** — `npm test` (273, vitest): pure decision logic, parsers, scoring, no network/LLM/chain.
2. **E2E smoke** — `npm run smoke` (54, against a running server; STUB-safe): full run, ledger, receipt, MCP handshake, the verifiers.
3. **Live on Arc** — a `REPUTATION_ONCHAIN=1` run + the verify suite; needs funded wallets. Skip cleanly without keys.

Prefer STUB for iteration (the LLM key rate-limits under load). `npm run preflight` checks deploy readiness.

## Extend safely

- **New source/creator**: add to the seed in `lib/registry.ts` (or `POST /api/creators/register`). `content` is what the Auditor verifies against.
- **New specialist role**: `lib/specialists.ts` (role, tier, price, wallet). Hiring keys off reputation in `pickSpecialist`.
- **New verifier**: a `scripts/*.mjs` that reads from chain or a receipt; wire into `package.json` + the README table + a smoke check.
- **Touching the money/verify path**: it's the moat — add tests, run `judge-eval` (the Auditor must stay calibrated) and the smoke before/after, and keep `labor + payouts ≤ budget`.
