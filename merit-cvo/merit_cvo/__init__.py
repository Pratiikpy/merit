"""
merit-cvo — a free, self-hostable Citation Verification Oracle.

    from merit_cvo import verify_citation
    v = verify_citation("The Eiffel Tower is in Paris.", "The Eiffel Tower is a tower in Paris, France.")
    print(v.verdict, v.grounded, v.methods)   # -> SUPPORTED True ['injection-guard', 'numeric', 'nli']

Deterministic numeric check + a self-hosted NLI leg + an optional adversarial LLM judge, combined into a
signed SUPPORTED/REFUSED verdict. The free path (numeric + NLI) needs no LLM key and no third-party deps.

"pytest for citations":

    from merit_cvo import assert_grounded, assert_not_grounded
    def test_answer_is_grounded():
        assert_grounded("Q2 revenue was ~$2B.", "The company reported Q2 revenue of $2.0 billion.")
"""
from __future__ import annotations

from .engine import ENGINE_VERSION, Verdict, verify_citation
from .nli import nli_available, score_nli
from .numeric import extract_figures, fabricated_figures

__version__ = "0.1.0"
__all__ = [
    "verify_citation", "Verdict", "ENGINE_VERSION", "__version__",
    "score_nli", "nli_available", "fabricated_figures", "extract_figures",
    "assert_grounded", "assert_not_grounded",
]


class CitationNotGrounded(AssertionError):
    """Raised by assert_grounded when a citation is not SUPPORTED (or the verifier abstained)."""


def assert_grounded(claim: str, source: str, **kwargs) -> Verdict:
    """Assert the source SUPPORTS the claim; raise CitationNotGrounded otherwise. Returns the Verdict."""
    v = verify_citation(claim, source, **kwargs)
    if not v.ok():
        raise CitationNotGrounded(f"verifier abstained ({v.status}): {v.error}")
    if v.verdict != "SUPPORTED":
        raise CitationNotGrounded(f"citation not grounded: {v.reason} [{'+'.join(v.methods)}]")
    return v


def assert_not_grounded(claim: str, source: str, **kwargs) -> Verdict:
    """Assert the source does NOT support the claim (a hallucinated/unsupported citation); raise otherwise."""
    v = verify_citation(claim, source, **kwargs)
    if v.ok() and v.verdict == "SUPPORTED":
        raise CitationNotGrounded(f"expected the citation to be refused, but it was SUPPORTED: {v.reason}")
    return v
