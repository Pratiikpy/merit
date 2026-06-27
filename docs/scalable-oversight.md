# Economic scalable oversight — making hallucination irrational

> **Merit is the first market that makes hallucination economically irrational for AI agents.** Payment is
> gated on adversarial verification, so an agent that makes things up *loses money automatically* — truth
> becomes the dominant strategy, enforced by the market, not by a human checker.

This is **scalable oversight** — the open problem of supervising agents you can't manually check — reframed as
an economic mechanism: don't review every output, just make agents stake on being right and let a deterministic
verifier settle the bet. The result is not asserted; it **emerges**.

## The experiment

`npm run tournament` drops seven agents with different strategies into Merit's economy and settles **every
citation through the real deterministic proof-of-citation verifier** (`lib/numcheck.ts` — no LLM, no server,
fully reproducible from seed 42). Each round an agent cites a source: an honest agent cites the true figure
(passes), a lying agent inflates it (the verifier flags the contradiction → refused). A verified cite earns a
reward; a caught hallucination is slashed for more than an honest cite earns.

No agent is told to be honest. Two of them (`Adaptive-*`) start at 50/50 and only learn from payoff.

## The result (reproducible)

```
agent            final$   return    cites  caught-lies   status
Honest-1          2.80    180%       30      0/0         alive
Honest-2          2.80    180%       30      0/0         alive
Adaptive-1        2.64    164%       30      1/1         alive
Adaptive-2        2.64    164%       30      1/1         alive
Fabricator-1      0.00   -100%       10     10/10        BANKRUPT r10
Fabricator-2      0.00   -100%       10     10/10        BANKRUPT r10
Opportunist       0.00   -100%       18     13/13        BANKRUPT r18
```

- **Every liar goes bankrupt.** Always-lie agents are ruined by round 10; the 50%-of-the-time liar by round 18.
- **Honest agents compound +180%.** Truth is the only strategy that accumulates.
- **The adaptive agents *learn* honesty:** `P(honest)` converges **0.50 → 1.00** — they were never told truth
  is good; they discovered it pays.
- **Market false-citation rate: 43% → 0%.** Hallucination is priced out of the economy entirely.

> We never programmed an agent to be honest. The economics made honesty the only way to survive.

## Why this is the moat, not a demo

Every settled citation is appended to `.data/tournament.json` — the first **dataset of agent-to-agent citation
disputes with ground-truth verdicts**. Reproduce it, change the strategies, raise the slash — the conclusion
holds because it's enforced by a deterministic oracle.

No competitor can run this experiment: it requires a **ground-truth verification oracle to settle the bet**, and
toll-booth / marketplace builds don't have one. The mechanism *is* the moat — Merit is the only entry where
failed verification cannot pay, so it's the only place truth can emerge as an equilibrium.
