# Merit NLI backend

A **free, self-hostable, CPU-only** factual-consistency scorer that turns Merit's verifier into a real
**dual-gate** — a deterministic numeric check + an encoder-NLI leg + the adversarial LLM judge — instead of
leaning on a rate-limited LLM for every citation. No paid API, permissive-licensed models only.

It implements the exact contract Merit's engine (`lib/verify/nli.ts`) calls:

```
POST /score   { "claim": "...", "source": "..." }  ->  { "score": 0.0..1.0, "support": ..., "model": "..." }
```

`score` = probability the **source supports the claim** (0 = unsupported/contradicted, 1 = fully supported).

## Run it (one command)

```bash
docker build -t merit-nli .
docker run -p 8000:8000 merit-nli
```

or locally:

```bash
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn server:app --port 8000
```

## Point Merit at it

In `merit/app/.env.local` (or the deploy env):

```
MERIT_NLI_URL=http://localhost:8000/score
MERIT_NLI_MODEL=vectara/hhem-2.1-open
MERIT_STRICT_GATE=1        # require BOTH the NLI leg and the judge to confirm support (highest precision)
```

Now Merit catches **non-numeric** wrong-answers (contradictions, off-topic, right-entity/wrong-answer) with
**no LLM call** — the NLI leg decides, and the LLM judge is only a second gate.

## Models (all permissive, CPU-friendly)

| `MERIT_NLI_BACKEND` | Model | License | Notes |
|---|---|---|---|
| `hhem` (default) | `vectara/hallucination_evaluation_model` (HHEM-2.1-Open) | Apache-2.0 | ~100M params, ~600MB RAM, ~1.5s/2k-token CPU, **unlimited context**; `predict([(source, claim)])` is the contract verbatim |
| `crossencoder` | `cross-encoder/nli-deberta-v3-base` | Apache-2.0 | 3-way NLI; `score` = softmax entailment prob; 512-token cap |

Optional second gate: set `MERIT_NLI_CONTRA=1` to also load a cross-encoder and **penalize contradictions**
(`score = support · (1 − contradiction)`) — the "support AND not-contradict" gate.

**Not shipped (non-commercial):** Bespoke-MiniCheck-7B is CC-BY-NC-4.0 — excluded. `lytang/MiniCheck-Flan-T5-Large`
(Apache-2.0, 770M) is a drop-in higher-accuracy alternative if you have the CPU headroom.

## Endpoints

- `GET /healthz` → `{ ok, backend, model, dualGate }`
- `POST /score` → `{ score, support, model }`
- `POST /score/batch` `{ items: [{claim, source}] }` → `{ model, scores: [...] }`
