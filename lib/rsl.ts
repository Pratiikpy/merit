/**
 * RSL / Tollbit adapter (W4) — position Merit as the verifiable per-INFERENCE settlement layer ABOVE the
 * per-crawl toll, not a competing toll. The pay-per-crawl incumbents (Tollbit, Cloudflare, RSL Collective)
 * admit they cannot prove per-citation attribution; Merit can. This adapter parses an RSL/Tollbit-style
 * license declaration a publisher attaches, and — given a proof-of-citation verdict — emits the attribution
 * PROOF object the incumbents lack: which source grounded which claim, the verdict, and a settlement
 * instruction. Pure + deterministic, so incumbents become channels rather than competitors.
 */
export interface RslLicense {
  standard: string; // "RSL"
  license: string; // license identifier/URL the publisher declared
  payTo?: string; // settlement address
  amount?: number; // price per licensed use (USDC)
  currency?: string;
}

/** Parse an RSL/Tollbit-style license header, e.g.
 *  `RSL license=https://rslstandard.org/ai-train; payto=0xabc…; amount=0.01; currency=USDC`. */
export function parseRslLicense(header: string): RslLicense | null {
  if (!header) return null;
  const trimmed = header.trim();
  const standard = /^RSL\b/i.test(trimmed) ? "RSL" : /tollbit/i.test(trimmed) ? "TollBit" : "";
  if (!standard) return null;
  const out: RslLicense = { standard, license: "" };
  for (const part of trimmed.replace(/^[A-Za-z]+\s*/, "").split(/[;,]/)) {
    const [k, ...rest] = part.split("=");
    const key = (k || "").trim().toLowerCase();
    const val = rest.join("=").trim();
    if (!key || !val) continue;
    if (key === "license" || key === "url") out.license = val;
    else if (key === "payto" || key === "payment") out.payTo = val;
    else if (key === "amount" || key === "price") out.amount = Number(val);
    else if (key === "currency") out.currency = val;
  }
  return out;
}

export interface AttributionProof {
  standard: string;
  sourceId: string;
  claim: string;
  supported: boolean;
  confidence: number;
  settle: { payTo?: string; amount?: number; currency: string } | null;
  note: string;
}

/** Bind a verified citation to a settlement instruction — the proof RSL/Tollbit cannot enforce. Settlement is
 *  emitted ONLY for a SUPPORTED citation; a refused one carries the proof but no payment. */
export function attributionProof(opts: {
  sourceId: string;
  claim: string;
  supported: boolean;
  confidence: number;
  license: RslLicense | null;
}): AttributionProof {
  const { sourceId, claim, supported, confidence, license } = opts;
  return {
    standard: license?.standard || "RSL",
    sourceId,
    claim,
    supported,
    confidence,
    settle: supported
      ? { payTo: license?.payTo, amount: license?.amount, currency: license?.currency || "USDC" }
      : null,
    note: supported
      ? "Proof-of-citation upheld — settle the licensed per-inference use on Arc."
      : "Citation not supported — no settlement (the proof RSL/Tollbit cannot produce).",
  };
}
