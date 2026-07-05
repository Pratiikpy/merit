/**
 * The signed verified-spend statement (HUB-PLAN Phase 7 — the "vended verified-spend dashboard" data layer). A
 * single, offline-verifiable executive artifact an enterprise or auditor exports: it composes the tamper-evident
 * verification chain, the on-chain settlement totals, the compliance-screening split, and the consensus-jury
 * activity into one signed `merit.statement/v1` object that foregrounds the moat's headline — money moved ONLY
 * for citations that verified; refused citations were paid $0.
 *
 * This does NOT duplicate /api/audit (the raw Article-12 verdict chain) — it is the cross-domain SUMMARY that
 * sits on top of it, suitable as a period report. The dashboard UI that renders it stays design-gated; this is
 * the honest, signed data layer beneath it. Signed with the deployment's signing key so a third party recovers
 * the signer offline (scripts/verify-receipt.mjs) and confirms the statement was not altered.
 */
import { signReceipt, verificationId } from "./receipt";
import { snapshotMetrics } from "./metrics";
import { auditStats, verifyAuditChain } from "./audit";
import { round6 } from "./arc";
import { inferenceStats, refreshInferenceFromMirror } from "./inference";
import { tollStats, refreshTollFromMirror } from "./toll";

export interface VerifiedSpendStatement {
  schema: "merit.statement/v1";
  generatedAt: string;
  // Verification — the moat headline: how many cited claims were machine-verified SUPPORTED vs REFUSED, and
  // whether the tamper-evident audit chain is intact (independently checkable at /api/audit?verify=1).
  verification: { total: number; supported: number; refused: number; refusedShare: number; chainValid: boolean; chainLength: number };
  // Settlement — real cumulative USDC that moved, and the honest claim that every dollar was gated by verification.
  settlement: { totalSettledUsdc: number; settlementCount: number; distinctPayees: number; runs: number };
  // The agent-to-agent labor market (kept distinct so it never inflates the verified creator totals).
  agentLabor: { settlements: number; volumeUsdc: number; distinctAgents: number; distinctSpecialists: number };
  // The premium consensus-jury tier (Phase 6): panels + graded per-claim outcomes.
  jury: { panels: number; claimsGraded: number; claimsSupported: number; claimsRefused: number; gradedUsdc: number };
  // Compliance (Phase 7): payee screenings + approved/review/denied split (aggregate only — no addresses/PII).
  compliance: { screens: number; approved: number; review: number; denied: number; viaCircle: number };
  // Verified inference (the product door) — 0G-attested resale where the buyer is charged only if the answer verifies.
  verifiedInference: { calls: number; verified: number; refused: number; chargedUsdc: number };
  // Verified citation toll (the moat door) — the neutral gate: released vs refused, and mis-pays a pay-on-access toll avoided.
  citationToll: { gates: number; released: number; refused: number; releasedUsdc: number; savedUsdc: number };
  // Verified-citation cache — re-verifications avoided (a true count) + honestly-labelled cost saved.
  cache: { reverificationsAvoided: number; entries: number; estSavedUsd: number };
  // Operator safety guard — is settlement currently frozen, and the day's spend vs its cap.
  guard: { frozen: boolean; spentToday: number; dailyCap: number };
  attestation: string;
  signer?: string;
  signature?: string;
  statementId?: `0x${string}`;
}

/**
 * Build the statement from the durable stores and sign it. `sign:false` for tests. Caller should refresh the
 * mirrored docs first (the route does) so a warm serverless instance reports current totals, not a stale copy.
 */
export async function buildStatement(opts: { sign?: boolean } = {}): Promise<VerifiedSpendStatement> {
  const m = snapshotMetrics();
  const a = auditStats();
  const chain = verifyAuditChain();
  // Fold in the two front doors (best-effort mirror refresh so a warm serverless instance reports current totals).
  await refreshInferenceFromMirror().catch(() => {});
  await refreshTollFromMirror().catch(() => {});
  const inf = inferenceStats();
  const toll = tollStats();

  const body: VerifiedSpendStatement = {
    schema: "merit.statement/v1",
    generatedAt: new Date().toISOString(),
    verification: {
      total: a.total,
      supported: a.supported,
      refused: a.refused,
      refusedShare: a.total > 0 ? Math.round((a.refused / a.total) * 1000) / 1000 : 0,
      chainValid: chain.valid,
      chainLength: chain.length,
    },
    settlement: {
      totalSettledUsdc: m.totalSettledUsdc,
      settlementCount: m.settlementCount,
      distinctPayees: m.distinctPayees,
      runs: m.runCount,
    },
    agentLabor: m.agentLabor,
    jury: {
      panels: m.jury.panels,
      claimsGraded: m.jury.claimsGraded,
      claimsSupported: m.jury.claimsSupported,
      claimsRefused: m.jury.claimsRefused,
      gradedUsdc: m.jury.gradedUsdc,
    },
    compliance: {
      screens: m.compliance.screens,
      approved: m.compliance.approved,
      review: m.compliance.review,
      denied: m.compliance.denied,
      viaCircle: m.compliance.viaCircle,
    },
    verifiedInference: { calls: inf.calls, verified: inf.verified, refused: inf.refused, chargedUsdc: inf.chargedUsdc },
    citationToll: { gates: toll.gates, released: toll.released, refused: toll.refused, releasedUsdc: toll.releasedUsdc, savedUsdc: toll.savedUsdc },
    cache: { reverificationsAvoided: m.cache.reverificationsAvoided, entries: m.cache.entries, estSavedUsd: m.cache.estSavedUsd },
    guard: m.guard,
    attestation:
      "Every settled payment in this statement passed proof-of-citation verification before USDC moved; refused " +
      "citations were paid $0. The audit chain hash-links every verdict and is independently verifiable offline " +
      "(GET /api/audit?verify=1). Compliance figures are aggregate screening outcomes; jury figures are the " +
      "premium diverse-model consensus tier. Settlement totals are cumulative and monotonic.",
  };

  if (opts.sign !== false) {
    try {
      const sig = await signReceipt(body);
      if (sig) Object.assign(body, sig);
    } catch {
      /* signing is best-effort — an unsigned statement is still a valid, checkable summary */
    }
  }
  body.statementId = verificationId(body);
  return body;
}
