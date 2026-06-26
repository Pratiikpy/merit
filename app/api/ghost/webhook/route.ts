import { NextResponse } from "next/server";
import { verifyGhostSignature, parseGhostMember } from "@/lib/ghost";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/ghost/webhook (W3) — receives a Ghost member.* webhook, verifies the HMAC signature
// (GHOST_WEBHOOK_SECRET), parses the member, and acknowledges a creator-payment intent. The on-chain USDC
// settlement to the author + the Ghost Admin API write-back (flip the member to paid) are gated drop-ins —
// this is the testable boundary that closes the "creators paid + readers paying" loop.
export async function POST(req: Request) {
  const raw = await req.text();
  const sig = req.headers.get("x-ghost-signature");
  if (!verifyGhostSignature(raw, sig)) {
    return NextResponse.json({ error: "invalid webhook signature" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const member = parseGhostMember(body);
  if (!member) return NextResponse.json({ error: "no member in payload" }, { status: 400 });
  return NextResponse.json({
    ok: true,
    member: { id: member.id, status: member.status },
    intent: {
      action: "settle-creator-payment",
      note: "USDC settlement on Arc + the Ghost member flip are gated drop-ins (set GHOST_ADMIN_KEY + the author payTo).",
    },
  });
}
