"""Framework-adapter tests. Each skips if the framework isn't installed, and exercises the DETERMINISTIC
numeric path (a fabricated $ figure -> REFUSED) so no NLI server or LLM key is needed."""
import asyncio
import os

import pytest

FAB_CLAIM = "Q2 revenue reached $5 billion."
FAB_SOURCE = "The company reported Q2 revenue of $2.0 billion."


def setup_module(_):
    for k in ("MERIT_NLI_URL", "MERIT_NLI_MODEL", "LLM_API_KEY", "OPENAI_API_KEY", "NVIDIA_API_KEY", "MERIT_STRICT_GATE"):
        os.environ.pop(k, None)


def test_langchain_tool_refuses_fabricated():
    pytest.importorskip("langchain_core")
    from merit_cvo.integrations.langchain import merit_tool
    tool = merit_tool()
    assert tool.name == "verify_citation"
    out = tool.invoke({"claim": FAB_CLAIM, "source": FAB_SOURCE})
    assert "REFUSED" in out


def test_llamaindex_evaluator_fails_fabricated():
    pytest.importorskip("llama_index.core")
    from merit_cvo.integrations.llamaindex import merit_evaluator
    ev = merit_evaluator()
    res = ev.evaluate(response=FAB_CLAIM, contexts=[FAB_SOURCE])
    assert res.passing is False and res.score == 0.0


def test_ragas_metric_factory_importable():
    # the factory imports ragas lazily, so this is always importable
    from merit_cvo.integrations import ragas as r
    assert callable(r.merit_faithfulness)


def test_ragas_metric_scores_zero_on_fabricated():
    pytest.importorskip("ragas")
    from ragas.dataset_schema import SingleTurnSample
    from merit_cvo.integrations.ragas import merit_faithfulness
    metric = merit_faithfulness()
    sample = SingleTurnSample(user_input="q", response=FAB_CLAIM, retrieved_contexts=[FAB_SOURCE])
    score = asyncio.run(metric._single_turn_ascore(sample, None))
    assert score == 0.0
