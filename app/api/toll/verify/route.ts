import { NextResponse } from "next/server";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { evaluateToll, listToll, tollStats, refreshTollFromMirror, TOLL_PRICE_DEFAULT } from "@/lib/toll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45; // a fetch (optional) + the three-gate verifier

// Verified Citation Toll (the moat door) — a neutral gate any rail/publisher calls BEFORE releasing a citation
// payment. Merit does not move the money; it returns the signed verdict + release/refuse decision the caller
// settles on. Same verifier as the inference door.
//
// POST /api/toll/verify { claim, citedPassage | citedURL, tollUsdc?, publisher? }
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) {
    return NextResponse.json(
      { error: rl.status === 429 ? "rate_limited" : "busy", retryAfterMs: rl.retryMs },
      { status: rl.status, headers: { "Retry-After": String(Math.ceil((rl.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { claim?: string; citedPassage?: string; citedURL?: string; tollUsdc?: number; publisher?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  await refreshTollFromMirror().catch(() => {});
  const res = await evaluateToll({
    claim: body.claim || "",
    citedPassage: body.citedPassage,
    citedURL: body.citedURL,
    tollUsdc: body.tollUsdc,
    publisher: body.publisher,
    record: true,
  });
  if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({
    receipt: res.receipt,
    note: "Neutral citation gate. Merit returns a signed verdict + release/refuse decision — YOUR rail moves the money (or not) on it. The same verificationId links this verdict to your payment, the /proof ledger, and the on-chain hook.",
  });
}

// GET /api/toll/verify → the gate manifest, default toll, recent decisions, and the honesty split
export async function GET() {
  await refreshTollFromMirror().catch(() => {});
  return NextResponse.json({
    gate: "merit.toll/v1",
    defaultTollUsdc: TOLL_PRICE_DEFAULT,
    usage: {
      method: "POST",
      body: { claim: "string", citedPassage: "string (or citedURL)", citedURL: "string (optional)", tollUsdc: "number (optional)", publisher: "string (optional)" },
      returns: { decision: "release | refuse", released: "number", verdict: "SUPPORTED | REFUSED", confidence: "0..1", verificationId: "0x…", signer: "0x…", signature: "0x…" },
    },
    recent: listToll(30),
    stats: tollStats(),
  });
}
