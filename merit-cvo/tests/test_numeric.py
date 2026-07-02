import pytest

from merit_cvo.numeric import extract_figures, fabricated_figures


def test_extracts_money_with_magnitude():
    figs = extract_figures("volume hit $4.1 trillion and $90 million")
    vals = sorted(f.value for f in figs)
    assert vals == pytest.approx([90_000_000.0, 4_100_000_000_000.0])


def test_extracts_bare_magnitude_and_percent():
    figs = extract_figures("grew 4.1 trillion in volume, up 43%")
    kinds = {f.kind for f in figs}
    assert "money" in kinds and "percent" in kinds


def test_flags_order_of_magnitude_fabrication():
    fab = fabricated_figures("The market hit $40 trillion.", "The market reached $4.1 trillion.")
    assert len(fab) == 1


def test_does_not_flag_within_tolerance_paraphrase():
    # $4T vs $4.1T is within the 50% support tolerance -> not a numeric contradiction
    assert fabricated_figures("The market reached $4 trillion.", "The market reached $4.1 trillion.") == []


def test_does_not_flag_when_source_omits_the_figure():
    # source has no comparable money figure -> numeric layer stays silent (left to NLI/judge)
    assert fabricated_figures("Revenue was $5 billion.", "The company grew quickly last year.") == []


def test_flags_contradicted_percent():
    assert len(fabricated_figures("efficacy was 40%", "the vaccine showed 95% efficacy")) == 1
