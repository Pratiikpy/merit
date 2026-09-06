# Merit — ETHOnline 2026 · Arc submission

**Merit is the verification layer the agent-payment stack is missing.** x402 answers *how* an agent pays.
x401 answers *who* authorized it. Neither answers **"was the work correct?"** — so today an agent pays for a
hallucinated citation exactly as readily as a true one. Merit verifies that a cited source actually supports
the claim made from it, and makes that verdict the settlement switch: a wrong citation is **refused and costs
nothing**, and the proof of that decision travels *inside* the payment as an on-chain memo.

| | |
|---|---|
| **Live** | https://www.onmerit.xyz |
| **Repo** | https://github.com/Pratiikpy/merit |
| **Architecture diagram** | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [rendered](https://www.onmerit.xyz/architecture.html) |
| **Demo video** | https://youtu.be/MuV-c3yaQwY |
| **OpenAPI 3.1** | https://www.onmerit.xyz/api/openapi |
| **x402 discovery** | https://www.onmerit.xyz/.well-known/x402 |
| **Audit it yourself** | https://www.onmerit.xyz/reconcile.html |
| **Chain** | Arc Testnet, chain `5042002` |

> **Calling the API with a key?** Use `https://www.onmerit.xyz`. The apex domain 308-redirects to `www`, and
> HTTP clients drop the `Authorization` header across a cross-host redirect. Unkeyed endpoints work on either.

---

## Which prizes this is submitted for

### 1 · Best Agentic Economy Application with Circle Agent Stack

> *"Build AI agents that hold wallets, make payments, manage risk, settle jobs or transact with other agents
> using USDC."*

| What they ask for | Where it is |
|---|---|
| **Agents with clear decision logic tied to real signals** | The decision logic *is* the product: a four-gate verification engine (deterministic numeric → NLI → adversarial judge → 0G TEE-attested consensus jury) whose output gates every payment. The signal is ground truth about the cited source, not a heuristic. `lib/verify/engine.ts` |
| **Autonomous spending, payments or settlement flows using USDC** | `POST /api/run` drives the full loop: plan → retrieve → write → verify each citation → settle sub-cent USDC to the creators whose sources held, refund the rest. Agent-to-agent too: specialists are hired and paid over x402 (`/api/agent/[id]/pay`). |
| **Nanopayments** | Circle Gateway batched nanopayments via `@circle-fin/x402-batching`, both directions — Merit is a **seller** (`lib/seller.ts`) and a **buyer** (`lib/pay.ts`). |
| **Circle Wallets** | Circle Developer-Controlled Wallets for the KMS-custodied payout wallet (`circle-dcw/`, `lib/wallet.ts`) — no plaintext key on the server. |
| **Paymaster-class gas sponsorship** | On Arc, gas *is* USDC, so a wallet holding exactly what it means to spend cannot spend it. `POST /api/relay` takes a signed EIP-3009 `TransferWithAuthorization` and broadcasts it, paying the gas: **verified on production with a payer whose transaction count stayed at 0.** `lib/relay.ts` |
| **Risk management** | Circle Compliance Engine KYT + denylist screen before any payout (**fails closed**), transaction simulation pre-flight (fails open), per-principal budget caps, spend-velocity auto-abort and a kill switch. The gasless relay is separately hardened against gas-griefing — see below. |

**Agent Stack compatibility, done as engineering rather than a claim.** Circle's six starter kits give an agent
a shell and let it run `circle services pay`. Two concrete things were fixed and built so that path works:

- **The 402 was unpayable by anyone but us.** Merit's x402 challenge carried its payment requirements *only* in
  the base64 `PAYMENT-REQUIRED` header, with an empty `{}` body. Circle's batching client reads that header, so
  Merit's own buyer settled fine and the gap stayed invisible — but the x402 protocol carries the requirements
  in the **body**, which is what a generic client reads. Found by inspecting the live response; fixed to emit
  both; regression-tested in `tests/x402-challenge.test.ts`.
- **Proven, not asserted.** `npm run verify-x402-buyer` pays the live endpoint from a wallet that is *not* the
  payee — the way an outside agent would — and checks the deliverable is the signed verdict that was sold.
  12/12 against production. (Paying from the payee's own wallet is rejected by Circle as a `self_transfer`,
  which is why the buyer has to be independent, and why this is a real test rather than Merit paying itself.)
- **An OpenAPI spec and a marketplace-shaped discovery document**, which are Circle's stated prerequisites for
  an Agent Marketplace listing. `/api/openapi` is generated from live configuration — price, chain and payee —
  so it cannot drift from the service. `/.well-known/x402` now also publishes the Discovery API `items[]`
  shape, listing only genuinely x402-priced endpoints.

**Risk work is adversarial, not decorative.** The gasless relay is asymmetric by construction: the payer
spends nothing and Merit spends real gas (~0.0023 USDC per relay, measured). As first written it had no rate
limit, no minimum and no destination restriction — and a Merit API key is free from self-serve onboarding — so
anyone could mint a key and drain the relayer one dust transfer at a time, moving $0.000001 for every $0.0023
of ours. Found by reviewing the route against every other money-touching route, all of which were rate-limited
while this one was not. Three guards now, cheapest first: a floor an order of magnitude above the fee, a
destination Merit can actually credit, and the same rate limit the rest carry — 10 unit tests plus 32/32
against real Arc testnet USDC.

### 2 · Launch on Arc Testnet & Push to Mainnet

> *"Projects must be deployed or deployment-ready on Arc mainnet by September 30."*

**Deployed on Arc testnet**, and **deployment-ready for mainnet** in the only honest sense available: Arc
mainnet is not published yet — the Arc docs state that mainnet addresses are unavailable, and Circle's own
Gateway SDK ships `arcTestnet` with no mainnet counterpart.

So Merit made the network a configuration value instead of a constant:

- `ARC_NETWORK=testnet` (default) is byte-identical to the chain every verified transaction here used.
- `ARC_NETWORK=mainnet` assembles the profile from `ARC_MAINNET_*` values.
- **A missing mainnet value is never filled in with a testnet one.** Point Merit at mainnet with nothing
  configured and it yields empty values that fail loudly, rather than quietly sending real money to the wrong
  chain's contracts.
- `GET /api/health` returns `mainnetReadiness`: what is set, what is missing, the env var for each, and what
  each gates.

16 tests hold both halves (`tests/arc-network.test.ts`). Moving to Arc mainnet is environment variables, not a
code change.

**Stablecoin settlement and escrow logic on Arc**, which this track asks for specifically:
`MeritJob` + `MeritVerificationHook` implement ERC-8183 escrow whose release is gated on the citation verdict.
Job 1 is `Completed` (citation verified); job 2 is `Rejected` (citation failed — the hook blocked the release).

### 3 · Best DeFi / Onchain Finance Application

Submitted as the weaker of the three fits, and named honestly as such. Merit is not a lending, AMM or FX
protocol. What it does contribute to onchain finance is **conditional settlement** — a payment that executes
only when an oracle says the delivered work was correct — plus:

- **Advanced programmable money flows**: verified net settlement (`/api/settle/batch` authorizes N lines and
  settles only the k that verify), graded per-claim payouts, custody accrual with domain-proof withdrawal, and
  hook-gated escrow.
- **Multi-step settlement**: verify → compliance-screen → simulate → memo-wrap → batch → reconcile.
- **Treasury workflows**: prepaid balances where a refused citation costs nothing, on-chain withdrawal of the
  unspent remainder, and CCTP cross-chain payout to Base / Arbitrum / Optimism / Avalanche.

---

## Qualification requirements

| Requirement | Evidence |
|---|---|
| **Functional MVP — frontend** | https://www.onmerit.xyz — 22 pages. Try the hero verifier, [`/verify.html`](https://www.onmerit.xyz/verify.html), [`/break.html`](https://www.onmerit.xyz/break.html) (try to fool it), [`/proof.html`](https://www.onmerit.xyz/proof.html), [`/reconcile.html`](https://www.onmerit.xyz/reconcile.html). |
| **Functional MVP — backend** | 73 API routes; the contract is at [`/api/openapi`](https://www.onmerit.xyz/api/openapi). |
| **Architecture diagram** | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system, money path, verification engine, network configuration. [Rendered](https://www.onmerit.xyz/architecture.html). |
| **Video demonstration** | https://youtu.be/MuV-c3yaQwY |
| **Documentation** | [`README.md`](README.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`BENCHMARK.md`](BENCHMARK.md), [`docs/NEXT-BUILD.md`](docs/NEXT-BUILD.md), [`SECURITY.md`](SECURITY.md) |
| **GitHub repo** | https://github.com/Pratiikpy/merit |

---

## How to check any of this without trusting us

1. **Verify a claim.** `POST https://www.onmerit.xyz/api/verify` with `{claim, source}` — free. Fabricate a
   figure and watch the deterministic gate refuse it with no model involved.
2. **Check a verdict offline.** Every verdict is EIP-191 signed over canonical JSON. `npm run verify-receipt`
   recovers the signer with no Merit server in the loop.
3. **Read the memo inside a payment.** `GET /api/memo?tx=0x62952ce1ad2b43e9bc000d9e1f107f59e722591490d7cdba1c6ab429dc132c30`
   — two memos, both auditing clean, on a real Arc transaction that paid two creators at once.
4. **Audit the ledger against the chain.** [`/reconcile.html`](https://www.onmerit.xyz/reconcile.html) re-reads
   every published settlement from Arc, cross-checks both USDC emitters, and scans for outbound USDC the ledger
   does not explain.
5. **Reproduce the benchmark.** `npm run bench-judge` — 275 adversarial cases, 14 failure modes.
6. **Run the Arc-native proof.** `npm run verify-arc-native` — 30 checks against real testnet USDC.
7. **Buy a verification as an outside agent.** `npm run verify-x402-buyer` — reads the 402 the way a generic
   x402 client does, settles the toll over Circle Gateway from a wallet independent of the payee, and asserts
   the payload is the signed verdict that was sold. 12/12 against production, with a real 0.005 USDC
   settlement.

---

## Test and verification status

| | |
|---|---|
| Unit tests | **641 passing** (81 files) |
| Browser E2E | **50 passing** across 5 viewports, run against the deployed site |
| Accessibility | **0 axe violations** (WCAG 2.1 A/AA) across all public pages |
| Arc-native settlement | **30/30** against real Arc testnet USDC (`npm run verify-arc-native`) |
| Gasless relay on production | **9/9**, including a payer whose nonce never left 0 |
| x402 buyer against production | **12/12** — an independent wallet paid 0.005 USDC over Circle Gateway and received a signed verdict |
| API sweep against production | **58 pass / 0 warn / 0 fail** — every route's happy path and negative statuses, IDOR probes, offline signature recovery, audit hash-chain |
| Autonomous pentest (Strix) | **No vulnerability found in what it covered** — semgrep across 536 rules / 381 files, plus prompt-injection of the payment verdict, hardcoded keys, command injection, path traversal and committed secrets each explicitly ruled out. The run did **not** complete (it exhausted its model budget), so this is coverage of those areas, not a clean bill of health for the whole codebase. |
| Adversarial benchmark | **100% recall**, 90.4% precision, 94.9% F1 over 275 cases |

**Not covered, stated plainly:** Arc mainnet (not published — testnet only). Merit is **not yet listed** on
the Circle Agent Marketplace: listing goes through a Google Form and a human review at Circle, so what was
built here is compliance with every stated prerequisite (402 when unpaid, content when paid, a published
OpenAPI spec, a confirmed payout wallet) — the submission itself is still to be made. The Circle DCW payout path is not memo-wrapped — it is a smart-contract
wallet, which Arc's `CallFrom` precompile rejects by design, so that path falls back to a plain transfer and
says so in the response. The chain→ledger outflow scan covers a bounded recent window, not all history, and
always reports the window it covered.

---

## Why this is worth building

Every rail in the agent economy pays on **delivery**. Merit pays on **correctness**. That difference is the
whole product, and it is the one thing none of the funded incumbents in this category ship: payments
(x402, Kite, Skyfire), identity (x401, ERC-8004), and execution attestation (TEEs, zkML) all leave the
semantic question — *is this claim actually true of its source?* — unanswered. A model can run inside a perfect
TEE and still emit a false claim.

Merit answers that question, signs the answer, and wires it to the money.
