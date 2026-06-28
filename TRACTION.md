# Traction

*1547 verified settlements from 10 distinct on-chain payers · 2026-06-27.*

> **Honest disclosure:** these are **our own** 10 funded agents exercising Merit's agent-labor
> market — not external users. But the settlement is **real on Arc**: each payer funded its own Circle Gateway
> deposit on-chain (every wallet's balance dropped 20 → 18 USDC, with gas spent — verifiable on the explorer),
> then paid Merit specialists over x402. Each payment carries a **Circle Gateway settlement ID**; the 0x batch
> tx resolves when Gateway submits the batch. This is the same proof format the field's leaders report — the
> difference is *what* it backs: Merit's settlement is gated by proof-of-citation.

| metric | value |
|---|---|
| distinct on-chain payers | 10 |
| settlements (Circle settlement IDs) | 1547 |
| USDC settled | $10.0700 |
| on-chain Gateway deposits | 10 (each 2 USDC, verifiable: wallet 20 → 18) |
| batch-resolved 0x tx | 0 |

## Settlements (sample — Circle Gateway settlement IDs)

| payer | specialist | amount | settlement id |
|---|---|---|---|
| 0x7E4bC35C89… | scout | $0.006000 | `49b1c492-0ab6-4236-8…` |
| 0x7E4bC35C89… | ferret | $0.003000 | `26dd971e-ed12-4993-b…` |
| 0x7E4bC35C89… | scribe | $0.012000 | `74d62126-dd35-43b9-b…` |
| 0x7E4bC35C89… | quill | $0.006000 | `15fb5962-4244-4448-b…` |
| 0x7E4bC35C89… | auditor | $0.008000 | `235f2d3b-a1b4-4b9e-b…` |
| 0x7E4bC35C89… | tally | $0.004000 | `da50862b-b9fe-408b-a…` |
| 0x7E4bC35C89… | scout | $0.006000 | `f934dd75-677d-4996-b…` |
| 0x7E4bC35C89… | ferret | $0.003000 | `b244de58-28b5-4725-9…` |
| 0x7E4bC35C89… | scribe | $0.012000 | `9e511b22-7a36-45cd-b…` |
| 0x7E4bC35C89… | quill | $0.006000 | `53a2d6cf-1c95-40f2-b…` |
| 0x72DaeC67Bc… | ferret | $0.003000 | `08a75b2e-6e18-4578-8…` |
| 0x72DaeC67Bc… | scribe | $0.012000 | `06971e22-41e5-4097-8…` |
| 0x72DaeC67Bc… | quill | $0.006000 | `55f69605-ea01-4796-9…` |
| 0x72DaeC67Bc… | auditor | $0.008000 | `10e183db-d6a2-49e4-9…` |

## Methodology

Reproduce: `node scripts/fund-payers.mjs 10 20` → fund the wallets → `node scripts/multi-pay.mjs`. Verify
any payer's on-chain deposit by checking its USDC balance + tx history on https://testnet.arcscan.app.
External creators onboarded via `/onboard.html` are listed separately — that is the genuine-usage signal.
