import { NextResponse } from "next/server";
import { listCards, refreshCardsFromMirror } from "@/lib/cards";
import { auditStats, refreshAuditFromMirror, verifyAuditChain } from "@/lib/audit";
import { snapshotMetrics } from "@/lib/metrics";
import { refreshVcacheFromMirror } from "@/lib/vcache";
import { ephemeralStore, hydrateDoc } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/proof — the persistent public traction ledger. Foregrounds the honesty split (verified vs REFUSED —
// the number a pay-on-retrieval tool can't show), the real cumulative USDC settled on Arc, and the cache's
// re-verifications avoided, then lists recent verification/settlement RECEIPTS. Every row deep-links its signed
// `/v/[id]` receipt and, for a real on-chain settlement, its Arc tx — so the traction is checkable, not asserted.
export async function GET(req: Request) {
  if (ephemeralStore()) {
    await Promise.all(
      ["ledger", "history", "registry", "agentlabor", "vcache", "audit", "cards"].map((n) => hydrateDoc(n).catch(() => false)),
    );
  }
  await Promise.all([refreshAuditFromMirror(), refreshCardsFromMirror(), refreshVcacheFromMirror()].map((p) => p.catch(() => {})));

  const limit = Math.min(100, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 40));
  const m = snapshotMetrics();
  const a = auditStats();
  const chain = verifyAuditChain();

  const rows = listCards(limit).map((c) => ({
    id: c.id,
    kind: c.kind,
    verdict: c.verdict,
    claim: c.claim.length > 140 ? c.claim.slice(0, 140) + "…" : c.claim,
    sourceName: c.sourceName || null,
    paidUsdc: typeof c.paidUsdc === "number" ? c.paidUsdc : null,
    custody: !!c.custody,
    onchain: !!c.explorerUrl, // a real on-chain tx (vs a batched transfer-id or an accrual)
    explorerUrl: c.explorerUrl || null,
    // the join key — ties this ledger row to the exact signed verdict that gated its payment (and the
    // on-chain hook proofHash), so a reader can trace any settlement back to the verification that allowed it.
    verificationId: c.verificationId || null,
    receiptUrl: `/v/${c.id}`,
    createdAt: c.createdAt,
  }));

  return NextResponse.json({
    schema: "merit.proof/v1",
    // The honesty split — verified vs refused across the whole tamper-evident audit chain.
    verifications: { total: a.total, supported: a.supported, refused: a.refused, chainValid: chain.valid },
    // Real cumulative on-chain settlement (monotonic; agent runs + tolls).
    settlements: { totalUsdc: m.totalSettledUsdc, count: m.settlementCount, distinctPayees: m.distinctPayees, runs: m.runCount },
    // Agent-to-agent x402 labor — kept distinct so it never inflates the verified totals.
    agentLabor: m.agentLabor,
    // Verified-citation cache — re-verifications avoided (true count) + honestly-labelled cost estimate.
    cache: m.cache,
    rows,
  });
}
