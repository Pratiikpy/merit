"""LangChain adapter — expose the CVO as a StructuredTool any agent can call before trusting a citation."""
from __future__ import annotations

from ..engine import verify_citation


def merit_tool(**cvo_kwargs):
    """Return a LangChain StructuredTool that verifies whether a source supports a claim.

    from merit_cvo.integrations.langchain import merit_tool
    agent = create_react_agent(llm, tools=[merit_tool()])
    """
    from langchain_core.tools import StructuredTool

    def verify_citation_tool(claim: str, source: str) -> str:
        """Verify whether SOURCE actually supports CLAIM. Returns SUPPORTED or REFUSED — call this before
        trusting, quoting, or paying for a citation, to catch hallucinated / unsupported ones."""
        v = verify_citation(claim, source, **cvo_kwargs)
        if not v.ok():
            return f"ABSTAIN ({v.status}): {v.error}"
        return f"{v.verdict}: {v.reason} [{'+'.join(v.methods)}]"

    return StructuredTool.from_function(
        func=verify_citation_tool,
        name="verify_citation",
        description="Verify whether a SOURCE passage supports a CLAIM. Returns SUPPORTED or REFUSED. "
        "Use before trusting or paying for any citation to catch fabricated numbers, contradictions, "
        "off-topic sources, and unsupported claims.",
    )
