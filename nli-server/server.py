"""
Merit NLI backend — a free, self-hostable factual-consistency scorer for the verification engine.

It implements the exact contract lib/verify/nli.ts expects:

    POST /score   { "claim": "...", "source": "..." }  ->  { "score": 0.0..1.0, ... }

`score` is the probability that SOURCE supports CLAIM. Point Merit at it with:

    MERIT_NLI_URL=http://localhost:8000/score
    MERIT_NLI_MODEL=vectara/hhem-2.1-open   # recorded on every verdict for reproducibility

Two permissive, CPU-friendly, zero-API backends (choose via MERIT_NLI_BACKEND):

  * "hhem" (DEFAULT) — Vectara HHEM-2.1-Open (Apache-2.0, ~100M params, ~600MB RAM, unlimited context).
      model.predict([(source, claim)]) natively returns P(source supports claim) in 0..1 — a drop-in match.
  * "crossencoder" — a 3-way NLI cross-encoder (Apache-2.0 / MIT). score = softmax entailment probability.

Optional second gate (MERIT_NLI_CONTRA=1): also load a cross-encoder and PENALIZE contradictions, so a claim
the source both partly-entails AND contradicts (mixed evidence) is scored down — the "support AND not-contradict"
dual gate the faithfulness literature (AlignScore/Ragas-with-HHEM) converges on. Everything runs on CPU with
permissive-licensed models; nothing calls a paid API.
"""
from __future__ import annotations

import os
from typing import List, Optional

from fastapi import FastAPI
from pydantic import BaseModel

BACKEND = os.getenv("MERIT_NLI_BACKEND", "hhem").lower()
HHEM_MODEL = os.getenv("MERIT_NLI_HHEM_MODEL", "vectara/hallucination_evaluation_model")
CE_MODEL = os.getenv("MERIT_NLI_CE_MODEL", "cross-encoder/nli-deberta-v3-base")
USE_CONTRA = os.getenv("MERIT_NLI_CONTRA", "0") == "1"

app = FastAPI(title="Merit NLI backend", version="0.1.0")

_support = None   # primary support scorer
_contra = None    # optional contradiction scorer (cross-encoder)


class _HHEM:
    """Vectara HHEM-2.1-Open — predict([(premise, hypothesis)]) -> P(premise supports hypothesis)."""

    tag = "vectara/hhem-2.1-open"

    def __init__(self, name: str):
        from transformers import AutoModelForSequenceClassification  # lazy: keep import cost off /healthz
        self.m = AutoModelForSequenceClassification.from_pretrained(name, trust_remote_code=True)
        self.m.eval()

    def score_batch(self, pairs: List[tuple]) -> List[float]:
        # pairs = [(claim, source), ...]; HHEM wants (premise=source, hypothesis=claim)
        preds = self.m.predict([(s, c) for (c, s) in pairs])
        return [float(x) for x in preds]


class _CrossEncoder:
    """3-way NLI cross-encoder. Returns (entailment_prob, contradiction_prob) via softmax over the logits.

    Label order differs by model — configured for cross-encoder/nli-deberta-v3-base
    ([contradiction, entailment, neutral]); override with MERIT_NLI_ENTAIL_IDX / MERIT_NLI_CONTRA_IDX.
    """

    def __init__(self, name: str):
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        self.torch = torch
        self.tok = AutoTokenizer.from_pretrained(name)
        self.m = AutoModelForSequenceClassification.from_pretrained(name)
        self.m.eval()
        self.entail_idx = int(os.getenv("MERIT_NLI_ENTAIL_IDX", "1"))
        self.contra_idx = int(os.getenv("MERIT_NLI_CONTRA_IDX", "0"))
        self.tag = name

    def probs(self, claim: str, source: str) -> tuple:
        with self.torch.no_grad():
            x = self.tok(source, claim, truncation=True, max_length=512, return_tensors="pt")
            p = self.torch.softmax(self.m(**x).logits[0], dim=-1)
        return float(p[self.entail_idx]), float(p[self.contra_idx])

    def score_batch(self, pairs: List[tuple]) -> List[float]:
        return [self.probs(c, s)[0] for (c, s) in pairs]

    def contra_batch(self, pairs: List[tuple]) -> List[float]:
        return [self.probs(c, s)[1] for (c, s) in pairs]


def support():
    global _support
    if _support is None:
        if BACKEND == "crossencoder":
            _support = _CrossEncoder(CE_MODEL)
        else:
            _support = _HHEM(HHEM_MODEL)
    return _support


def contra():
    global _contra
    if _contra is None and USE_CONTRA:
        _contra = _CrossEncoder(CE_MODEL)
    return _contra


def model_tag() -> str:
    t = getattr(support(), "tag", BACKEND)
    return f"{t}+contra" if USE_CONTRA else t


class ScoreReq(BaseModel):
    claim: str
    source: str


class BatchReq(BaseModel):
    items: List[ScoreReq]


def _score_pairs(pairs: List[tuple]) -> List[dict]:
    sup = support().score_batch(pairs)
    if USE_CONTRA and contra() is not None:
        con = contra().contra_batch(pairs)
        # dual gate: a claim the source contradicts is penalized even if it superficially entails
        out = [{"score": max(0.0, s * (1.0 - c)), "support": s, "contradiction": c} for s, c in zip(sup, con)]
    else:
        out = [{"score": s, "support": s} for s in sup]
    return out


@app.get("/healthz")
def healthz():
    return {"ok": True, "backend": BACKEND, "model": model_tag(), "dualGate": USE_CONTRA}


@app.on_event("startup")
def _warm():
    try:
        _score_pairs([("warm up", "warming up the model on startup")])
    except Exception as e:  # never block startup on a warm-up hiccup
        print(f"[nli] warm-up skipped: {e}")


@app.post("/score")
def score(req: ScoreReq):
    r = _score_pairs([(req.claim, req.source)])[0]
    return {**r, "model": model_tag()}


@app.post("/score/batch")
def score_batch(req: BatchReq):
    rows = _score_pairs([(i.claim, i.source) for i in req.items])
    return {"model": model_tag(), "scores": rows}
