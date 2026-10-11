# Merit as a platform — researched, not guessed

Written 2026-10-11, before any of the four OS modules were built, because the first one I nearly
started on (an open agent marketplace) turned out to already exist at a scale that would make it a
losing fight. This document is the research that changed the plan, and the plan it produced.

## What's already out there (checked, not assumed)

**TermiX / agent.family** — the serious one. 400,000–520,000+ jobs settled on-chain, $20–27M+
processed, 400,000+ agents indexed, 2% take rate. Open TS/Python/Go SDKs. The mechanism, read
directly from their docs: an agent posts a job → a provider quotes → escrow locks on accept → the
provider delivers and a **deliverable hash** is written on-chain → a **challenge window** opens →
if nobody challenges, escrow releases against the hash. If someone does challenge, **three random
evaluators** rule, and a failed challenge burns the challenger's bond.

That is NOT a machine oracle. It is a deliverable-hash-matches-submission check, with disputed
cases kicked to a committee — reactive, bond-gated, and it never asks whether the delivered
*content is true*. A fabricated citation that's formatted correctly passes clean unless someone
pays a bond to challenge it. Runs on BSC, Base, and their own chain ("rh") — multi-chain by design,
not Arc-specific, but the mechanics would port anywhere, including here, the moment they wanted to.

Building a second, smaller version of this on Arc is not a fight worth having. They have the
network effect (472K agents already registered); Merit does not, and chasing it would mean
competing on the one axis (scale, liquidity of supply/demand) where a seven-month head start is
close to insurmountable.

**ARCANA** — Financial AI Agents that trade markets, build a track record, and now (shipped
October 2026) convert that record into credit: tiers from 250 to 5,000 USDG, scaling with
performance, repayment history, and risk behavior. ~110K agent decisions, ~$2.3K settled volume —
modest, real, and the *exact* shape I'd have proposed for an agent-credit module. Good validation
that "performance → reputation → unlocked credit" works as a mechanism. Different domain entirely
(trading agents, not research/verification agents) — not a direct competitor, but worth matching
the pattern rather than reinventing it.

**AgentVault + MandateEscrow** (a solo builder, live on Arc mainnet, real money, source-verified) —
the closest prior art to "autonomous business." An agent that pays its own bills inside owner-set
limits (per-payment cap, daily cap, payee allowlist, pause switch) it can never exceed or escape —
funds sit in a vault the agent cannot withdraw from, only spend from inside the rails. MandateEscrow
is deliberately **open**: "any other agent, any other builder, can use it today with their own
funds, no permission needed." SDK + MCP server + a public dashboard reading real balances,
obligations, and decisions. This is the right shape for bounded autonomous spending, already proven
on Arc, already open for anyone to build on. Worth evaluating as something Merit's autonomous loop
*composes with* rather than a reason to hand-roll a second spend-cap primitive.

**Syn DAO** — enterprise treasury automation on Arc mainnet: three-way match (PO == Receipt ==
Invoice), autonomous spend caps with dual-key human review, CCTP V2 + Earn Kit. B2B
vendor/contractor payout automation — a real, live Arc project, but a different domain (accounting
controls, not content verification) with no meaningful overlap.

**Nobody found doing citation/factual-grounding verification as an automated settlement gate, on
Arc or elsewhere searched.** The closest adjacent signal is a widely-shared Google Cloud AI
Research / Cambridge finding making the rounds this week: sampled model agreement can share the
same blind spot, and disagreement is often where the correct answer is hiding — independent
external validation of the exact design choice Merit's jury already made (diverse, uncorrelated
model families over majority-vote sampling of similar ones). Worth citing in Merit's own materials
as outside confirmation, not just a Merit-authored claim.

## What this actually means for the plan

The four directions I proposed (autonomous business / open marketplace / agent credit / global
payouts) were framed as four products to each independently "own a category." That framing doesn't
survive the research. Two of the four already have strong, live Arc-native prior art (AgentVault for
bounded autonomy, Syn DAO for treasury ops) and one has an off-Arc incumbent at a scale no amount of
building catches up to on category terms alone (TermiX for generic agent marketplaces). Building
four separate, competing products would mean losing at least two of those fights on the merits
and duplicating the other two.

**The defensible shape: verification is the platform, not one module among four.** Every other
project surveyed either doesn't check content truth at all (TermiX, AgentVault, Syn DAO — they check
that *something* happened inside *bounds*) or checks a different kind of truth (ARCANA checks
trading performance against the market, not a claim against a source). Merit is the only one
checking "does this specific source actually support this specific claim," automatically, for free
at the first gate, with no bond and no challenge window required to get a real verdict. That's a
genuinely different trust primitive, and it's the one piece none of these four would need to
duplicate even if they wanted to — they'd plug into it.

So the build order inverts from "four parallel products" to "one oracle, instrumented four ways":

1. **The verification oracle becomes explicitly consumable by outside callers, not just Merit's own
   UI.** It already is, technically (`/api/verify`, `/api/verify/paid`, OpenAPI published) — what's
   missing is positioning it as infrastructure other agent-economy projects would integrate, not
   just a feature of Merit's own site. A TermiX-style marketplace, an AgentVault-style spend-capped
   agent, or an ARCANA-style trading agent could each call Merit before paying, exactly the way
   Insurance and PredictionMarket already do internally. This is the actual "own the category" move:
   not out-building the marketplace, being the thing marketplaces are missing.

2. **Autonomous business (build this first, as Merit's own flagship, not a separate product)** — a
   scheduled, always-on loop with a real, continuously-published treasury: what the oracle itself
   earns (x402 tolls, verify-paid sales) against what it pays out (specialists, creators, insurance
   premiums), running without a human clicking a button. This is simultaneously: Arc's own named
   archetype ("zero-person companies that earn, spend, and settle entirely onchain"), the best
   possible demonstration that the oracle is trustworthy enough to run unattended, and — evaluated
   against AgentVault's bar — it should compose with MandateEscrow's bounded-spend pattern for the
   payout leg rather than re-inventing caps/allowlists/pause from scratch.

3. **Agent credit, matched to ARCANA's validated shape but keyed on verification record, not
   trading P&L** — a creator or specialist whose cited work keeps verifying (low refusal rate over
   real volume) earns a track record Merit's existing Stake.sol can extend: not just "stake to be
   trusted," but "proven record unlocks borrowing against future verified earnings." Composes
   directly with contracts already deployed (Stake, Insurance) rather than needing a new primitive.

4. **Global verified payouts (StableFX)** stays the one genuinely new frontier with zero prior art
   overlap found — pay creators in EURC or local currency, still gated on the same verification.
   Lowest research risk, because nobody's doing it; also the smallest piece, saved for after the
   oracle-as-infrastructure and the autonomous loop are real.

Microgrants-relevant point, independent of the above: Arc's own Developer Grants page lists
"agentic economic activity" and "prediction markets" as explicit #1 priorities, and nothing in this
research changes that Merit already has stronger, more technically credible, more verifiably-real
coverage of both than most things likely to be submitted. The strategic correction above is about
what gets built *next*, not a reason to doubt what already shipped.
