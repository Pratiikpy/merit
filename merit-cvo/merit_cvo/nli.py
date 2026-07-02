"""
NLI / factual-consistency leg — a 0..1 probability the source SUPPORTS the claim.

Two zero-cost paths, both permissive-licensed and offline-capable:
  * HTTP (default, no third-party deps): POST MERIT_NLI_URL {claim, source} -> {score}. Point it at the
    bundled `nli-server` (HHEM-2.1-Open) or any compatible scorer. Uses only the stdlib (urllib).
  * In-process (pip install "merit-cvo[hhem]"): set MERIT_NLI_MODEL to a HF model id and it loads HHEM
    locally. No server, no network.

Returns None if unconfigured or on any error — the NLI leg is additive evidence, never a hard failure.
"""
from __future__ import annotations

import json
import os
import urllib.request

_local_model = None  # cached in-process HHEM model


def nli_available(url: str | None = None) -> bool:
    return bool(url or os.getenv("MERIT_NLI_URL") or os.getenv("MERIT_NLI_MODEL"))


def _score_http(url: str, claim: str, source: str, timeout: float) -> float | None:
    body = json.dumps({"claim": claim, "source": source}).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if r.status != 200:
            return None
        data = json.loads(r.read().decode())
    s = data.get("score")
    return None if s is None else max(0.0, min(1.0, float(s)))


def _score_local(model_id: str, claim: str, source: str) -> float | None:
    global _local_model
    if _local_model is None:
        from transformers import AutoModelForSequenceClassification  # type: ignore
        _local_model = AutoModelForSequenceClassification.from_pretrained(model_id, trust_remote_code=True)
        _local_model.eval()
    # HHEM: predict([(premise=source, hypothesis=claim)]) -> P(support)
    return max(0.0, min(1.0, float(_local_model.predict([(source, claim)])[0])))


def score_nli(claim: str, source: str, *, url: str | None = None, timeout: float = 8.0) -> float | None:
    """0..1 support probability from the configured scorer, or None if unavailable / errored."""
    url = url or os.getenv("MERIT_NLI_URL")
    try:
        if url:
            return _score_http(url, claim, source, timeout)
        model_id = os.getenv("MERIT_NLI_MODEL")
        if model_id and model_id not in ("none", "custom-nli"):
            return _score_local(model_id, claim, source)
    except Exception:
        return None  # additive layer — never throw
    return None


def nli_model_tag(url: str | None = None) -> str:
    if os.getenv("MERIT_NLI_MODEL"):
        return os.environ["MERIT_NLI_MODEL"]
    return "custom-nli" if (url or os.getenv("MERIT_NLI_URL")) else "none"
