import { NextResponse } from "next/server";
import { buildCreditFile, dedupeEntries } from "@/lib/creditfile";
import { ledgerHistory } from "@/lib/ledger";
import { refreshAuditFromMirror } from "@/lib/audit";

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
    return NextResponse.json({
      schema: "merit.credit-file-export/v1",
      leaf: "keccak256(canonical {runId,sourceId,amount,tx,at})",
      construction: "sorted leaves, pairwise keccak256, odd promoted",
      count: entries.length,
      entries,
      leaves,
    });
  }
  const file = await buildCreditFile();
  return NextResponse.json(file);
}
