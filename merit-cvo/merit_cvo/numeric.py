"""
Deterministic numeric verification — the "machine-verifiable first" layer. A specific MONETARY or PERCENTAGE
figure a claim asserts must trace to the cited source, or it is a fabricated number the CVO catches WITHOUT
any model or API. Unfoolable, free, and it fires even when no LLM/NLI is configured.

Faithful port of Merit's lib/numcheck.ts, so a Python and a TypeScript deployment reach the same verdict.

Conservative by construction (false-refusing a real citation would be a regression):
  - Only $-money and %-percent figures (skips bare integers, years, counts).
  - Only flags when the source HAS a comparable same-kind figure and NONE is within 50% (an order-of-magnitude
    fabrication like "$40T" vs the source's "$4.1T" is caught; a paraphrase "$4 trillion" vs "$4.1 trillion",
    or a figure the source simply omits, is left to the NLI/LLM layers — never auto-refused here).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

MAGNITUDE = {
    "trillion": 1e12, "t": 1e12,
    "billion": 1e9, "b": 1e9,
    "million": 1e6, "m": 1e6,
    "thousand": 1e3, "k": 1e3,
}
SUPPORT_TOLERANCE = 0.5  # a claim figure is "supported" if a source figure is within 50% relative

_MONEY = re.compile(r"\$\s?([\d,]+(?:\.\d+)?)\s*(trillion|billion|million|thousand|[tbmk])?\b", re.I)
_BARE = re.compile(r"\b([\d,]+(?:\.\d+)?)\s+(trillion|billion|million|thousand)\b", re.I)
_PCT = re.compile(r"([\d,]+(?:\.\d+)?)\s?%")


@dataclass(frozen=True)
class Figure:
    value: float
    kind: str  # "money" | "percent"
    raw: str


def extract_figures(text: str) -> list[Figure]:
    out: list[Figure] = []
    # $-prefixed money, optional magnitude word/letter: $4.1T · $90 million · $4,100,000 · $0.000001
    for m in _MONEY.finditer(text):
        try:
            v = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        suf = (m.group(2) or "").lower()
        if suf and suf in MAGNITUDE:
            v *= MAGNITUDE[suf]
        out.append(Figure(v, "money", m.group(0).strip()))
    # bare magnitude words NOT already preceded by "$": "4.1 trillion in volume"
    for m in _BARE.finditer(text):
        if re.search(r"\$\s?$", text[: m.start()]):
            continue  # part of a $-figure already extracted
        try:
            v = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        v *= MAGNITUDE[m.group(2).lower()]
        out.append(Figure(v, "money", m.group(0).strip()))
    # percentages
    for m in _PCT.finditer(text):
        try:
            v = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        out.append(Figure(v, "percent", m.group(0).strip()))
    return out


def _is_contradicted(claim_val: float, peers: list[Figure]) -> bool:
    for p in peers:
        denom = max(abs(claim_val), abs(p.value), 1e-9)
        if abs(claim_val - p.value) / denom <= SUPPORT_TOLERANCE:
            return False
    return True


def fabricated_figures(claim: str, source: str) -> list[Figure]:
    """The claim's figures the source actively CONTRADICTS — a machine-verifiable fabricated number."""
    claim_figs = extract_figures(claim)
    if not claim_figs:
        return []
    src_figs = extract_figures(source)
    out: list[Figure] = []
    for cf in claim_figs:
        peers = [sf for sf in src_figs if sf.kind == cf.kind]
        if peers and _is_contradicted(cf.value, peers):
            out.append(cf)
    return out
