<div align="center">

<img src="public/favicon.svg" width="72" height="72" alt="Merit" />

# Merit

**Agents pay creators on merit.**

A proof-of-citation payment layer on Arc. A lead agent escrows USDC, verifies every citation
it makes, and releases sub-cent payment only for the claims that actually check out. Everything
else is refused before a cent moves, and every decision returns a signed receipt anyone can
recompute without trusting a Merit server.

<p>
<a href="https://merit-ecru.vercel.app"><img src="https://img.shields.io/badge/live%20demo-merit--ecru.vercel.app-16A34A?style=flat-square" alt="Live demo" /></a>
<img src="https://img.shields.io/badge/Arc-testnet%205042002-0A0A0A?style=flat-square" alt="Arc testnet" />
<img src="https://img.shields.io/badge/tests-441%20passing-3FB950?style=flat-square" alt="441 tests passing" />
<img src="https://img.shields.io/badge/proof--of--citation-275--case%20adversarial%20benchmark-3FB950?style=flat-square" alt="275-case adversarial benchmark" />
<img src="https://img.shields.io/badge/license-Apache--2.0-3178C6?style=flat-square" alt="Apache-2.0" />
</p>

<p>
<img src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs" alt="Next.js 16" />
<img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5" />
<img src="https://img.shields.io/badge/Solidity-0.8.24-363636?style=flat-square&logo=solidity" alt="Solidity 0.8.24" />
<img src="https://img.shields.io/badge/viem-2-2C2C2C?style=flat-square" alt="viem 2" />
<img src="https://img.shields.io/badge/Circle-x402%20%2B%20Gateway-0052FF?style=flat-square" alt="Circle x402 and Gateway" />
</p>

<br />

<a href="https://merit-ecru.vercel.app"><img src="docs/demo.png" width="840" alt="Merit live demo: the agent releases sub-cent USDC to cited sources and refuses the rest, with a signed receipt for each decision" /></a>

<br /><br />

[Live demo](https://merit-ecru.vercel.app) &nbsp;·&nbsp; [What it is](#what-it-is) &nbsp;·&nbsp; [How it works](#how-it-works) &nbsp;·&nbsp; [Settlement](#settlement-is-gated-on-verification) &nbsp;·&nbsp; [Quickstart](#quickstart) &nbsp;·&nbsp; [Verify everything](#verify-everything) &nbsp;·&nbsp; [Contracts](#deployed-contracts)

</div>

---

> Anyone can send money. Merit decides who earned it. Settlement is gated on whether the cited
> work is correct — the check most agent-payment stacks skip.

## Contents

- [What it is](#what-it-is)
- [How it works](#how-it-works)
- [Settlement is gated on verification](#settlement-is-gated-on-verification) · [Deployed contracts](#deployed-contracts)
- [The verification oracle](#the-verification-oracle)
- [What the oracle makes possible](#what-the-oracle-makes-possible)
- [Quickstart](#quickstart)
- [For creators](#for-creators)
- [The agent-labor market](#the-agent-labor-market)
- [Source modes](#source-modes)
- [Verify everything](#verify-everything)
- [API surface](#api-surface)
- [MCP integration](#mcp-integration)
- [On-chain references](#on-chain-references)

---

## What it is

Give Merit a question and a USDC budget. A lead agent runs the job: it hires specialist agents
(search, write, verify), pays each one in sub-cent USDC only for work that verifies, then pays the
creators whose sources it actually cited. Unsupported or fabricated citations are refused, and the
budget they would have spent is returned.

Two payment paths run through the same gate. Agent to agent, the lead pays the crew it hires. Agent
to creator, it pays the sources it cites. Both settle only against verified work, and both write
portable on-chain reputation (ERC-8004) for the parties involved.

Run with `STUB=0` and every payment is real USDC on Arc. The hosted demo runs in a clearly labeled
stub mode with the same logic and simulated settlement. The stack is Arc testnet, Circle x402 (the
HTTP-native agent-payment standard) with Gateway batching, real LLM reasoning, an adversarial
proof-of-citation judge, and all three ERC-8004 registries: identity, reputation, and validation.

## How it works

```text
   question + USDC budget
            │
            ▼
   ┌─────────────────┐   hires + pays each per job (x402, only for verified work)
   │   LEAD AGENT    │ ──────────────────────────────────────────────→  CREW   (agent → agent)
   │     (buyer)     │                                       SEARCH   Scout · Ferret
   └────────┬────────┘                                       WRITE    Scribe · Quill
            │                                                VERIFY   Auditor · Tally
            │   proof-of-citation: the Auditor judges each claim    (pro · budget tiers)
            ▼
   cited + verified + supported    →  release sub-cent USDC to the CREATOR   (agent → creator)
   uncited / unverified / refuted  →  refund, with the reason shown
            │
            ▼
   real USDC on Arc  ·  ERC-8004 reputation (agents + creators)  ·  signed receipt
```

## Settlement is gated on verification

Merit's settlement runs as an ERC-8183 job (the on-chain agent-job and escrow standard) whose escrow
release is controlled by a settlement-gate contract, `IACPHook`. The gate encodes proof-of-citation:
escrow releases only when the cited work verifies. This is deployed and exercised on-chain, not just
described.

- A verified run releases the escrow. A failed citation reverts `complete()` and refunds. On Arc,
  `MeritJob` job 1 is `Completed` (citation verified) and job 2 is `Rejected` (citation failed, the
  hook blocked the release). The release is bound to `keccak256` of the signed receipt; check it with
  `jobs(id)` and `verdictOf(host, id)`. Enabled by `MERIT_HOOK_ONCHAIN=1`.
- The evaluator is measured, not asserted: a forkable **275-case adversarial benchmark** spanning 14 failure
  modes (fabricated figures, contradiction, off-topic, right-entity-wrong-attribute, temporal error,
  overgeneralization, prompt-injection, and more), each label independently double-checked. Measured result:
  **100% recall** — every adversarial case caught, so nothing false reached settlement (197 held, 0 slipped) —
  at **90.4% precision / 94.9% F1**, 97% coverage. The verifier is conservative *by design*: it over-refuses
  ~30% of genuinely-supported claims rather than risk paying for one that isn't — the safe direction for money.
  Reproduce with `npm run bench-judge`; details in [`BENCHMARK.md`](BENCHMARK.md).

Most Arc and agent-economy projects gate payment on identity, a reputation score, or attested
execution. None gate on whether the work is correct. Gating settlement on citation correctness is
where Merit differs.

### Deployed contracts

Arc testnet, chain `5042002`:

| Contract | Role | Address |
|---|---|---|
| `MeritJob` | ERC-8183 job and escrow | [`0xdF81…6A05`](https://testnet.arcscan.app/address/0xdF81dCCFf8c8ea9e1fB6B5b2B790fAfF1Ebe6A05) |
| `MeritVerificationHook` | proof-of-citation settlement gate | [`0xA30f…9ab1`](https://testnet.arcscan.app/address/0xA30f58f60725a978Ac09034F4FDd32efc29e9ab1) |

These two are the settlement path; `lib/job.ts` gates release on the hook's verdict. Additional
forge-tested contracts explored during development (Escrow, Stake, Insurance, PredictionMarket,
AttestationVerifier) are recorded in [`contracts/deployments.json`](contracts/deployments.json) but
are not on the default settlement path.

## The verification oracle

The judge is available on its own, so any agent can check a citation before paying for it.

- **Free tier.** `POST /api/verify` takes a raw `(claim, source)` pair and returns a signed verdict:
  `SUPPORTED` or `REFUSED`, with the layers that decided it. The response includes a `signed` object
  carrying the exact bytes that were signed, so a caller recovers the signer offline and confirms the
  verdict without trusting the server. Altering any field breaks the signature.
- **Metered tier.** `POST /api/verify/paid` is the same oracle behind an x402 paywall, discoverable at
  [`/.well-known/x402`](https://merit-ecru.vercel.app/.well-known/x402).
- **Signed receipts.** Every verified citation becomes a shareable receipt at `/v/<id>`, and
  `GET /api/card/<id>` returns its `signed` object for offline recovery. The receipt is checkable with
  `scripts/verify-receipt.mjs` and never depends on a live server.

Two layers decide each verdict. A deterministic numeric verifier (`lib/numcheck.ts`) refuses any
figure the source contradicts with no LLM at all. An adversarial LLM judge (`lib/llm.ts`) then checks
whether the source actually supports the exact claim citing it, catching on-topic-but-unsupported
citations that similarity scoring alone would pass.

> [Try to get a lie paid.](https://merit-ecru.vercel.app/break.html) Submit a fabricated citation on
> the live site and watch the verifier refuse it before a cent moves, with a running "attacks held"
> counter and every attempt harvested into the gold set. On a system that trusts the writer, the
> fabricated citation pays; here, the chain reverts.

## What the oracle makes possible

A deterministic verification oracle can settle things a toll booth or a marketplace cannot, because
each one is resolved against ground truth rather than an opinion.

- **Citation staking.** The writer bonds on every source it cites, and the Auditor's verdict settles
  each bet: passed returns the bond plus a premium, refuted slashes it. See the `stake` event in any
  run, where the cited-but-contradicted trap source is slashed.
- **Self-bootstrapping benchmark.** `GET /api/benchmark` logs the boundary-confidence citations from
  each run as gold-set candidates, so the benchmark co-evolves with real traffic instead of staying a
  static snapshot.
- **Economic scalable oversight.** `npm run tournament` runs a self-play tournament where agents stake
  on citations settled by the real verifier. Honesty emerges: always-liars go bankrupt, an agent that
  learns only from payoff converges to truth (P(honest) 0.50 to 1.00), and the market's false-citation
  rate falls from 43% to 0%. No agent is programmed to be honest; the economics make it the only way to
  survive. Writeup: [`docs/scalable-oversight.md`](docs/scalable-oversight.md).

Each of these depends on the oracle. Without a ground-truth settlement layer, there is nothing to
settle a bet, grow a benchmark, or price an equilibrium against.

## Quickstart

Requires Node 20 or newer.

```bash
npm install
npm run dev            # http://localhost:3000  (STUB=1 by default, no external deps)
npm run build && npm run start   # production build
```

With `STUB=1` the whole loop runs offline: templated answers, simulated hashes, file-backed
registries, zero dependencies. Open `/`, set a question and budget, and run. The lead hires and pays
its crew, settles to creators, refuses the rest, and writes reputation on screen. Each run ends in a
signed receipt with a download button. Click any creator for its on-chain reputation, or use Compare
crews to see the pro and economy verification tiers side by side.

<details>
<summary><b>Go live on Arc testnet (real USDC settlement)</b></summary>

<br />

**1. Fund** at <https://faucet.circle.com> (Arc-testnet USDC):

- `BUYER_*` — the lead wallet (Gateway deposit and gas; pays specialists, creators, and ERC-8004
  feedback). Specialists and creators are receive-only.
- `OPERATOR_*` — identity registrar; a little native USDC for mint gas, only if `REPUTATION_ONCHAIN=1`.

**2. Set keys** in `.env.local`:

| Variable | Purpose |
|---|---|
| `LLM_API_KEY` | NVIDIA `nvapi-…` or OpenAI `sk-…` (auto-detected), with `LLM_BASE_URL`, `LLM_MODEL`, `EMBED_MODEL`, `EMBED_INPUT_TYPE` |
| `STUB=0` | settle real USDC |
| `REPUTATION_ONCHAIN=1` | write ERC-8004 on-chain |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | optional durable receipt mirror |

**3. Build and run:** `npm run build && npm run start`.

Next does not override env vars already set in your shell. Unset a stale `OPENAI_API_KEY` or
`LLM_API_KEY` so `.env.local` wins.

</details>

## For creators

A publisher joins in one step and earns USDC each time an agent verifiably cites its work. No account,
and no key is handed to Merit; the payout wallet is receive-only.

```bash
# an RSS/Atom feed becomes a citable, payable creator with an ERC-8004 identity
npm run onboard-feed https://yourblog.com/feed.xml
```

Or open [`/onboard.html`](https://merit-ecru.vercel.app/onboard.html) and paste the feed there. To
direct payouts to your own wallet instead of a Merit-generated one, add a single line anywhere in the
feed and re-onboard:

```text
merit-verify:0xYourWalletAddress
```

From then on, every verified citation settles sub-cent USDC to that wallet on Arc. Hallucinated or
unsupported citations pay nothing.

Sixteen real publisher feeds are indexed as citable creators (HuggingFace, Vitalik, the Ethereum
Foundation, OpenAI, CoinDesk, Cloudflare, GitHub, Krebs, Paul Graham, WIRED, Ars Technica, and more),
each with a receive-only wallet and an ERC-8004 identity. The hosted demo serves a seven-source
curated pool. See [`PUBLISHERS.md`](PUBLISHERS.md); permissionless listings are honestly labeled, and
an owner-verified creator via `merit-verify:` is the stronger signal.

## The agent-labor market

The lead agent does not do the work itself. It hires a crew from an open pool of specialists and pays
them per job, the same way it pays creators.

- Search, write, and verify specialists each expose a wallet, a price, and a capability. The tiers
  genuinely differ: the pro Scribe cites every supported claim and the pro Auditor runs the adversarial
  judge, while the budget Quill writes terser and the budget Tally checks by similarity only, so it
  cannot catch a hollow citation. Cheaper labor buys structurally weaker verification.
- The lead hires the highest-reputation specialist per role, so reputation gates the market. Opt into
  the economy crew with `{"tier":"budget"}`; `npm run compare-crews` shows both side by side.
- Specialists deliver first, are graded on verified output, then paid or refused, following the same
  escrow-verify-release Merit uses for creators. Each accrues on-chain ERC-8004 reputation.

Every specialist is a standalone x402 service: its pay endpoint returns a real `payment-required`
challenge with `payTo` set to its own wallet, so any external agent can discover and pay it, not just
this lead.

**Traction.** Sixty-plus distinct agent wallets have settled 3,500-plus x402 payments to Merit's
specialists on Arc, each a real Circle Gateway settlement verifiable on the explorer. The live figure
is at [`/api/metrics`](https://merit-ecru.vercel.app/api/metrics) under `agentLabor`, kept distinct
from the proof-of-citation creator totals so unverified labor volume never inflates the verified
number. Detail in [`TRACTION.md`](TRACTION.md).

One research job is dozens of sub-cent agent-to-agent payments. On card rails the fees exceed the
labor; on a gas-metered chain, gas kills the loop. Arc's gasless, sub-cent, sub-second USDC settlement
is what makes agent labor viable at all.

## Source modes

- **Curated** (default): a stable seven-source pool for a reliable demo, including a cited-but-unsupported
  trap that only the Auditor catches and that is refused in every run.
- **Live web:** the agent discovers real publishers live from RSS (CoinDesk, Cointelegraph, Decrypt,
  PYMNTS, The Block, CryptoSlate, Bitcoin Magazine), reads their content, and pays the ones it cites,
  with reputation accruing per domain. Toggle Sources to Live web, or send `{"discover":true}` to
  `/api/run`.

## Verify everything

Every claim Merit makes is recomputable from Arc with no Merit server.

| Command | Proves |
|---|---|
| `npm run verify-receipt -- <receipt.json> [buyer]` | the signed receipt offline; recovers the signer, and any altered verdict or amount breaks the signature |
| `npm run recompute -- <agentId>` | an agent's ERC-8004 reputation straight from Arc (raw `eth_getLogs`), no server, no cache |
| `npm run verify-settlement -- <wallet>` | the money moved; sums the USDC Transfer logs a payout wallet received |
| `npm run verify-all -- <receipt.json> [buyer]` | the whole receipt; signature plus every paid or refused verdict cross-checked against the ValidationRegistry |
| `npm run bench-judge` | the evaluator, measured; scores the 275-case adversarial gold set through the live Auditor → honest precision/recall/F1 + per-failure-mode breakdown + coverage (never a hardcoded number) |
| `npm run prove -- <receipt.json>` | the whole run; chain facts plus judgment re-audited live |

<details>
<summary><b>Full script toolbox</b></summary>

<br />

| Command | What it does |
|---|---|
| `npm test` | 441 unit tests (vitest) over the pure logic: the agency decision table, crew grading and the whole-run budget guard, the receipt settlement-integrity rule, proof-of-citation matching and the deterministic numeric verifier, RSS/Atom parsing, registry persistence, the run rate-limiter, the LLM circuit-breaker, the off-topic guard, the monotonic settlement ledger, and the no-secret-leak views |
| `npm run smoke` | end-to-end, 57 checks: sources, a full run, ledger consistency, the summary receipt, no private-key leak, the agent-labor market, a zero-budget pays-nothing invariant, off-topic pays no creators, onboarding, on-chain reputation, the MCP handshake, `verify-all`, `leaderboard`, and the `challenge` re-audit |
| `npm run prove-moat` | one command: a verified run releases the ERC-8183 escrow; an off-topic run reverts `complete()` via the hook, then refunds |
| `npm run audit-demo` | feeds the Auditor a genuine citation, two contradictions, and a prompt injection; pays the real one, refuses the rest |
| `npm run prove-reputation` | mints an ERC-8004 identity and writes feedback on Arc, printing arcscan links |
| `npm run reputation -- [id]` | an agent's full on-chain feedback timeline, recomputed live from Arc |
| `npm run recompute -- <agentId>` | server-free reputation rebuild straight from Arc (`eth_getLogs` plus int128 decode) |
| `npm run leaderboard` | ranks the two-sided market (specialists and creators) by ERC-8004 reputation on Arc |
| `npm run verify-validation -- <tx>` | decodes a receipt's validation tx and reads the ValidationRegistry verdict (100 paid, 0 refused) |
| `npm run verify-receipt -- <receipt.json> [buyer]` | recovers the signer offline and pins it to the payer; any tamper breaks the signature |
| `npm run verify-settlement -- <wallet>` | sums the USDC Transfer logs a payout wallet received |
| `npm run verify-all -- <receipt.json> [buyer]` | the whole receipt cross-checked against chain |
| `npm run prove -- <receipt.json> [buyer]` | `verify-all` plus `challenge`: chain facts plus judgment re-audited |
| `npm run challenge -- "<source>" "<claim>"` | appeal a verdict by re-running the judge on a `(source, claim)` pair |
| `npm run judge-eval` | scores the 275-case adversarial gold set for accuracy, precision, recall, and F1 |
| `npm run mcp` | the MCP server: Merit as a callable tool over stdio for any MCP client |
| `npm run example -- "question" [--discover]` | drives a run programmatically; `--discover` pulls live web sources |
| `npm run external-hire -- scout` | acts as an external agent: discovers a specialist's x402 challenge and pays it directly |
| `npm run compare-crews` | the same question through the pro and economy crews, side by side |
| `npm run moat-value` | quantifies what a pay-then-pray rail wastes versus paying only for verified value |
| `npm run generate-wallets` | generates the buyer, operator, and seller EOAs |

</details>

## API surface

Every route an agent or integrator can call, same-origin, no SDK required.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/verify` | POST | verify a `(claim, source)` pair; returns a signed verdict plus a `signed` receipt |
| `/api/verify/paid` | POST | the metered oracle behind an x402 paywall |
| `/api/run` | POST | the full agent loop over SSE, ending in the signed summary receipt |
| `/api/agents` | GET | the specialist marketplace directory |
| `/api/agent/[id]/pay` | GET | pay a specialist directly (x402 challenge) |
| `/api/card/[id]` | GET | one receipt plus its offline-recoverable `signed` object |
| `/api/reputation/[id]` | GET | an agent's or creator's reputation, recomputed from chain |
| `/api/benchmark` · `/api/honesty` | GET | the gold-set benchmark and the Citation Honesty Index |
| `/.well-known/x402` | GET | service discovery for the paid endpoints |

## MCP integration

Merit ships an MCP (Model Context Protocol) server, so any MCP-aware agent (Claude, Gemini CLI, Cursor)
can call it as a tool. Start Merit, then point the client at it:

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

Two tools, dependency-free stdio JSON-RPC, no SDK:

- `merit_research` (`question`, optional `budget` / `discover` / `tier`) runs the full loop and returns
  the answer plus the receipt: who was paid or refused and why, with Arc tx links.
- `verify_citation` (`claim`, `source`) is the Citation Verification Oracle. Give it any pair and it
  returns a signed, tamper-evident verdict a settlement hook can consume before paying. A question-asker
  tool spreads questions; this spreads the check every one of those questions has to pass.

<details>
<summary><b>Architecture</b></summary>

<br />

- `lib/agent.ts` — the lead orchestrator: hire crew, escrow, grade and pay (agent to agent), release or
  refund creators (agent to creator), write ERC-8004 reputation for both. Whole-run budget cap,
  settlement resilience, abort-on-disconnect.
- `lib/job.ts` — the hook-gated ERC-8183 settlement (`settleViaHook`): drives MeritJob and
  MeritVerificationHook on-chain so a real run's escrow release is gated by the verdict.
- `lib/runctx.ts` — the run context shared between the lead and its specialist endpoints, mirrored to the
  durable store so the loop works across serverless instances.
- `lib/specialists.ts` — the specialist registry: stable wallets, reputation, pro/budget tiers, and the
  reputation-gated `pickSpecialist` rule.
- `lib/llm.ts` — provider-agnostic generation and the Auditor's proof-of-citation judge (`judgeCitation`),
  with asymmetric-embedding similarity as the evidence score.
- `lib/numcheck.ts` — the deterministic numeric verifier (`fabricatedFigures`): a figure the source
  contradicts is refused with no LLM.
- `lib/seller.ts` / `lib/pay.ts` — the x402 seller wrapper (per-payee `payTo`, Circle Gateway batching)
  and the buyer-side `GatewayClient` deposit and settle.
- `lib/reputation.ts` — ERC-8004 across all three registries: identity mints, reputation feedback, and the
  proof-of-citation verdict to the ValidationRegistry.
- `lib/store.ts` — durable persistence: every document mirrors to Supabase and hydrates on read, so state
  survives a stateless redeploy.

</details>

## On-chain references

Arc testnet, chain `5042002`. USDC
[`0x3600…0000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000).
ERC-8004 registries: Identity `0x8004A8…BD9e`, Reputation `0x8004B6…8713`, Validation `0x8004Cb…4272`.
Agent payments, creator settlements, identity mints, feedback, and validation writes are all verifiable
on [`testnet.arcscan.app`](https://testnet.arcscan.app). Built on `circlefin/arc-nanopayments` and
`arc-escrow`.

## License

[Apache-2.0](LICENSE)

<div align="center"><sub>Anyone can send money. Merit decides who earned it.</sub></div>
