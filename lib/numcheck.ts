/**
 * Deterministic numeric verification — the "machine-verifiable first" layer the Arc ArcClear PRD and
 * Agentic-FinSearch both call for: a specific MONETARY or PERCENTAGE figure a claim asserts must trace to
 * the cited source, or it's a fabricated number the proof-of-citation catches WITHOUT an LLM. This makes
 * the Auditor's LLM judge one evidence source, not the sole proof — and it still fires when the LLM is down.
 *
 * Conservative by construction (false-refusing a real citation would be a moat regression):
 *  - Only checks $-money and %-percent figures (skips bare integers, years, counts).
 *  - Only flags when the source HAS a comparable same-kind figure and NONE is within 50% (an order-of-
 *    magnitude fabrication like "$40T" vs the source's "$4.1T" is caught; a paraphrase "$4 trillion" vs
 *    "$4.1 trillion", or a figure the source simply omits, is left to the LLM judge — never auto-refused).
 */
export interface Figure {
  value: number;
  kind: "money" | "percent";
  raw: string;
}

const MAGNITUDE: Record<string, number> = {
  trillion: 1e12, t: 1e12,
  billion: 1e9, b: 1e9,
  million: 1e6, m: 1e6,
  thousand: 1e3, k: 1e3,
};
const SUPPORT_TOLERANCE = 0.5; // a claim figure is "supported" if a source figure is within 50% relative

/** Extract normalized $-money and %-percent figures. "$4.1T", "$90 million", "4.1 trillion", "43%". */
export function extractFigures(text: string): Figure[] {
  const out: Figure[] = [];
  // $-prefixed money, optional magnitude word/letter: $4.1T · $90 million · $4,100,000 · $0.000001
  for (const m of text.matchAll(/\$\s?([\d,]+(?:\.\d+)?)\s*(trillion|billion|million|thousand|[tbmk])?\b/gi)) {
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    const suffix = (m[2] || "").toLowerCase();
    if (suffix && MAGNITUDE[suffix] !== undefined) v *= MAGNITUDE[suffix];
    out.push({ value: v, kind: "money", raw: m[0].trim() });
  }
  // bare magnitude words NOT already preceded by a "$" (which the loop above caught): "4.1 trillion in volume"
  for (const m of text.matchAll(/\b([\d,]+(?:\.\d+)?)\s+(trillion|billion|million|thousand)\b/gi)) {
    if (/\$\s?$/.test(text.slice(0, m.index ?? 0))) continue; // part of a $-figure already extracted
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    v *= MAGNITUDE[m[2].toLowerCase()];
    out.push({ value: v, kind: "money", raw: m[0].trim() });
  }
  // percentages
  for (const m of text.matchAll(/([\d,]+(?:\.\d+)?)\s?%/g)) {
    const v = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(v)) out.push({ value: v, kind: "percent", raw: m[0].trim() });
  }
  return out;
}

function isContradicted(claimVal: number, peers: Figure[]): boolean {
  return !peers.some((p) => {
    const denom = Math.max(Math.abs(claimVal), Math.abs(p.value), 1e-9);
    return Math.abs(claimVal - p.value) / denom <= SUPPORT_TOLERANCE;
  });
}

/** The claim's figures the source actively CONTRADICTS — a clear, machine-verifiable fabricated number. */
export function fabricatedFigures(claim: string, sourceContent: string): Figure[] {
  const claimFigs = extractFigures(claim);
  if (!claimFigs.length) return [];
  const srcFigs = extractFigures(sourceContent);
  return claimFigs.filter((cf) => {
    const peers = srcFigs.filter((sf) => sf.kind === cf.kind);
    return peers.length > 0 && isContradicted(cf.value, peers); // only when the source HAS a comparable figure
  });
}
