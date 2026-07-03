import { NextResponse } from "next/server";
import { checkChallengeLimit } from "@/lib/ratelimit";
import {
  screenAddress,
  assertPayeeCompliant,
  complianceConfigured,
  complianceStats,
  recentScreens,
  denylist,
  addToDenylist,
  removeFromDenylist,
  refreshComplianceFromMirror,
} from "@/lib/compliance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function adminOk(req: Request): boolean {
  const token = process.env.MERIT_ADMIN_TOKEN;
  if (!token) return false;
  return (req.headers.get("x-admin-token") || "") === token;
}

// GET /api/compliance — the enterprise compliance pre-gate: what it is, whether Circle's Compliance Engine is
// live, and the public screening stats (approved/review/denied split). Public read; moves no value.
export async function GET(req: Request) {
  await refreshComplianceFromMirror().catch(() => {});
  const stats = complianceStats();
  // Label from OBSERVED behavior, not just key-presence (M2): a key can be present but not entitled, in which case
  // every call 403s and degrades to local — claiming "live" then would overstate enforcement.
  const provider = !complianceConfigured()
    ? "local (deterministic fallback — Circle Compliance Engine not configured)"
    : stats.viaCircle > 0
      ? "circle (Compliance Engine — configured; the vendor has answered live screens)"
      : "circle (configured — entitlement unverified; screens fall back to local until the vendor answers)";
  const isAdmin = adminOk(req);
  return NextResponse.json({
    schema: "merit.compliance/v1",
    what:
      "A KYT/sanctions pre-gate fused with the verify gate: before Merit settles USDC to a payee, the recipient is " +
      "screened for sanctions / terrorist-financing / illicit-behavior risk. A DENIED payee is blocked, so a real " +
      "disbursement is compliance-cleared AND work-verified. Wired into the custodial claim (on-chain payout).",
    provider,
    honesty:
      "A `cleared:true` result is a real Circle Compliance Engine answer; note a live Circle account with no screening " +
      "rules configured returns APPROVED for everything, so `cleared` means 'the vendor ran', not 'rules were enforced'. " +
      "A local APPROVED means only 'no local rule matched' — NOT a sanctions clearance. Merit's operator denylist + " +
      "structural checks are an authoritative HARD FLOOR (they DENY even over a vendor APPROVED); the documented testnet " +
      "suffixes are a fallback-only demo vector and never override a live vendor. If the vendor is configured but " +
      "unavailable, a screen degrades to REVIEW (or DENIED under MERIT_COMPLIANCE_STRICT=1) — never a silent approval.",
    endpoint: "POST { address } → a signed screening decision. Admin (X-Admin-Token): POST { action:'deny'|'allow', address } to manage the operator denylist.",
    stats,
    // Recent screens carry payee addresses + risk labels — admin-only, never public (M3: no public risk-label oracle).
    ...(isAdmin ? { recent: recentScreens(20), denylist: denylist() } : {}),
  });
}

// POST /api/compliance — screen an address, or (admin) manage the operator denylist. Screening moves no value but
// can call the Circle API, so it is rate-limited. Denylist mutation requires the admin token.
export async function POST(req: Request) {
  let body: { address?: string; action?: string; preflightPayee?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const address = (body.address || "").trim();
  if (!address) return NextResponse.json({ error: "provide an { address } to screen" }, { status: 400 });

  // Admin denylist management.
  if (body.action === "deny" || body.action === "allow") {
    if (!adminOk(req)) return NextResponse.json({ error: "admin disabled or unauthorized" }, { status: 403 });
    await refreshComplianceFromMirror().catch(() => {});
    if (body.action === "deny") {
      const r = await addToDenylist(address);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    } else {
      await removeFromDenylist(address);
    }
    return NextResponse.json({ ok: true, action: body.action, address, denylist: denylist() });
  }

  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) return NextResponse.json({ error: "busy — try again in a moment" }, { status: rl.status });
  await refreshComplianceFromMirror().catch(() => {});

  // preflightPayee=true returns the settlement decision (allowed) exactly as the payout path would apply it.
  if (body.preflightPayee) {
    const gate = await assertPayeeCompliant(address);
    return NextResponse.json({ allowed: gate.allowed, ...gate.screen });
  }
  const screen = await screenAddress(address);
  return NextResponse.json(screen);
}
