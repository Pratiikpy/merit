"""LlamaIndex adapter — a BaseEvaluator that scores whether a response is grounded in its retrieved contexts."""
from __future__ import annotations

from ..engine import verify_citation


def merit_evaluator(**cvo_kwargs):
    """Return a LlamaIndex BaseEvaluator backed by the Merit CVO.

    from merit_cvo.integrations.llamaindex import merit_evaluator
    result = merit_evaluator().evaluate(response=answer, contexts=[chunk1, chunk2])
    result.passing, result.score, result.feedback
    """
    from llama_index.core.evaluation import BaseEvaluator, EvaluationResult

    class MeritCVOEvaluator(BaseEvaluator):
        def _get_prompts(self):
            return {}

        def _update_prompts(self, prompts_dict):
            pass

        async def aevaluate(self, query=None, response=None, contexts=None, sleep_time_in_seconds=0, **kwargs):
            source = "\n\n".join(contexts or [])
            v = verify_citation(response or "", source, **cvo_kwargs)
            if not v.ok():
                return EvaluationResult(
                    query=query, response=response, contexts=contexts,
                    passing=False, score=0.0, feedback=f"abstained ({v.status}): {v.error}",
                    invalid_result=True, invalid_reason=v.error,
                )
            passing = v.verdict == "SUPPORTED"
            return EvaluationResult(
                query=query, response=response, contexts=contexts,
                passing=passing, score=1.0 if passing else 0.0,
                feedback=f"{v.verdict}: {v.reason} [{'+'.join(v.methods)}]",
            )

    return MeritCVOEvaluator()
