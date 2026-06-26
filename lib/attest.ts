/**
 * Attested, independently-verifiable verification (#19). A verdict's DETERMINISTIC layers — the numeric
 * fabrication check and the similarity-vs-threshold gate — are committed into a signed, reproducible
 * attestation. Anyone holding the source can RE-DERIVE every field and check the Auditor's signature offline,
 * confirming the machine-checkable portion of the verdict WITHOUT re-running it or trusting Merit. The LLM
 * judgment is not ZK-provable, so it is committed via the signed transcript (the receipt), not re-derived
 * here. An optional risc0/SP1 circuit can replace the signature with a succinct proof of the same arithmetic.
 */
import { createHash } from "node:crypto";
import { fabricatedFigures } from "./numcheck";
import { signReceipt, signReceiptWith, verifyReceipt } from "./receipt";

export interface Attestation {
  schema: "merit.attestation/v1";
  claim: string;
  sourceHash: string; // sha256 of the source content
  numeric: { fabricated: string[]; ok: boolean };
  similarity: { score: number; threshold: number; pass: boolean };
  supported: boolean; // the DETERMINISTIC verdict (numeric.ok && similarity.pass)
  at: number;
  signer?: string;
  signature?: string;
}

export function sha256Hex(s: string): string {
  return "0x" + createHash("sha256").update(s).digest("hex");
}

/** Build the reproducible attestation for a citation's deterministic layers. Every field re-derives from
 *  (claim, content, similarityScore, threshold) — only the LLM judgment is excluded (it's committed via the receipt). */
export function buildAttestation(claim: string, content: string, similarityScore: number, threshold: number, at: number): Attestation {
  const fab = fabricatedFigures(claim, content);
  const numeric = { fabricated: fab.map((f) => f.raw), ok: fab.length === 0 };
  const similarity = { score: similarityScore, threshold, pass: similarityScore >= threshold };
  return {
    schema: "merit.attestation/v1",
    claim,
    sourceHash: sha256Hex(content),
    numeric,
    similarity,
    supported: numeric.ok && similarity.pass,
    at,
  };
}

/** Sign an attestation with an explicit key — the testable core. */
export async function signAttestationWith(pk: string, a: Attestation): Promise<Attestation> {
  const { signer, signature } = await signReceiptWith(pk, a);
  return { ...a, signer, signature };
}

/** Sign with the Auditor (BUYER) wallet; returns it unsigned if keyless (STUB). */
export async function signAttestation(a: Attestation): Promise<Attestation> {
  const s = await signReceipt(a);
  return s ? { ...a, ...s } : a;
}

/** Verify an attestation offline: (1) the signature binds it to its signer; (2) if the source content is
 *  supplied, re-derive the deterministic fields and confirm they match (so a tampered verdict is caught). */
export async function verifyAttestation(
  att: Attestation,
  content?: string,
): Promise<{ signatureOk: boolean; deterministicOk: boolean | null; reason: string }> {
  let signatureOk = false;
  if (att.signer && att.signature) {
    signatureOk = (await verifyReceipt(att as unknown as Record<string, unknown>)).ok;
  }
  let deterministicOk: boolean | null = null;
  if (content !== undefined) {
    const fresh = buildAttestation(att.claim, content, att.similarity.score, att.similarity.threshold, att.at);
    deterministicOk =
      fresh.sourceHash === att.sourceHash &&
      fresh.numeric.ok === att.numeric.ok &&
      fresh.similarity.pass === att.similarity.pass &&
      fresh.supported === att.supported;
  }
  const reason = !signatureOk
    ? "signature invalid or unsigned"
    : deterministicOk === false
      ? "deterministic fields do not re-derive — tampered"
      : "attestation verified";
  return { signatureOk, deterministicOk, reason };
}
