# Merit — the verification + reputation layer for agent commerce

**Agents pay agents *and* creators — but only for work that verifies.**

Merit is a research agent on Arc that, given a question and a USDC budget, runs an autonomous
research firm: a lead agent **hires specialist sub-agents** (search → write → verify) and **pays
the creators** whose sources it actually cited — settling real sub-cent USDC to each, and
**refusing to pay** anything that doesn't verify. Reputation accrues on-chain (ERC-8004) for both
agents and creators, and governs who gets hired next.

---

## The problem

Today's agent payments are **pay-then-pray**:
- An agent pays a flat fee for data or work with **no proof it was actually used**. Creators get
  scraped; honest ones can't prove their worth.
- As agents start **hiring other agents**, there's no layer that verifies the delivered work or
  carries a portable track record — so you can't safely pay a sub-agent you don't already trust.
- The new **rails** (x402, Skyfire, Nevermined, Coinbase's Bazaar) move money; the new **wallets**
  (Catena, Circle's own Agent Wallets) govern *spend*. Neither decides **who earned it** — whether
  the work was actually delivered. That verification layer is the white space, and it's the one piece
  Circle deliberately left to builders: it shipped the primitives and an escrow *demo*, not the product.

Building another agent wallet means losing to Catena ($48M) and to Circle itself. Merit takes the
open lane instead — **verification-native settlement + portable reputation** — and gives agents what
their builders actually ask for: not unbounded autonomy (a "dangerous fantasy"), but **bounded
authority with machine-verifiable receipts and a replayable audit trail.**

## What Merit adds

A trust layer that makes payment **conditional on proven, used value** — on both sides of the market:

- **Agent → creator.** The agent writes a cited answer, then the **Auditor** (its verify
  specialist) runs **proof-of-citation** — a *layered* check that rules whether each source
  *actually backs the specific claim* citing it, not merely shares its topic. A **deterministic
  numeric check** (any $ or % figure the claim asserts must trace to the source — a fabricated number
  caught with **no LLM at all**), an identity gate, and a similarity score gate it; the adversarial
  **LLM judge** is the deepest layer, **not the sole proof** — so a fabricated figure is refused even
  with the judge offline. Cited, verified *and* supported → release USDC, and **every receipt
  shows the exact claim the source was cited for next to the Auditor's verdict** ("confirms regulatory
  clarity from MiCA/GENIUS" — or, for the trap, *cited for* "corroborates the scale" → "the source
  contradicts the claim — refused"). Un-cited, unverified, or contradicted → **refund**, with the
  reason shown. That refusal — claim laid bare next to verdict — is the product.
- **Agent → agent.** The lead **hires the highest-reputation** specialist for each role, pays it
  over x402 **only after grading its delivered work**, and writes its outcome to on-chain
  reputation. The roles genuinely specialize: the pro Scribe writes thoroughly and the pro Auditor
  runs the LLM judge, while the budget Quill writes terser and the budget Tally does
  **similarity-only** (no LLM judge) — a real, priced quality difference: the economy crew is cheaper
  but can't catch a hollow citation the Auditor would. A cheaper, unproven rival has to earn merit first.
- **Portable reputation, provably so.** Every release/refuse is a signed receipt and an ERC-8004
  feedback event — independently recomputable from chain for any agent or creator. Not just asserted:
  `npm run recompute -- <agentId>` rebuilds the exact score from raw Arc logs with **no Merit server
  and no cache**, so anyone can verify it. The Auditor's verdict is also written to the canonical
  **ValidationRegistry** — Merit uses all three ERC-8004 registries (identity, reputation, validation).

This is the gap the other rails leave open: **anyone can pay; only Merit decides who earned it.**

## Why Arc

One research job is **dozens of sub-cent agent-to-agent payments**. On card rails the fees dwarf
the labor; on a gas-metered chain, gas kills the loop. Arc's **gasless, sub-cent, sub-second USDC**
settlement is what makes an agent-labor market economically viable at all. Merit also uses Circle's
x402 + Gateway batching for the payments and **all three** ERC-8004 registries — identity, reputation,
and validation (the Auditor's proof-of-citation verdict is written to the canonical ValidationRegistry) — the native stack, used in full.

The interface stays **standards-agnostic**: x402 settlement today, the verdict in canonical ERC-8004, and
Merit exposed as an **MCP tool** any Claude/Gemini/OpenAI agent can call — so it rides the agent-payment
standards (x402, AP2, ACP) as they shake out, rather than betting the product on one.

## Proof it's real (not a mock)

- **Real USDC settles on Arc testnet** — every release/refund and reputation write has a tx on
  `testnet.arcscan.app` (click any merit score or receipt in the demo).
- **Two-sided, on-chain reputation** for specialists *and* creators, verifiable from chain —
  `npm run leaderboard` ranks the entire market by it in one view, where the moat's refusals show up as
  **negative** portable reputation (the cited-but-contradicted trap at −20), not just a withheld payment.
- **Specialists are standalone x402 services** — each returns a real `payment-required` challenge,
  so any external agent can discover and pay one directly (open market, not internal plumbing).
  `npm run external-hire` proves it: a separate process discovers a specialist and settles real
  USDC to its wallet — no Merit lead involved.
- **The moat is demonstrable, not asserted:** `npm run audit-demo` feeds the Auditor a genuine
  citation, two contradictory ones, and a **prompt-injection attempt** — and shows it pay the real
  one while **refusing** the contradictions *and* the injection (robust to manipulation);
  `npm run compare-crews` puts the pro vs economy crew side by side (LLM judge vs similarity-only,
  reputation, cost, outcome); and `npm run moat-value` quantifies the **economic** case — the spend
  a *pay-then-pray* rail wastes on the sources Merit refused (off-topic data + an unverifiable
  identity) vs Merit paying only for verified value. The moat as money protected, not a claim.
- **The moat, measured — not just asserted.** `npm run judge-eval` runs the Auditor over a hand-labeled
  gold set of 16 (source, claim) pairs — supported vs mis-cited (off-topic, contradictory, a **fabricated
  number** caught by the deterministic numeric layer with no LLM, and the trap both directions) — and
  scores the layered Auditor's accuracy: currently **100% precision · 100%
  recall · F1 100%** (adapting FinGPT's HaluEval method). Most projects *assert* their LLM judge works;
  Merit **measures** it — and a false-negative (a wrongful pay) fails the eval. The moat is a reproducible number.
- **Every run emits a `summary` receipt** — one self-contained object with every verdict, the
  Auditor's reason, and the on-chain tx, plus the crew paid and budget totals. The receipt is the
  **atomic unit the whole system compounds on** — audit, reputation, and dispute all read from it —
  and it's independently checkable, never trusted.
- **Don't trust — verify, in one command.** `npm run verify-all -- <receipt> [buyer]` recovers the
  receipt's signature (pinning it to the payer) and reads **every** paid/refused decision back from the
  ERC-8004 ValidationRegistry, **cross-checking each against the receipt** — a "paid" source must read
  100/100 on-chain, a "refused" 0/100, all by the pinned Auditor. Proof the receipt **cannot lie**; any
  divergence is flagged. (Four more verifiers each prove one claim, server-free: `recompute` the
  reputation · `verify-validation` the verdict · `verify-receipt` the signature · `verify-settlement` the money.)
- **Challenge the verdict — the dispute path the agent economy still lacks.** Disputes and liability are flagged industry-wide as *unsolved*; Merit ships the appeal. Every check above proves a recorded *fact*; `npm run challenge -- "<source>" "<claim>"` re-derives the Auditor's **judgment** on any (source, claim) pair, independent of any run, reporting SUPPORTED/REFUSED. A refused creator appeals; a skeptic confirms a refusal holds. A **fabricated-figure** appeal resolves *deterministically* (the machine-verifiable numeric layer — no LLM, so it stands even under provider throttling); the rest re-run the judge. Live-proven: the trap stays refused, a matching claim is supported, and a trusted source is **not** rubber-stamped for a claim it doesn't back. The Auditor is accountable, not a black box.
- **Engineered, not vibes:** 273 unit + 54 end-to-end smoke tests (incl. the pure crew-grade +
  budget-guard logic and the Auditor-reply parser); **eight independent reviews — two code-quality,
  two security (attack-surface + frontend), silent-failure, test-coverage, comment-accuracy,
  type-design** — findings triaged + fixed (prompt-injection hardening on the judge
  **and** the public input endpoints, error/internal-detail scrubbing, budget-clamp, run-context TTL,
  HSTS+CSP, a concurrent-run guard, receipt-integrity, a keyboard-accessible UI, and a type
  refactor that makes inconsistent verdicts unrepresentable). Whole-run budget invariant proven
  (`labor + payouts ≤ budget`, even at budget 0). `npm run preflight` verifies a live deploy in one command.

## See it in 60 seconds

1. `npm run start` → open `/`, hit **Run agent** (default question + $0.50 budget).
2. Watch the **Agent crew** panel: the lead hires Search/Write/Verify specialists, paying each only
   for verified work — and shows who it **chose over** their cheaper rivals (reputation-gated).
3. Watch the **candidate sources**: cited + verified creators get paid sub-cent USDC — each receipt
   showing **the Auditor's reason** it earned payment; the rest are **refused**, each with its reason —
   un-cited, an unverifiable identity, and (the moat) one **cited but contradicted**: the source argues
   the *opposite* of the claim, so the Auditor refuses it where a similarity check would have paid.
4. Click any **creator** → its on-chain reputation drawer (the ERC-8004 ReputationRegistry + a
   server-free `recompute` command). Click any **receipt** → the settlement tx. Hit **Compare crews**
   for the pro-vs-economy verification market side by side, or toggle **Live web** to discover and pay
   *real* publishers from RSS.
5. **Then prove it — don't trust the UI.** In the terminal: `npm run judge-eval` scores the Auditor
   **100% precision / 100% recall** on a hand-labeled gold set (the moat *measured*, not asserted);
   `npm run prove -- <receipt>` re-checks the whole run against Arc *and* re-audits a verdict live;
   `npm run leaderboard` ranks the on-chain reputation economy (refusals show as **negative** portable
   reputation); `npm run moat-value` quantifies the spend a *pay-then-pray* rail wastes. Every headline
   claim has a one-command proof.

> Merit is the settlement + trust layer an agent economy needs: agents paying agents and creators,
> gated on proof-of-work, with reputation that travels. Built on Arc because nothing else makes
> sub-cent agent labor pay.
