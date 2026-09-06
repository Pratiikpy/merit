# Merit — architecture

Merit is a verification-first payment layer on Arc. x402 settles *how* an agent pays; x401 settles *who*
authorized it. Neither checks whether the work was **correct**. Merit verifies that a cited source actually
supports the claim made from it, and makes that verdict the settlement switch: a wrong citation is refused and
costs nothing.

Everything below is deployed and exercised on Arc testnet. Addresses and behaviours were verified against the
live chain, not read off a datasheet.

---

## 1. System

```mermaid
flowchart TB
    classDef moat fill:#DCFCE7,stroke:#047857,stroke-width:2px,color:#052e1c
    classDef refuse fill:#FEE2E2,stroke:#BE123C,stroke-width:2px,color:#4c0519
    classDef circle fill:#EFF6FF,stroke:#1D4ED8,color:#0b224e
    classDef arc fill:#F5F3FF,stroke:#6D28D9,color:#2a1065
    classDef plain fill:#FFFFFF,stroke:#D4D4D8,color:#18181b

    BUY["<b>Buyers</b><br/>AI agents on 6 frameworks · Circle Agent Stack CLI<br/>humans on onmerit.xyz · MCP clients"]:::plain
    DISC["<b>Discovery</b><br/>/.well-known/x402 · /api/openapi · /api/pricing"]:::plain
    PAY402["<b>x402 toll</b><br/>402 → pay → retry<br/>Circle Gateway nanopayments"]:::circle

    ENGINE["<b>Verification engine</b><br/>1 numeric (no model) → 2 NLI<br/>3 adversarial judge → 4 consensus jury (0G TEE)"]:::moat
    VERDICT["<b>Signed verdict</b><br/>verificationId = keccak256(canonical body)<br/>recoverable offline, without Merit"]:::moat
    DEC{"grounded?"}:::moat

    REFUSE["<b>REFUSED</b><br/>$0 moves — and the refusal<br/>is still recorded and signed"]:::refuse

    GUARDS["<b>Pre-flight guards</b><br/>Circle Compliance KYT (fails closed)<br/>tx simulation · spend caps · kill switch"]:::circle
    RAILS["<b>Settlement</b><br/>Gateway nanopayment · custody accrual<br/>ERC-8183 escrow released by the hook"]:::circle
    PAYOUT["<b>Payout on Arc</b><br/>Memo-wrapped USDC transfer<br/>Multicall3From for a batch"]:::arc
    REG["<b>ERC-8004 registries</b><br/>identity · reputation · validation"]:::arc
    EMIT["<b>Both USDC emitters</b><br/>ERC-20 6dp + EIP-7708 system 18dp"]:::arc
    OUT["<b>CCTP</b><br/>take earnings to Base / Arb / OP / AVAX"]:::circle

    PROOF["<b>Proof surfaces</b><br/>/proof ledger · /api/reconcile<br/>/api/memo · /v/[id] receipts"]:::plain

    BUY --> DISC --> PAY402 --> ENGINE --> VERDICT --> DEC
    DEC -->|no| REFUSE
    DEC -->|yes| GUARDS --> RAILS --> PAYOUT
    RAILS --> REG
    PAYOUT --> EMIT
    PAYOUT --> OUT
    EMIT --> PROOF
    REFUSE --> PROOF
    VERDICT --> PROOF
```

---

## 2. The money path

The one sequence that distinguishes Merit from every other payment rail: the payment is *conditional on the
work being right*, and the proof of that condition travels inside the transaction.

```mermaid
sequenceDiagram
    autonumber
    actor Agent
    participant Merit
    participant Engine as Verification engine
    participant Circle as Circle Gateway / Compliance
    participant Arc as Arc (USDC · Memo · ERC-8004)
    participant Creator

    Agent->>Merit: POST /api/verify/paid {claim, source}
    Merit-->>Agent: 402 + requirements (body AND header)
    Agent->>Merit: retry with EIP-3009 authorization
    Merit->>Circle: verify + settle (Gateway batched nanopayment)
    Circle-->>Merit: settled
    Merit->>Engine: numeric → NLI → adversarial judge
    Engine-->>Merit: signed verdict + verificationId

    alt SUPPORTED — the source really backs the claim
        Merit->>Circle: KYT screen the payee (fails CLOSED)
        Merit->>Arc: Memo.memo(USDC.transfer(creator, amount), memoId, memoData)
        Note over Arc: memoId derives from the payout digest ·<br/>memoData names the verificationIds ·<br/>callDataHash binds the memo to THIS transfer
        Arc-->>Creator: USDC (Transfer.from = Merit's EOA, sender preserved)
        Merit->>Arc: ERC-8004 reputation + validation write
        Merit-->>Agent: verdict + receipt + tx + memoId
    else REFUSED — the citation is not supported
        Merit-->>Agent: verdict + "$0 moved"
        Note over Creator: nothing is paid, and the refusal is<br/>recorded in the public ledger
    end

    Agent->>Merit: GET /api/reconcile
    Merit->>Arc: re-read both USDC emitters (6dp ERC-20 + 18dp EIP-7708)
    Merit-->>Agent: ledger→chain and chain→ledger, with the window it covered
```

---

## 3. Verification engine

Cost scales with how hard the check tries — never with retrieval. The first gate needs no model at all, which
is why a fabricated figure is still caught when every LLM provider is down.

```mermaid
flowchart LR
    IN["claim + source"] --> N

    N{"1 · Numeric gate<br/><i>deterministic</i>"}
    N --> |"figure contradicts source"| REF["REFUSED<br/>$0 settles"]
    N --> |"no numeric conflict"| NLI

    NLI{"2 · NLI<br/>factual consistency"}
    NLI --> |"entailment below floor"| REF
    NLI --> |"passes"| J

    J{"3 · Adversarial judge<br/>injection-resistant"}
    J --> |"unsupported"| REF
    J --> |"supported"| JURY

    JURY{"4 · Consensus jury<br/><i>premium tier</i><br/>0G TEE-attested panel"}
    JURY --> |"panel disagrees"| REF
    JURY --> |"panel agrees"| SUP["SUPPORTED<br/>payment may settle"]

    SUP --> SIG["Signed verdict<br/>EIP-191 over canonical JSON<br/>recoverable offline"]
    REF --> SIG

    classDef ok fill:#DCFCE7,stroke:#047857
    classDef no fill:#FEE2E2,stroke:#BE123C
    class SUP ok
    class REF no
```

**Measured, not asserted.** A forkable 275-case adversarial benchmark across 14 failure modes: **100% recall**
(every adversarial case caught — 197 held, 0 slipped) at 90.4% precision / 94.9% F1. The verifier is
conservative by design: it over-refuses roughly 30% of genuinely-supported claims rather than risk paying for
one that is not — the safe direction when the output is money. Reproduce with `npm run bench-judge`.

---

## 4. Where each Circle and Arc product is used

| Product | Where | What it does here |
|---|---|---|
| **Arc** (chain 5042002) | everywhere | Settlement chain. USDC-native gas, sub-second finality. |
| **USDC** | `lib/pay.ts`, `lib/custody.ts`, `lib/balance.ts` | The unit of account for every toll, payout and refund. |
| **Circle Gateway / Nanopayments** | `lib/seller.ts`, `lib/pay.ts` | x402 batched sub-cent tolls, both as seller and buyer (`@circle-fin/x402-batching`). |
| **Circle Developer-Controlled Wallets** | `circle-dcw/`, `lib/wallet.ts` | KMS-custodied payout wallet — no plaintext key on the server. |
| **Circle Compliance Engine** | `lib/compliance.ts` | KYT + denylist screen before any payout. Fails **closed**. |
| **CCTP** | `lib/crosschain.ts` | A creator takes verified earnings to Base / Arbitrum / Optimism / Avalanche. |
| **Arc `Memo`** | `lib/memo.ts` | The verdict travels inside the payment as an indexed on-chain event. |
| **Arc `Multicall3From`** | `lib/custody.ts` | k creators paid in one transaction, `msg.sender` preserved on every line. |
| **EIP-7708 system emitter** | `lib/reconcile.ts` | Independent second witness for every USDC movement, at 18 decimals. |
| **EIP-3009** | `lib/relay.ts` | Gasless funding — the payer signs, Merit broadcasts and pays the gas. |
| **ERC-8004** | `lib/reputation.ts` | Identity, reputation and **validation** registry writes — Merit fills the empty third slot. |
| **ERC-8183 + IACPHook** | `contracts/`, `lib/job.ts` | Escrow whose release is gated on the citation verdict, on-chain. |

---

## 5. Network configuration

Arc mainnet is not published yet — the Arc docs state that mainnet addresses are unavailable, and Circle's
Gateway SDK ships `arcTestnet` with no mainnet counterpart. So Merit treats the network as configuration, and
invents nothing:

```mermaid
flowchart LR
    ENV["ARC_NETWORK"] --> T["testnet (default)<br/>chain 5042002 · every address<br/>verified on the live chain"]
    ENV --> M["mainnet<br/>ARC_MAINNET_* env values"]
    M --> RDY["mainnetReadiness()<br/>names every missing value<br/>and what it gates"]
    RDY --> |"core: chainId + RPC + USDC"| GO["settlementReady"]
    RDY --> |"absent"| HONEST["feature degrades honestly —<br/>NEVER a testnet address<br/>substituted for a mainnet one"]

    classDef warn fill:#FEF3C7,stroke:#B45309
    class HONEST warn
```

`GET /api/health` reports the active network and the exact readiness state. Moving this deployment to Arc
mainnet is a set of environment variables, not a code change — proven by `tests/arc-network.test.ts`.
