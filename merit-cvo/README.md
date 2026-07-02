# merit-cvo

**A free, self-hostable Citation Verification Oracle.** Given a `(claim, source)` pair it returns a
**SUPPORTED / REFUSED** verdict — so a RAG answer or an agent citation that *isn't actually backed by its
source* doesn't pass. Not another LLM grading an LLM: a **deterministic numeric check + a small NLI model +
an optional adversarial judge**, combined into a reproducible verdict you can run in CI or your own VPC.

Every other faithfulness tool *scores* with a single LLM judge (non-deterministic, gameable). merit-cvo is
**deterministic where it can be** (the numeric leg is unfoolable; the NLI leg is a fixed small model) and
**dual-gated where it matters** (strict mode requires the NLI leg *and* the judge to agree).

```bash
pip install merit-cvo
```

```python
from merit_cvo import verify_citation

v = verify_citation(
    "The company's Q2 revenue reached $5 billion.",
    "The company reported Q2 revenue of $2.0 billion.",
)
print(v.verdict, v.reason)   # REFUSED  The claim asserts $5 billion, which the source contradicts (...)
```

The **free path** (deterministic numeric + a self-hosted NLI server) needs **no LLM key and no third-party
Python deps** — it runs on `urllib` alone.

## The NLI leg (free, self-hosted)

Point it at the companion [`nli-server`](../nli-server) (Vectara HHEM-2.1-Open, Apache-2.0, CPU) — or any
compatible `{claim, source} -> {score}` endpoint:

```bash
export MERIT_NLI_URL=http://localhost:8000/score
```

or run the model in-process:

```bash
pip install "merit-cvo[hhem]"
export MERIT_NLI_MODEL=vectara/hallucination_evaluation_model
```

With no NLI and no LLM configured, the verifier still catches **fabricated numbers** deterministically and
**honestly abstains** (never guesses) on everything else.

## Strict dual-gate

```python
verify_citation(claim, source, strict=True)   # or export MERIT_STRICT_GATE=1
```

SUPPORTED only if **every** available model leg (NLI **and** the judge) independently confirms support —
highest precision, at a measured over-refusal cost. Add the LLM judge with an OpenAI-compatible endpoint:

```bash
export LLM_API_KEY=...  LLM_BASE_URL=...  LLM_MODEL=...
```

## pytest for citations

```python
from merit_cvo import assert_grounded, assert_not_grounded

def test_answer_cites_correctly():
    assert_grounded("Q2 revenue was about $2B.", "The company reported Q2 revenue of $2.0 billion.")

def test_catches_a_fabricated_number():
    assert_not_grounded("Q2 revenue was $5 billion.", "The company reported Q2 revenue of $2.0 billion.")
```

## CLI / CI gate

```bash
merit-cvo verify --claim "..." --source "..." --strict --json
# exit code: 0 = SUPPORTED, 1 = REFUSED, 2 = abstained  → gate your CI on grounded citations
```

## Verdict

`verify_citation()` returns a `Verdict`: `.verdict` (`SUPPORTED`/`REFUSED`/`None`), `.grounded`, `.score`
(NLI 0..1), `.methods` (which legs fired), `.reason`, `.model_tag`, `.source_hash`, `.to_dict()`. On an
undecidable keyless case it sets `.error` + `.status` (503) and `.ok()` is `False` — an honest abstain.

Apache-2.0. Part of [Merit](https://github.com/Pratiikpy/merit) — the verification-and-settlement rail for
the agent economy.
