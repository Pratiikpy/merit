import { NextResponse } from "next/server";
import { buildStatement } from "@/lib/statement";
import { refreshAuditFromMirror } from "@/lib/audit";
import { refreshVcacheFromMirror } from "@/lib/vcache";
import { refreshJuryFromMirror } from "@/lib/jury";
import { refreshComplianceFromMirror } from "@/lib/compliance";
import { ephemeralStore, hydrateDoc } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/statement — the signed verified-spend statement: a single, offline-verifiable executive summary of
// Merit's operation (verification outcomes, on-chain settlement, compliance screening, consensus-jury activity),
// foregrounding that money moved ONLY for citations that verified. Aggregate figures only (no addresses/PII), so
// it is public. Refreshes the durable stores first so a warm serverless instance reports current totals.
export async function GET() {
  if (ephemeralStore()) {
    await Promise.all(
      ["ledger", "history", "registry", "agentlabor", "vcache", "audit", "jury", "compliance"].map((n) => hydrateDoc(n).catch(() => false)),
    );
  }
  await Promise.all(
    [refreshAuditFromMirror(), refreshVcacheFromMirror(), refreshJuryFromMirror(), refreshComplianceFromMirror()].map((p) => p.catch(() => {})),
  );
  const statement = await buildStatement();
  return NextResponse.json(statement);
}
