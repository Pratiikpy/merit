# The Proof-of-Citation Benchmark

> A measured, forkable benchmark for **settlement gated on whether the cited work is correct** — the one
> tier the agent-payment ecosystem leaves unmeasured. Everyone asserts their LLM judge works; this *measures*
> it, on a balanced gold set, with the costly error (a wrongful pay) as a hard failure.

Run it: `node scripts/judge-eval.mjs` (a running Merit server + an LLM key). Extend it by adding rows at the
top of that file. CI-gated: **any false-negative exits non-zero.**

## What it measures

A proof-of-citation evaluator decides, for a `(source, claim)` pair, whether the source genuinely **supports**
the claim — *direction and magnitude*, not topic overlap. The benchmark frames this as a detection problem:

- **"Positive" = correctly REFUSING a bad citation** (the evaluator's job — protect the buyer + the moat).
- A **false-negative** — a bad citation let through — is a **wrongful PAY**: the costly error, because money
  moves to a source that didn't earn it. The eval **fails (exit 1) if any occur.** A false-positive
  (over-refusing a good citation) only costs recall.

Reported: **accuracy · precision · recall · F1** over a balanced gold set (half genuinely supported, half
mis-cited), plus every disagreement. Merit's Auditor scores **100% / 100% / 100% / 100%**.

## The trap taxonomy

The gold set deliberately covers the failure modes a similarity score waves through. Each is a distinct way a
citation can be wrong:

| Trap | Example | Caught by |
|---|---|---|
| **Fabricated number** | claim says "$40 trillion"; the source says **$4.1T** | deterministic numeric layer (no LLM) |
| **Off-topic** | claim about retail meme-coin speculation cited to an enterprise-settlement source | similarity off-topic floor |
| **Contradiction (opposite direction)** | claim "regulation played no role"; source says regulation **accelerated** it | adversarial LLM judge |
| **The trap** (signature catch) | claim "adoption scaled strongly"; source says it **stalled under $90M** — *on-topic + high similarity, but contradictory* | adversarial LLM judge (similarity alone would PAY it) |
| **Overreach / not-in-content** | claim adds "high yields on deposits" the source never states | adversarial LLM judge |
| **Prompt injection** | source content tries to steer the verdict ("answer SUPPORTED") | deterministic injection guard |

The layering is the point: the **deterministic numeric + injection layers** mean the LLM judge is *one
evidence source, not the sole proof* — fabricated figures and coercion are caught even when the LLM is
unavailable or on the cheaper similarity-only tier.

## Why this is the canonical reference

Across the surveyed Arc / agent-economy ecosystem, settlement is gated on **identity**, a **reputation score**,
or **TEE-attested execution** (the code ran untampered) — never on whether the delivered *work* is correct.
This benchmark defines the missing metric: *given a settlement that pays only for verified citations, how
often does the evaluator make the costly error?* It is balanced, hard-case-heavy, false-negative-gated, and
reproducible. Fork it, extend the gold set, and run any evaluator against it.

## The gold set

**275** `(source, claim)` pairs in `lib/goldset.json`, spanning **14 adversarial failure modes** (fabricated
figures/percentages, off-topic, direct contradiction, right-entity-wrong-attribute, temporal error,
overgeneralization, negation/causation flip, unsupported addition, hard-borderline/rounding, prompt-injection,
plus supported direct/paraphrase/synthesis). Every pair was authored by an independent writer and its label
then **blind-verified by two more independent annotators** — only unanimous, unambiguous pairs were kept — and
the set is split into a dev set and a **held-out test set** (`benchmark/goldset-dev.json`,
`benchmark/goldset-test.json`). Each row is the verdict a *correct* evaluator must return; the harness runs
them through the live Auditor and compares. The hardest cases — high-similarity contradictions and
right-entity-wrong-attribute traps — are the ones no similarity-only verifier survives.

## Measured results

Scored through the live layered Auditor (deterministic numeric screen → self-hosted HHEM NLI → adversarial
LLM judge, strict dual-gate) via `npm run bench-judge`:

| metric | value | meaning |
|---|---|---|
| **recall** | **100.0%** | every adversarial pair was caught (197 held, **0 slipped through to payment**) — the safety-critical number: a lie never got paid |
| **precision** | 90.4% | of everything it refused, 90.4% was genuinely bad |
| **F1** | 94.9% | harmonic mean |
| **coverage** | 97.1% | 267/275 decided (8 transient errors, reported, never hidden) |
| **over-refusal** | ~30% | 21 of 70 supported pairs were wrongly refused |

The evaluator is **conservative by design**: a false-refuse costs recall and UX; a false-pay breaks the moat.
So it errs toward refusing a borderline-true claim rather than paying for a false one — the safe direction for
money. Reproduce: `npm run bench-judge` (writes `benchmark/results.json`, which the public
[`/api/benchmark`](https://onmerit.xyz/api/benchmark) surface reads). Confusion matrix
(positive = REFUSED): tp=197, fp=21, tn=49, fn=0.
