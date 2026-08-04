import { NextResponse } from "next/server";
import { authorize, listGuardReceipts, guardStats, getPolicy, refreshGuardPlaneFromMirror } from "@/lib/guardplane";
import { authGate, refreshAuthFromMirror } from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Agent Treasury Guardrails — the one authorize call an agent routes every disbursement through. Composes the
// kill-switch, Circle compliance, the admin-authored policy, rolling per-counterparty exposure, and the tx
// simulation; the decision (allow AND block) is itself a signed receipt persisted before the caller sees it.
//
// POST /api/guard/authorize { payee, amountUsdc }
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) {
    return NextResponse.json(
      { error: rl.status === 429 ? "rate_limited" : "busy", retryAfterMs: rl.retryMs },
      { status: rl.status, headers: { "Retry-After": String(Math.ceil((rl.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { payee?: string; amountUsdc?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  await refreshAuthFromMirror().catch(() => {});
  await refreshGuardPlaneFromMirror().catch(() => {});
  const gate = authGate(req);
  const principal = gate.ok && gate.principal ? gate.principal.name || gate.principal.id : "anonymous";
  const receipt = await authorize({ principal, payee: body.payee || "", amountUsdc: Number(body.amountUsdc) });
  return NextResponse.json({
    receipt,
    note:
      receipt.decision === "allow"
        ? "Authorized — every gate passed, and this allowance is itself a signed receipt."
        : "Blocked — and the refusal is signed evidence the guardrail fired, not a log line. An admin override (naming a human) can chain to this receipt id.",
  });
}

// GET → the control plane read view: active policy (read-only to agents), stats, recent signed decisions.
export async function GET() {
  await refreshGuardPlaneFromMirror().catch(() => {});
  return NextResponse.json({
    schema: "merit.guard/v1",
    policy: getPolicy(), // agents can READ the policy; only the admin credential can change it
    stats: guardStats(),
    recent: listGuardReceipts(30),
  });
}
