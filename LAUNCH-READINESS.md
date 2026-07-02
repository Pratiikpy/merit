# Merit — Launch-Readiness Report

**Verdict: GO** for public demo / submission in the declared scope (testnet, STUB settlement). Every gap that can be closed without a user-provided secret is closed and **verified on the live deployment** (`https://merit-ecru.vercel.app`), with reproducible evidence via the `scripts/qa-*.mjs` harness. The one honest scope limit — real on-chain USDC settlement — is gated on a funded key (see below), and the code path for it is fully built.

This report is held to the proof-first bar of `TEST-PLAN.md`: every green below is a real assertion against a source of truth, not "it looked fine."

## Evidence table

| Area | Result | Proof |
|---|---|---|
| Unit tests | 🟢 273 passing | `npm test` (STUB) |
| Lint / build | 🟢 clean | `npm run lint` · `npm run build` |
| API contracts (26 routes) | 🟢 39/39 | `scripts/qa-api.mjs` → all routes, negative statuses, security headers |
| IDOR / authz | 🟢 safe | unknown ids → 404; `admin/keys` → 403; verify/paid → 402 |
| Verify engine | 🟢 correct | numeric REFUSED (no-LLM); contradiction REFUSED (nli 0.004 + judge); supported SUPPORTED (0.86) |
| Signatures | 🟢 recover offline | verdict + audit-export + run-summary signers all recover to `0x0fc4…` |
| Audit log (EU AI Act) | 🟢 durable + valid | mirror-authoritative read-your-writes; count accumulates; `chain.valid: true` |
| Run / settlement loop | 🟢 6/6 | `scripts/qa-run.mjs` → terminal state, money conserved (0.03636+0.087=0.12336), signed |
| Pages — desktop | 🟢 7/7 | HTTP 200, 0 console errors, no overflow/broken-img/sentinels |
| Pages — mobile (390px) | 🟢 7/7 | same, iPhone-13 emulation |
| Accessibility (WCAG 2.1 AA) | 🟢 0 violations | `scripts/qa-a11y.mjs` (axe-core) on all 7 pages |
| Repo / docs / links | 🟢 0 findings | `scripts/qa-repo.mjs` → 11 links resolve, no secrets, no AI-slop |
| Repo hygiene | 🟢 clean | HUMAN.md gitignored + untracked; 0 co-author trailers; 0 tracked secrets |
| Element / copy inventory | 🟢 enumerated | `scripts/qa-inventory.mjs` → every element + string, all pages |

## Fixed in this launch-readiness pass

- 🟠→🟢 **Audit log durability** — was serving a stale per-instance copy on warm serverless (counts lagged, latent chain-fork risk under concurrent writes). Routes now refresh from the durable mirror before appending/exporting (read-your-writes). Verified: count grows in ~2.5s, chain stays valid.
- 🟡→🟢 **Run receipt** — added `escrowed` to the signed totals so `released + refunded` reconciles from the receipt itself.
- 🟡→🟢 **README drift** — test-count badge/table corrected 269 → 273.
- 🟠→🟢 **WCAG-AA color-contrast** — 6 elements across 4 pages nudged to darker shades of the existing palette (approved minimal change); axe now reports 0 violations.

## Known limits — stated honestly

- **STUB settlement:** production runs `mode: stub` (no `BUYER_PRIVATE_KEY`), so run/settlement amounts are **simulated** — no on-chain USDC, no arcscan tx. The full payment path is built and flips to real settlement the moment a funded Arc-testnet key is configured.
- **Audit concurrency:** the mirror stores the log as one row (last-writer-wins). The read-your-writes refresh fixes the observed staleness and the common clobber; a durable append-only `merit_audit_entries` table is tracked for post-launch hardening against high-concurrency races.
- **Not covered by this pass (out of scope):** Lighthouse perf score (no CLI in this env → run in CI), live-driving the onboard/passport *forms* against prod (would pollute prod state; covered at the API level), a subjective human taste pass, and the ERC-8183 settlement-contract Foundry audit (contract not yet deployed).

## User-gated next steps (to raise the ceiling)

1. **Funded Arc-testnet `BUYER_PRIVATE_KEY`** → flips prod to real on-chain settlement (verifiable on arcscan). This is the traction unlock.
2. **PyPI token** → publish `merit-cvo` (`pip install merit-cvo`).

## Reproduce

```
node scripts/qa-inventory.mjs   # element + copy inventory (+ L0 render/console/overflow)
node scripts/qa-api.mjs         # routes, IDOR, signatures, audit chain, reconciliation
node scripts/qa-run.mjs         # SSE run: terminal state, money conservation, signed receipt
node scripts/qa-a11y.mjs        # axe-core WCAG 2.1 A/AA
node scripts/qa-repo.mjs        # docs links, secrets, copy hygiene
```
Set `QA_BASE=http://localhost:3011` to run against a local server.
