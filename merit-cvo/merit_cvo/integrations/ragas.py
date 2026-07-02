"""Ragas adapter — a faithfulness-style metric that scores response support against retrieved contexts.

Mirrors the Ragas 'FaithfulnesswithHHEM' pattern (decouple verification from an LLM judge), but uses the
full Merit dual-gate. Targets Ragas 0.2.x SingleTurnMetric; the framework is imported lazily.
"""
from __future__ import annotations

from ..engine import verify_citation


def merit_faithfulness(**cvo_kwargs):
    """Return a Ragas single-turn metric backed by the Merit CVO (1.0 = grounded, 0.0 = not / abstained).

    Note: ragas has well-known transitive-dependency conflicts (langchain_community / langchain_openai /
    langchain_core version churn). If the import below fails, it is ragas's environment, not this adapter —
    pin a compatible stack (`pip install "ragas>=0.2,<0.3"` in a clean venv) or use the LangChain / LlamaIndex
    adapters, which have stable interfaces.
    """
    from dataclasses import dataclass, field

    try:
        from ragas.dataset_schema import SingleTurnSample  # noqa: F401 (surfaces its own import errors)
        from ragas.metrics.base import MetricType, SingleTurnMetric
    except ImportError as e:
        raise RuntimeError(
            "Could not import ragas (known transitive-dependency conflict, not a merit-cvo issue). "
            "Pin a compatible stack — e.g. `pip install \"ragas>=0.2,<0.3\"` in a clean env — or use the "
            f"LangChain / LlamaIndex adapters. Underlying error: {e}"
        ) from e

    @dataclass
    class MeritFaithfulness(SingleTurnMetric):
        name: str = "merit_faithfulness"
        _required_columns: dict = field(
            default_factory=lambda: {MetricType.SINGLE_TURN: {"response", "retrieved_contexts"}}
        )

        def init(self, run_config):  # no LLM/embeddings to initialize — the verifier is self-contained
            pass

        async def _single_turn_ascore(self, sample: SingleTurnSample, callbacks) -> float:
            source = "\n\n".join(sample.retrieved_contexts or [])
            v = verify_citation(sample.response or "", source, **cvo_kwargs)
            if not v.ok():
                return 0.0
            return 1.0 if v.verdict == "SUPPORTED" else 0.0

    return MeritFaithfulness()
