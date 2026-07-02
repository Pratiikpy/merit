import { NextResponse } from "next/server";
import { auditCount, auditEntries, euAiActMapping, verifyAuditChain } from "@/lib/audit";
import { signReceipt } from "@/lib/receipt";
import { ephemeralStore, hydrateDoc } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/audit — export the tamper-evident verification audit trail as an EU AI Act Article 12
// (record-keeping) + Article 50 (transparency) traceability artifact. The whole export is signed with the
// deployment's signing key, and the keccak256 hash chain is re-verified so an auditor can confirm no past
// record was altered — offline, without trusting Merit's server, and without any blockchain.
//   ?limit=N   (default 100, max 1000) — how many recent records to include
//   ?verify=1  — (always runs) re-derives the chain and reports validity + the first broken index, if any
export async function GET(req: Request) {
  // Cold serverless instances hydrate the durable log lazily — pull it from the mirror first (no-op when warm).
  if (ephemeralStore()) await hydrateDoc("audit").catch(() => false);

  const url = new URL(req.url);
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const chain = verifyAuditChain();

  const body = {
    schema: "merit.audit/v1",
    standard: "EU AI Act — Article 12 (record-keeping / logging) + Article 50 (transparency)",
    euAiAct: euAiActMapping(),
    chain: {
      valid: chain.valid,
      length: chain.length,
      brokenAt: chain.brokenAt,
      algorithm: "keccak256 hash chain (each record binds the prior record's hash)",
    },
    count: auditCount(),
    entries: auditEntries(limit),
    exportedAt: new Date().toISOString(),
  };

  // Sign the export so a third party can recover the signer offline (integrity of the whole artifact).
  const sig = await signReceipt(body).catch(() => null);
  return NextResponse.json(sig ? { ...body, signer: sig.signer, signature: sig.signature } : body);
}
