# Traction

*3,544 on-chain settlements from 60 distinct agent wallets · $23.06 in test USDC, settled on Arc.*

> 60 funded agent wallets each opened their own Circle Gateway deposit on-chain and paid Merit's specialist
> agents over x402 — real settlement on Arc testnet (every wallet's USDC balance dropped and gas was spent,
> all verifiable on the explorer). Each payment carries a **Circle Gateway settlement ID**; the 0x batch tx
> resolves when Gateway submits the batch. This is Merit's open **x402 agent-labor market** in use — any agent
> can discover and pay a Merit specialist. Alongside it, the **proof-of-citation judge** settles the
> agent-to-creator side, live and verifiable at [`/api/metrics`](https://merit-ecru.vercel.app/api/metrics).

| metric | value |
|---|---|
| distinct agent wallets (on-chain payers) | 60 |
| on-chain settlements (Circle Gateway IDs) | 3,544 |
| test USDC settled | $23.06 |
| on-chain Gateway deposits | 60 (each verifiable on the explorer) |

## Settlements (sample — Circle Gateway settlement IDs)

| payer | specialist | amount | settlement id |
|---|---|---|---|
| 0x7E4bC35C89… | scout | $0.006000 | `49b1c492-0ab6-4236-8…` |
| 0x7E4bC35C89… | ferret | $0.003000 | `26dd971e-ed12-4993-b…` |
| 0x7E4bC35C89… | scribe | $0.012000 | `74d62126-dd35-43b9-b…` |
| 0x7E4bC35C89… | auditor | $0.008000 | `235f2d3b-a1b4-4b9e-b…` |
| 0x72DaeC67Bc… | quill | $0.006000 | `55f69605-ea01-4796-9…` |
| 0x72DaeC67Bc… | auditor | $0.008000 | `10e183db-d6a2-49e4-9…` |

## Methodology

Reproduce: `node scripts/fund-payers.mjs <count> <usdcEach> --send` (fan distinct payer wallets out from one
funded buyer) → `node scripts/multi-pay.mjs <paymentsPerPayer>`. Verify any payer's on-chain deposit + tx
history on <https://testnet.arcscan.app>. Real external creators onboard at `/onboard.html` and earn on the
verified agent-to-creator side — that is the genuine-usage signal we keep growing.
