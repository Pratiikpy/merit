import { NextResponse } from "next/server";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { auditLicense } from "@/lib/licenseaudit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // up to 10 claims through the three-gate verifier

// Licensing-compliance audit (cat 6/7 upsell) — sample an AI output's claims against a licensed source and flag
// misattribution (claims credited to the source that the source does not support), for a royalty true-up.
//
// POST /api/license/audit { source, claims: string[], licensor? }
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) {
    return NextResponse.json(
      { error: rl.status === 429 ? "rate_limited" : "busy", retryAfterMs: rl.retryMs },
      { status: rl.status, headers: { "Retry-After": String(Math.ceil((rl.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { source?: string; claims?: string[]; licensor?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const res = await auditLicense({ source: body.source || "", claims: Array.isArray(body.claims) ? body.claims : [], licensor: body.licensor });
  if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json(res);
}

export function GET() {
  return NextResponse.json({
    audit: "merit.license-audit/v1",
    usage: {
      method: "POST",
      body: { source: "the licensed source text", claims: "string[] — assertions in the AI output crediting this source", licensor: "string (optional)" },
      returns: { checked: "number", supported: "number", misattributed: "number", supportedShare: "0..1", report: "per-claim verdicts", signature: "0x…" },
    },
  });
}
