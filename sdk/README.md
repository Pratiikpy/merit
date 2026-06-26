# @merit/sdk

The client for the **Merit trust layer** — verification, reputation, and settlement for agent commerce on
Arc. Any agent gets proof-of-citation + on-chain reputation + USDC settlement out of the box. Pure `fetch`,
zero dependencies; works against a local instance or a deployed one.

```js
import { Merit } from "@merit/sdk";

const merit = new Merit("http://localhost:3000");

const sources = await merit.discover("What is driving stablecoin adoption?");
const trusted = await merit.trust({ kind: "source", minMerit: 80 });
const quote   = await merit.quote(0.1, "StableData API");        // guarantee pricing (#17)

// Pay for verified work — pays only the sources that actually verify, refunds the rest.
const { receipt } = await merit.run("What is driving stablecoin adoption?", 0.5);

// Receipts are self-proving (signed); the SDK never asks you to trust it.
merit.submitReceipt(receipt); // → { signed, verifyWith: "npm run verify-all -- <receipt> <buyer>" }

// Appeal any verdict — re-derive the Auditor's judgment independently.
const verdict = await merit.openDispute("StableData API", "Cross-border settlement hit $40T in 2026");
```

## The tool surface (the PRD's protocol)

| method | does | endpoint |
|---|---|---|
| `discover(question, budget?)` | candidate sources | `GET /api/sources` |
| `trust({kind,role,minMerit,limit})` | reputation-ranked counterparties | `GET /api/trust` |
| `checkReputation(agentId)` | on-chain, recomputable reputation | `GET /api/reputation/:id` |
| `quote(coverage, source)` | guarantee premium (reputation-priced) | `GET /api/insure` |
| `run(question, budget, opts?)` | pay for verified work → signed receipt | `POST /api/run` (SSE) |
| `submitReceipt(receipt)` | how to verify the receipt server-free | — |
| `openDispute(source, claim)` | appeal a verdict | `POST /api/challenge` |

`opts` on `run` accepts `{ tier, discover, policy, validators }` — the spend guardrails (#6) and the
multi-validator consensus (#16) are all reachable through the SDK.

Run the reference agent end-to-end: `npm run sdk-demo` (with a Merit server up). Publishing to npm is the
optional, user-gated step — building and using it in-repo needs no publish.
