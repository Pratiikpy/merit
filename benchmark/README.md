# Benchmark (M1/M7)

Honest, reproducible measurement of Merit's citation-faithfulness verifier — the replacement for any
hardcoded accuracy claim. Run `npm run bench-judge` (with the app serving) to score a labeled set and write
`results.json` (precision / recall / F1 / balanced-accuracy + **coverage**).

## Dataset format
A JSON array of labeled (claim, source) pairs:
```json
[
  { "source": "full source text…", "claim": "the exact claim citing it", "expect": "SUPPORTED" },
  { "source": "…",                  "claim": "a fabricated/unsupported claim", "expect": "REFUSED" }
]
```
Aliases accepted: `source|context|document`, `claim|statement|response`, `expect|label`.
Positive class = **REFUSED** (catching an unsupported/hallucinated citation is the task).

## Sets
- **Default:** `../lib/goldset.json` (16 hand-labeled pairs) — a fast smoke set, NOT a headline benchmark.
- **Published-grade (add these — see `../HUMAN.md` §4):**
  - **RAGTruth** (~18k word-level hallucination annotations, ACL 2024) → `benchmark/ragtruth.json`
  - **FaithBench** (diverse summarization hallucination benchmark) → `benchmark/faithbench.json`
  - **FACTS Grounding** (optional) → `benchmark/facts.json`
  Convert each to the format above (keep only source-grounded claim/label rows). Then:
  `BENCH_SET=benchmark/ragtruth.json npm run bench-judge`.

## Reading results
`results.json` reports metrics **over decided pairs only** and states `coverage` + `abstained`. A numeric-only
(keyless) deployment decides just the numeric pairs and says so — it never reports 100% by construction. For
full coverage set `LLM_API_KEY` and/or `MERIT_NLI_URL` (HUMAN.md §1). SOTA context: even GPT-4o/o3-mini land
<78% balanced accuracy on FaithBench, and small models (HHEM-2.1-Open, MiniCheck-7B) are competitive — so honest,
benchmarked numbers here are the credibility moat, not a round 100%.
