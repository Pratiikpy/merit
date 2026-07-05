import { NextResponse } from "next/server";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { facilitate } from "@/lib/facilitator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45; // probe + (live) settle + verify

// Verify-gated x402 facilitator (the moat move for cat 1) — pay ANY x402 seller, but only trust the payment if
// the delivered work verifies. Merit wraps the generic X-PAYMENT client with the verifier and returns a signed
// verdict + keep/dispute recommendation. Reuses the same payAndFetch that /api/score uses in production.
//
// POST /api/facilitator { url, claim, maxUsdc? }
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) {
    return NextResponse.json(
      { error: rl.status === 429 ? "rate_limited" : "busy", retryAfterMs: rl.retryMs },
      { status: rl.status, headers: { "Retry-After": String(Math.ceil((rl.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { url?: string; claim?: string; maxUsdc?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const res = await facilitate({ url: body.url || "", claim: body.claim || "", maxUsdc: body.maxUsdc });
  if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({
    result: res.result,
    note: "Pay any x402 seller only if the delivered work verifies. A rail that pays on HTTP-200 trusts blindly; Merit returns a signed keep/dispute verdict on the same verificationId.",
  });
}

export function GET() {
  return NextResponse.json({
    facilitator: "merit.facilitator/v1",
    usage: {
      method: "POST",
      body: { url: "x402 seller URL", claim: "what the delivered content should support", maxUsdc: "hard spend ceiling (optional, default 0.05)" },
      returns: { mode: "probe | settled", paid: "{ amount, transaction }", verdict: "SUPPORTED | REFUSED", recommendation: "keep | dispute" },
    },
  });
}
