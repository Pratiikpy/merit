# Merit — a proof-of-work economy for AI agents, on Arc

Give Merit a question + a USDC budget and a **lead agent** runs an autonomous research
firm. It **hires specialist agents** — search → write → verify — and pays each in sub-cent
USDC **only for work that verifies**, then pays the **creators** whose sources it actually
cited (proof-of-citation), refusing (refunding) everything that doesn't check out. Every
payment is real, settles on Arc, is gated on proof-of-work, and writes **portable on-chain
reputation** (ERC-8004) for *both* the agents and the creators. Anyone can pay; only Merit
decides who *earned* it.

![Merit live demo: the agent decides who gets paid — releasing sub-cent USDC to cited sources (Chainletter +$0.054) and refusing the rest (CryptoBuzz −$0.030), a signed receipt for each decision](docs/demo.png)

It's **two-sided**: **agent → agent** (the lead hiring its crew) and **agent → creator**
(paying the cited sources) — a settlement + trust layer for an agent economy, not just an app.

Built on **Arc testnet** with **Circle Nanopayments** (x402 + Gateway batching), real LLM
reasoning + an **adversarial proof-of-citation judge** (the Auditor rules whether each source
actually backs the claim citing it), and **all three ERC-8004 registries** (identity, reputation,
and validation — the Auditor's verdict written on-chain). Frontend:
the hand-authored design in `public/index.html` (served at `/`). Backend: Next.js API routes
under `app/api/*`; the lead's loop streams over SSE.

## At a glance

```text
   question + USDC budget
            │
            ▼
   ┌─────────────────┐   hires + pays each per job (x402, ONLY for verified work)
   │   LEAD AGENT    │ ───────────────────────────────────────────────▶  CREW   (agent → agent)
   │     (buyer)     │                                        SEARCH   Scout · Ferret
   └────────┬────────┘                                        WRITE    Scribe · Quill
            │                                                 VERIFY   Auditor · Tally
            │   proof-of-citation — the Auditor judges each claim     (pro · budget tiers)
            ▼
   cited + verified + supported    ─▶  release sub-cent USDC to the CREATOR   (agent → creator)
   uncited / unverified / refuted  ─▶  refund, with the reason shown
            │
            ▼
   real USDC on Arc  ·  ERC-8004 reputation (agents + creators)  ·  signed summary receipt
```

Two markets, one trust layer: the lead **hires + pays its crew** (agent → agent) *and* **pays the
creators** it cited (agent → creator) — every payment gated on proof-of-work. Anyone can pay; only
Merit decides who *earned* it.

## The agent-labor market (the leap)

The lead agent doesn't do the work itself — it **hires a crew** from an open pool of specialist
agents and pays them per job, exactly like it pays creators:

- **Search / Write / Verify** specialists each expose a wallet, a price, a service, and a
  **capability** (shown in `/api/agents`). The **write** and **verify** tiers genuinely differ:
  the pro **Scribe** writes thoroughly (cites every supported claim) and the pro **Auditor** runs
  the adversarial LLM judge; the budget **Quill** writes terser (cites fewer sources, so fewer
  creators tend to earn) and the budget **Tally** checks by **similarity only** — with no judge it
  can't catch a hollow citation the Auditor would. Cheaper labor, structurally weaker verification.
- The lead **hires the highest-reputation** specialist per role — reputation *gates* the market;
  a cheaper, unproven rival has to earn its merit before it wins work. A run can opt into the
  **economy crew** with `{"tier":"budget"}` to `/api/run` (cheaper labor, terser writing,
  similarity-only verification); the default hires the proven pros. `npm run compare-crews` shows
  the two side by side.
- Specialists **deliver first, are graded on verified output, then paid (release) or refused** —
  the same escrow → verify → release Merit uses for creators (you don't pay for bad work).
- Each accrues **on-chain ERC-8004 reputation** that compounds. The "Agent crew" panel shows it
  live, and **labor + creator payouts always stay within your budget** (a single whole-run cap).

Each specialist is a **standalone x402 service**: its pay endpoint returns a real
`payment-required` challenge (payTo = the specialist's own wallet, priced in USDC on Arc), so any
external agent — not only this lead — can discover and pay it directly. The market is open, not
internal plumbing.

**Why Arc:** one research job is dozens of sub-cent agent-to-agent payments. On card rails the
fees exceed the labor; on a gas-metered chain, gas kills the loop. Arc's gasless, sub-cent,
sub-second USDC settlement is what makes agent labor economically viable at all.

## Two source modes
- **Curated** (default) — a stable seven-source pool for a reliable demo (six publishers + a
  cited-but-unsupported "trap" only the Auditor catches — see it refused in every run).
- **Live web** — the agent discovers **real publishers** live from RSS (CoinDesk, Cointelegraph,
  Decrypt, PYMNTS, The Block, CryptoSlate, Bitcoin Magazine), reads their content, and pays the ones
  it cites (per-source wallet); each
  publisher's reputation accrues **per domain**. A real creator can onboard with their own wallet
  + a content sample to be paid directly. Toggle **Sources → Live web**, or send
  `{"discover":true}` to `/api/run`.

## Run it
```bash
npm install
npm run start          # production server (recommended); or: npm run dev
# → http://localhost:3000
```
With `STUB=1` the whole loop runs **offline** (templated answer, simulated hashes, file-backed
registries) — good for building/recording with zero deps. Open `/`, set a question + budget, hit
**Run agent**, and watch the lead **hire + pay its crew**, then settle to creators, refuse the
rest, and write reputation — all on screen. The run ends in a **signed, verifiable receipt**
(every verdict + amount + all three registry txs, with a Download button); **click any creator**
for its on-chain reputation, or hit **Compare crews** to see the pro-vs-economy verification
market side by side.

## Go live on Arc testnet
1. **Fund** at https://faucet.circle.com (Arc-testnet USDC):
   - `BUYER_*` — the lead/buyer wallet (Gateway deposit + gas + pays specialists, creators, and
     ERC-8004 feedback). Specialists + creators are receive-only (no funding needed).
   - `OPERATOR_*` — identity registrar; a little native USDC for mint gas (only if `REPUTATION_ONCHAIN=1`).
2. **Set keys** in `.env.local`:
   - `LLM_API_KEY` — NVIDIA `nvapi-…` or OpenAI `sk-…` (auto-detected), with
     `LLM_BASE_URL` / `LLM_MODEL` / `EMBED_MODEL` / `EMBED_INPUT_TYPE` for the provider.
   - `STUB=0` to settle real USDC; `REPUTATION_ONCHAIN=1` to write ERC-8004 for real.
   - Optional Supabase (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`) — durable receipts mirror;
     the app runs without it.
3. `npm run build && npm run start`.

> ⚠️ Next does **not** override env vars already set in your shell. Unset a stale
> `OPENAI_API_KEY`/`LLM_API_KEY` so `.env.local` wins.

## Scripts
| command | what it does |
|---|---|
| `npm test` | 160 unit tests (vitest) over the pure logic — the agency decision table, **the crew grade + whole-run budget-guard functions** (`gradeSpecialist`/`withinBudget`), **the run-receipt settlement-integrity rule** (`summarizeRelease` — an intended release whose settlement failed reports refunded, never a phantom paid), proof-of-citation matching (citation tags + the `citingSentence` claim extractor + the `parseJudgeVerdict` Auditor-reply parser + the batched `verifyCitations` scorer + **the pure `decideCitation` payment-decision logic** — embedding *and* lexical thresholds, the judge override, the injection guard, **and the deterministic numeric verifier** (`fabricatedFigures` — a $/% figure the source contradicts is refused with no LLM), all tested without a live LLM), RSS/Atom parsing, registry + per-publisher-identity persistence, **the specialist hiring/grading/merit logic** (incl. the tier preference), the shared run-context lifecycle + eviction, the run rate-limiter, the LLM circuit-breaker self-heal, the off-topic guard (`questionAddressedBy` — pays nothing when no source answers the question), provider detection, and the no-secret-leak views |
| `npm run smoke` | end-to-end smoke test (54 checks: sources, full run, ledger consistency, the **summary receipt**, **no private-key leak in the run stream**, the agent-labor market — crew hired/paid + labor-within-budget + specialists are real x402 services, a zero-budget pays-nothing invariant, an **off-topic question pays no creators**, onboarding, on-chain reputation for creators **and** specialists, **the MCP server handshake**, **and `verify-all` running cleanly on the run's receipt**, **and the `leaderboard` ranking the two-sided market**, **and the `challenge` re-audit endpoint validating input + degrading gracefully without an LLM**) |
| `npm run audit-demo` | proves the moat: feeds the Auditor's adversarial judge a genuine citation, two contradictory ones, and a **prompt-injection attempt**, and shows it pay the real citation while **refusing** the contradictions *and* the injection — proof-of-citation that's robust to manipulation, not a similarity score |
| `npm run prove-reputation` | mints an ERC-8004 identity + writes feedback on Arc, prints arcscan links |
| `npm run reputation -- [id]` | print an agent's **portable track record** — its full on-chain feedback timeline recomputed live from Arc (each release/refuse event with its own tx link), proving reputation is replayable from chain by anyone, not asserted (no id → the top specialist) |
| `npm run recompute -- <agentId>` | **server-free proof** — reconstruct an agent's ERC-8004 reputation straight from Arc with NO Merit server and NO cache (raw `eth_getLogs` + int128 decode). A judge runs this and gets the exact score Merit shows: "recomputable from chain by anyone" made literally runnable |
| `npm run leaderboard` | **the reputation economy at a glance** — ranks the whole two-sided market (specialists *and* creators) by their ERC-8004 reputation on Arc, scoped to Merit's roster, on-chain score beside live local merit. Surfaces the moat as portable reputation: verified agents earn **+100**, the cited-but-contradicted trap and uncited sources **−20** — refusal becomes negative reputation that travels. Every row re-derivable with `recompute` |
| `npm run verify-validation -- <validationTx>` | **verify the Auditor's verdict on-chain** — from a receipt's validation tx, decode the requestHash and read the ERC-8004 ValidationRegistry (`getValidationStatus`): prints the recorded verdict (100=paid / 0=refused) + tag + agent. Set `AUDITOR_ADDRESS`/`BUYER_ADDRESS` to **pin the validator** to Merit's Auditor (so an arbitrary caller's self-written verdict is rejected). No Merit server |
| `npm run verify-receipt -- <receipt.json> [buyerAddress]` | **verify the signed receipt offline** — recovers the signer from the receipt's ECDSA signature over the canonical body. Pass the buyer address (or `BUYER_ADDRESS`) to **pin** it: confirms the signer is the wallet that actually paid (without the pin it only attests internal consistency). Zero network; any altered verdict or amount breaks the signature |
| `npm run verify-settlement -- <wallet>` | **verify the money moved** — reads the USDC Transfer logs on Arc for a creator/specialist payout wallet and sums what it actually received, with NO Merit server. The money analogue of `recompute`: "real USDC settles on Arc" made independently recomputable (a batched payment resolves once the Gateway batch lands) |
| `npm run verify-all -- <receipt.json> [buyer]` | **the whole receipt, one command** — recovers the signature offline and pins it to the payer, then reads **every** paid/refused decision back from the ERC-8004 ValidationRegistry and **cross-checks it against the receipt** (a "paid" source MUST read 100/100 on-chain, a "refused" 0/100, all written by the pinned Auditor). Any divergence is flagged: proof the receipt **cannot lie**. Composes the four verifiers above into a single "don't trust, verify" report; no Merit server |
| `npm run prove -- <receipt.json> [buyer]` | **the whole run, proven, one command** — composes `verify-all` (the receipt's recorded facts re-checked against Arc: signature, validation verdicts, money) with `challenge` (the Auditor's *judgment* re-derived live on a refused-but-cited source). Facts from chain **plus** judgment re-audited → a run shown honest top to bottom from nothing but its receipt; degrades gracefully when a half is unavailable |
| `npm run challenge -- "<source>" "<claim>"` | **re-audit the Auditor (appeal a verdict)** — re-runs the proof-of-citation judge on a (source, claim) pair independently of any run, and reports **SUPPORTED / REFUSED**. The one check that re-derives the Auditor's *judgment* rather than a recorded fact: a refused creator appeals; a skeptic confirms a refusal holds. Live-proven — the trap stays REFUSED, a matching claim SUPPORTED, an unrelated claim against a *trusted* source still REFUSED (no rubber-stamp). Needs the server's LLM judge |
| `npm run judge-eval` | **measure the Auditor (judge the judge)** — runs a hand-labeled gold set of 16 (source, claim) pairs (supported + mis-cited: off-topic, contradictory, a **fabricated number**, and the trap, both directions) through the live Auditor and reports accuracy / precision / recall / F1. Proves the moat is **calibrated, not asserted** — currently **100 / 100 / 100**. A false-negative (a wrongful pay) fails the run; extend the gold set to harden it. (Adapted from FinGPT's HaluEval harness) |
| `npm run mcp` | **MCP server** — exposes Merit as one callable tool (`merit_research`) over the Model Context Protocol (stdio), so any MCP client (Claude, Gemini CLI, Cursor) can run the full verified-research-and-pay loop and get the answer + on-chain receipt. Wire it into the client's `mcpServers` config (see the script header) |
| `npm run preflight` | pre-deploy doctor — checks env, that each key derives to its declared address, wallet funding (gas + USDC), and LLM reachability; prints READY / NOT READY |
| `npm run example -- "your question" [--discover]` | drive a run programmatically (no browser): prints the answer, the specialists hired + paid, and the creators paid (with proof-of-citation scores + Arc tx links) vs refused — Merit as a callable service. Add `--discover` to pull **live web sources** (real RSS publishers) instead of the curated pool |
| `npm run external-hire -- scout` | act as an EXTERNAL agent (separate process): discover a specialist's x402 challenge and pay it directly — a real USDC settlement to the specialist's own wallet, proving the open agent-to-agent market |
| `npm run creator-market` | the **creator side** of the open market: a brand-new creator onboards via the PUBLIC register endpoint with its own payout wallet (non-custodial, no team seeding), then a niche-question run cites + pays it for a verified citation — proof the creators aren't hand-placed |
| `npm run compare-crews` | runs the same question with the **pro crew** vs the **economy crew** (`{"tier":"budget"}`) and prints them side by side — reputation, verification capability (LLM judge vs similarity-only), labor cost, and outcome — making the agent-labor market's price/quality trade-off tangible |
| `npm run moat-value` | the **economic case** for proof-of-citation — runs a real run and quantifies what a *pay-then-pray* rail wastes paying the sources Merit **refused** (off-topic data + an unverifiable identity) vs Merit paying only for verified value. The moat as money protected, not a claim |
| `npm run reset-demo` | restores a clean demo state (fresh merit, drops test creators, keeps cached agentIds) |
| `npm run generate-wallets` | generate the buyer/operator/seller EOAs |

## Use Merit from any MCP client
Merit ships an MCP (Model Context Protocol) server, so any MCP-aware agent — Claude, Gemini CLI,
Cursor — can call Merit as a tool. Start Merit, then point the client at the server:

```json
{
  "mcpServers": {
    "merit": {
      "command": "node",
      "args": ["scripts/mcp-server.mjs"],
      "env": { "MERIT_BASE": "http://localhost:3000" }
    }
  }
}
```

One tool is exposed — **`merit_research`** (`question`, optional `budget` / `discover` / `tier`). It runs
the full loop (hire crew → cited answer → proof-of-citation → pay verified sources / refuse the rest →
ERC-8004 reputation + validation) and returns the answer **plus the receipt** — who was paid or refused
and why, with Arc tx links. The calling agent doesn't just get an answer; it gets one whose every
citation was paid for *only if it verified*. (Dependency-free stdio JSON-RPC; no SDK to install.)

## Architecture
- `lib/agent.ts` — the **lead** orchestrator: hire search/write/verify specialists → escrow →
  **grade + pay the crew** (agent→agent) → release/refund **creators** (agent→creator) → write
  ERC-8004 reputation for both. Whole-run budget cap, settlement resilience, abort-on-disconnect.
- `lib/specialists.ts` — the specialist-agent registry (the **labor supply side**): stable wallets,
  on-chain reputation, pro/budget tiers, and the `pickSpecialist` reputation-gated hiring rule.
- `lib/runctx.ts` — in-process run context shared between the lead and the specialist endpoints
  (heavy data stays here; only an unguessable `runId` crosses the x402 wire).
- `app/api/agent/[id]` — a specialist's **unpaid work** endpoint (idempotent per run); `/pay` is the
  **x402-gated release** that settles to the specialist's own wallet.
- `lib/registry.ts` — file-backed source/creator registry (stable wallets, atomic writes) + ephemeral discovered-source store.
- `lib/discover.ts` — live RSS discovery → payable publisher sources (keyless, graceful fallback).
- `lib/llm.ts` — provider-agnostic answer generation + the Auditor's proof-of-citation: an adversarial LLM judge (`judgeCitation`) decides whether each source actually backs the exact claim citing it (`citingSentence`), with asymmetric-embedding similarity as the evidence score + fallback. Catches on-topic-but-unsupported citations a score alone waves through.
- `lib/seller.ts` — x402 seller wrapper, per-payee `payTo` (Circle Gateway batching) — used by both creators and specialists.
- `lib/pay.ts` — buyer-side `GatewayClient` deposit + nanopayment settle (enforces the authorized price).
- `lib/reputation.ts` — ERC-8004 (all **three** registries): operator mints identities (one per creator, per publisher domain, and **per specialist**, persisted); buyer (validator) writes Reputation feedback **and the proof-of-citation verdict to the ValidationRegistry** (no self-attest).
- `app/api/{health,sources,agents,run,source/[id],agent/[id],agent/[id]/pay,creators/register,reputation/[id]}` — the API (`/api/agents` is the specialist marketplace directory — the labor supply side; `/api/run` is SSE + rate-limited, and ends with a **`summary`** event — the complete, self-contained run receipt (every source's verdict + reason + the on-chain txs — the USDC settlement, the ERC-8004 reputation write, **and the ValidationRegistry verdict** — the crew hired + paid, and the budget totals, in one object); `/api/reputation/[id]` recomputes reputation directly from on-chain ReputationRegistry events — for a creator **or** a specialist agent, returning both the aggregate score **and the full per-event feedback timeline** (each release/refuse with its own Arc tx link, so an agent's entire track record is independently replayable from chain)).

## Deploy
A long-lived Node host (the SSE run moves real funds — not a serverless function). See
[`DEPLOY.md`](./DEPLOY.md): one-click Render (`render.yaml`, with a persistent disk) or
`Dockerfile`. The lead's x402 calls are a **loopback** to its own specialist endpoints on
`localhost:$PORT`, so the agent-labor market works on any host/port with no `BASE_URL` config — and,
by design, never follows a (forgeable) request `Host` header, so it can't be steered off-server.

## On-chain references (Arc testnet, chain `5042002`)
USDC `0x3600…0000` · Gateway `0x00777…19B9` · ERC-8004 Identity `0x8004A8…BD9e` / Reputation
`0x8004B6…8713` / Validation `0x8004Cb…4272`. Agent payments, creator settlements, identity mints, feedback, and validation writes are all
verifiable on `testnet.arcscan.app`. Based on `circlefin/arc-nanopayments` + `arc-escrow`.
