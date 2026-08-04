import { NextResponse } from "next/server";
import { buildCreditFile, dedupeEntries } from "@/lib/creditfile";
import { ledgerHistory, ledgerTotals } from "@/lib/ledger";
import { auditStats, refreshAuditFromMirror } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The Replayable Credit File — Merit's verified-settlement history as a self-proving, Cycles-compatible credit
// artifact. GET → the signed file (Merkle root, per-payee reliability, commit-to-settle ratio, concentration
// entropy, staleness watermark). GET ?export=1 → the raw deduped entries, so any consumer recomputes the root
// and every ratio locally instead of trusting Merit's math.
export async function GET(req: Request) {
  await refreshAuditFromMirror().catch(() => {});
  const url = new URL(req.url);
  if (url.searchParams.get("export")) {
    const { entries, leaves } = dedupeEntries(ledgerHistory(1000));
    const a = auditStats();
    const totals = ledgerTotals();
    return NextResponse.json({
      schema: "merit.credit-file-export/v1",
      leaf: 'keccak256(0x00 || canonical identity) — identity is {v:1,kind:"tx",tx,sourceId,amount} when an on-chain tx exists, else {v:1,kind:"entry",runId,sourceId,amount,at}',
      construction: "sorted leaves; node = keccak256(0x01 || left || right); odd node duplicated",
      count: entries.length,
      entries,
      leaves,
      // Everything needed to recompute the file's ratios WITHOUT trusting Merit: the verification split behind
      // commitToSettleRatio and the monotonic cumulative counters behind the headline totals.
      verification: { supported: a.supported, refused: a.refused, total: a.total },
      cumulative: { settledUsdc: totals.totalSettledUsdc, settlements: totals.settlementCount, distinctPayees: totals.payees.length, runs: totals.runCount },
    });
  }
  const file = await buildCreditFile();
  return NextResponse.json(file);
}
