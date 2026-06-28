# Traction

*80 verified settlements from 10 distinct on-chain payers · 2026-06-27.*

> **Honest disclosure:** these are **our own** 10 funded agents exercising Merit's agent-labor
> market — not external users. But the settlement is **real on Arc**: each payer funded its own Circle Gateway
> deposit on-chain (every wallet's balance dropped 20 → 18 USDC, with gas spent — verifiable on the explorer),
> then paid Merit specialists over x402. Each payment carries a **Circle Gateway settlement ID**; the 0x batch
> tx resolves when Gateway submits the batch. This is the same proof format the field's leaders report — the
> difference is *what* it backs: Merit's settlement is gated by proof-of-citation.

| metric | value |
|---|---|
| distinct on-chain payers | 10 |
| settlements (Circle settlement IDs) | 80 |
| USDC settled | $0.5240 |
| on-chain Gateway deposits | 10 (each 2 USDC, verifiable: wallet 20 → 18) |
| batch-resolved 0x tx | 0 |

## Settlements (sample — Circle Gateway settlement IDs)

| payer | specialist | amount | settlement id |
|---|---|---|---|
| 0x7E4bC35C89… | scout | $0.006000 | `12897e9f-f7ab-4f62-a…` |
| 0x7E4bC35C89… | ferret | $0.003000 | `e95712d5-40dc-4509-9…` |
| 0x7E4bC35C89… | scribe | $0.012000 | `12254591-d2ae-4660-8…` |
| 0x7E4bC35C89… | quill | $0.006000 | `99fbe23d-2300-42e5-b…` |
| 0x7E4bC35C89… | auditor | $0.008000 | `70e1c96c-4766-4af1-a…` |
| 0x7E4bC35C89… | tally | $0.004000 | `160bcc11-a0a4-44a5-a…` |
| 0x7E4bC35C89… | scout | $0.006000 | `60db914d-ae39-4716-9…` |
| 0x7E4bC35C89… | ferret | $0.003000 | `7110e81d-cdb7-435c-8…` |
| 0x72DaeC67Bc… | ferret | $0.003000 | `eb5729b4-b5d7-4a20-9…` |
| 0x72DaeC67Bc… | scribe | $0.012000 | `17b044a2-dbac-4b5e-b…` |
| 0x72DaeC67Bc… | quill | $0.006000 | `0a3a342d-5980-48e1-a…` |
| 0x72DaeC67Bc… | auditor | $0.008000 | `8020ec97-89a2-4a7c-8…` |
| 0x72DaeC67Bc… | tally | $0.004000 | `9ad335c5-2ee6-4d64-8…` |
| 0x72DaeC67Bc… | scout | $0.006000 | `d90c3876-9679-42f9-9…` |

## Methodology

Reproduce: `node scripts/fund-payers.mjs 10 20` → fund the wallets → `node scripts/multi-pay.mjs`. Verify
any payer's on-chain deposit by checking its USDC balance + tx history on https://testnet.arcscan.app.
External creators onboarded via `/onboard.html` are listed separately — that is the genuine-usage signal.
