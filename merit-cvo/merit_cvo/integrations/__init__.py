"""
Framework adapters for merit-cvo. Each is a lazy factory — the framework is imported only when you call it,
so the merit-cvo core stays dependency-free.

    from merit_cvo.integrations.llamaindex import merit_evaluator   # pip install "merit-cvo[llamaindex]"
    from merit_cvo.integrations.langchain import merit_tool          # pip install "merit-cvo[langchain]"
    from merit_cvo.integrations.ragas import merit_faithfulness      # pip install "merit-cvo[ragas]"

All accept the same keyword options as verify_citation (strict=, nli_url=, high=, low=).
"""
