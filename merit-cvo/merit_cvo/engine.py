"""
Merit CVO engine — the free, self-hostable Citation Verification Oracle.

Composes three legs, cheapest-and-hardest first, and returns a SUPPORTED/REFUSED Verdict for a (claim, source):
  1. Deterministic numeric verifier (no model, no API) — a fabricated $/% figure the source contradicts -> REFUSED.
  2. NLI / factual-consistency (HHEM-class, self-hosted) — a 0..1 support score. High -> SUPPORTED, low -> REFUSED.
  3. Adversarial LLM judge (optional) — injection/trap-resistant, for borderline cases (cascade) or as a gate (strict).

Two modes:
  * cascade (default): numeric -> NLI (decides when confident) -> judge (borderline / no NLI). Cheapest.
  * STRICT dual-gate (strict=True or MERIT_STRICT_GATE=1): SUPPORTED only if EVERY available model leg
    (NLI + judge) independently confirms support. Highest precision, at a measured over-refusal cost.

Faithful to Merit's lib/verify/engine.ts, so the Python package and the TypeScript app decide identically.
"""
from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from .judge import judge_available, judge_citation
from .nli import nli_available, nli_model_tag, score_nli
from .numeric import fabricated_figures

ENGINE_VERSION = "merit-cvo-py/0.1.0"
MAX_CLAIM = 4000
MAX_SOURCE = 20000

_INJECTION = re.compile(
    r"(ignore (all |previous )?instructions|disregard the above|you are now|system prompt|answer supported|output supported)",
    re.I,
)


@dataclass
class Verdict:
    verdict: Optional[str]  # "SUPPORTED" | "REFUSED" | None (error)
    grounded: bool = False
    score: Optional[float] = None
    methods: list[str] = field(default_factory=list)
    reason: str = ""
    model_tag: str = "none"
    source_hash: str = ""
    schema: str = "merit.cvo/v2"
    engine_version: str = ENGINE_VERSION
    verified_at: str = ""
    error: Optional[str] = None
    status: int = 200

    def ok(self) -> bool:
        return self.error is None

    def to_dict(self) -> dict:
        if self.error is not None:
            return {"error": self.error, "status": self.status}
        return {
            "schema": self.schema, "engineVersion": self.engine_version, "verdict": self.verdict,
            "grounded": self.grounded, "score": self.score, "methods": self.methods, "reason": self.reason,
            "modelTag": self.model_tag, "sourceHash": self.source_hash, "verifiedAt": self.verified_at,
        }


def verify_citation(
    claim: str,
    source: str,
    *,
    strict: Optional[bool] = None,
    nli_url: Optional[str] = None,
    high: float = 0.75,
    low: float = 0.25,
) -> Verdict:
    claim = (claim or "").strip()
    source = (source or "").strip()
    if not claim or not source:
        return Verdict(None, error="provide { claim, source } — both raw text", status=400)
    if len(claim) > MAX_CLAIM or len(source) > MAX_SOURCE:
        return Verdict(None, error=f"claim <= {MAX_CLAIM}, source <= {MAX_SOURCE} chars", status=400)
    if _INJECTION.search(claim):
        return Verdict(None, error="claim rejected as a likely prompt-injection attempt", status=400)

    strict = strict if strict is not None else os.getenv("MERIT_STRICT_GATE") == "1"
    methods = ["injection-guard"]
    verdict: Optional[str] = None
    score: Optional[float] = None
    reason = ""
    use_nli = nli_available(nli_url)

    def finish(v: str, r: str) -> Verdict:
        return Verdict(
            verdict=v, grounded=(v == "SUPPORTED"), score=score, methods=methods, reason=r,
            model_tag=nli_model_tag(nli_url), source_hash="0x" + hashlib.sha256(source.encode()).hexdigest(),
            verified_at=datetime.now(timezone.utc).isoformat(),
        )

    # Layer 1 — deterministic numeric verifier (no model).
    methods.append("numeric")
    fab = fabricated_figures(claim, source)
    if fab:
        score = 0.0
        return finish("REFUSED", f"The claim asserts {', '.join(f.raw for f in fab)}, which the source contradicts (deterministic numeric check).")

    # Layers 2+3 — STRICT dual-gate: every available model leg must independently confirm support.
    if strict:
        legs: list[str] = []
        if use_nli:
            s = score_nli(claim, source, url=nli_url)
            if s is not None:
                score = s
                methods.append("nli")
                legs.append("support" if s >= high else "fail")
        j = judge_citation(claim, source)
        if j is not None:
            methods.append("llm-judge")
            legs.append("fail" if j in ("refute", "unclear") else "support")
        if not legs:
            return Verdict(None, error="no model leg available (configure MERIT_NLI_URL or an LLM key)", status=503)
        all_confirm = all(x == "support" for x in legs)
        return finish("SUPPORTED" if all_confirm else "REFUSED",
                      f"Strict dual-gate: all {len(legs)} verifier leg(s) independently confirm support."
                      if all_confirm else "Strict dual-gate refused — not every verifier leg confirmed support.")

    # Layer 2 — NLI (cascade).
    if use_nli:
        s = score_nli(claim, source, url=nli_url)
        if s is not None:
            score = s
            methods.append("nli")
            if s >= high:
                return finish("SUPPORTED", f"Source supports the claim (factual-consistency {s:.3f} >= {high}).")
            if s <= low:
                return finish("REFUSED", f"Source does not support the claim (factual-consistency {s:.3f} <= {low}).")
            # borderline -> escalate to the judge

    # Layer 3 — adversarial LLM judge (cascade).
    j = judge_citation(claim, source)
    if j is None:
        if score is not None:
            return finish("SUPPORTED" if score >= (high + low) / 2 else "REFUSED",
                          f"LLM judge unavailable; decided by factual-consistency {score:.3f}.")
        return Verdict(None, error="the adversarial LLM judge is unavailable — configure MERIT_NLI_URL or an LLM key for full verification", status=503, methods=methods)
    methods.append("llm-judge")
    return finish("REFUSED" if j in ("refute", "unclear") else "SUPPORTED",
                  "the source does not clearly support the claim" if j in ("refute", "unclear") else "the source supports the claim")
