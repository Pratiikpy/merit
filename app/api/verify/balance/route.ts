import { NextResponse } from "next/server";
import { authGate, keyFromRequest , refreshAuthFromMirror} from "@/lib/auth";
import { chargeSession, isSessionKey, refundSession, resolveSession, refreshSessionsFromMirror } from "@/lib/session";
import { isVerifyError, verifyCitation } from "@/lib/verify/engine";
import { verifyWithCache, refreshVcacheFromMirror } from "@/lib/vcache";
import { available, balanceStatus, chargeVerified, depositAddressFor, noteRefused, refreshBalanceFromMirror } from "@/lib/balance";
import { cardFromVerdict, refreshCardsFromMirror, saveCard } from "@/lib/cards";
import { recordAuditVerdict, refreshAuditFromMirror } from "@/lib/audit";
import { asDepth, depthLayers, verifyDepthPrice } from "@/lib/pricing";
import { round6 } from "@/lib/arc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/verify/balance { claim, source } — verify against the principal's PREPAID balance, billed ONLY when
// the citation VERIFIES. A REFUSED citation costs nothing and stays in the balance. Requires an API key (the
// balance belongs to a principal). Returns the verdict + the live balance so the burn-down is visible. This is
// "pay only for what verifies" made literal: refused citations are free, and the remainder is withdrawable.
export async function POST(req: Request) {
  // Accept either the principal's API key, or a verify-bound SESSION key (delegation) — a session key spends the
  // PARENT principal's balance, capped by the session, and can be used at NO other endpoint.
  const rawKey = keyFromRequest(req);
  let pid: string;
  let sessionId: string | null = null;
  if (isSessionKey(rawKey)) {
    await refreshSessionsFromMirror().catch(() => {}); // pull the authoritative session set before resolving (cross-instance)
    const s = resolveSession(rawKey);
    if (!s) return NextResponse.json({ error: "invalid, revoked, or expired session key" }, { status: 401 });
    pid = s.parentId;
    sessionId = s.id;
  } else {
    await refreshAuthFromMirror().catch(() => {});
    const gate = authGate(req);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    if (!gate.principal) return NextResponse.json({ error: "a prepaid balance requires an API key (Authorization: Bearer <key>)" }, { status: 401 });
    pid = gate.principal.id;
  }

  let body: { claim?: string; source?: string; depth?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const claim = (body.claim || "").trim();
  const source = (body.source || "").trim();
  if (!claim || !source) return NextResponse.json({ error: "provide { claim, source }" }, { status: 400 });
  const depth = asDepth(body.depth);
  const { useNLI, useJudge } = depthLayers(depth);
  const PRICE = verifyDepthPrice(depth); // price scales with the verification depth tier

  await refreshBalanceFromMirror().catch(() => {});
  // Fail fast if the balance can't even cover ONE verification — so we don't spend compute the caller can't pay for.
  if (available(pid) + 1e-9 < PRICE) {
    return NextResponse.json(
      { error: "insufficient prepaid balance — top up to continue", pricePerVerify: PRICE, depth, depositTo: depositAddressFor(pid), balance: balanceStatus(pid) },
      { status: 402 },
    );
  }

  await refreshVcacheFromMirror().catch(() => {});
  const cacheClaim = depth === "full" ? claim : `${claim} [depth:${depth}]`;
  const { outcome: out, cached } = await verifyWithCache(cacheClaim, source, () => verifyCitation(claim, source, { useNLI, useJudge }));
  if (isVerifyError(out)) return NextResponse.json({ error: out.error, ...(out.numericOnly ? { numericOnly: true } : {}) }, { status: out.status });
  const v = out.verdict;

  // Bill ONLY a verified citation; a refusal costs nothing (refund-to-balance) and is counted for the framing.
  let charged = 0;
  if (v.verdict === "SUPPORTED") {
    // A session key is bound by its own cap first — atomic, so it can't blow past the delegated limit.
    if (sessionId) {
      const cs = chargeSession(sessionId, PRICE);
      if (!cs.ok) return NextResponse.json({ error: `session limit — ${cs.reason}`, pricePerVerify: PRICE }, { status: 402 });
    }
    const r = chargeVerified(pid, PRICE);
    if (!r.ok) {
      if (sessionId) refundSession(sessionId, PRICE); // give the session charge back — the balance couldn't cover it
      return NextResponse.json(
        { error: "insufficient prepaid balance — top up to continue", pricePerVerify: PRICE, depositTo: depositAddressFor(pid), balance: balanceStatus(pid) },
        { status: 402 },
      );
    }
    charged = r.charged;
  } else {
    noteRefused(pid);
  }

  if (!cached) {
    try {
      await refreshAuditFromMirror();
      recordAuditVerdict(v, claim);
    } catch {
      /* audit never fails a verdict */
    }
  }
  await refreshCardsFromMirror().catch(() => {});
  const card = saveCard(cardFromVerdict(v, { kind: "verify", source, depth, createdAt: new Date().toISOString() }));
  const origin = process.env.MERIT_ORIGIN || new URL(req.url).origin;
  const bal = balanceStatus(pid);

  return NextResponse.json({
    ...v,
    cached,
    depth,
    charged, // USDC burned (0 for a refused citation)
    billing: v.verdict === "SUPPORTED" ? `charged $${round6(charged)} — the citation verified` : "not charged — the citation was refused (it stayed in your balance)",
    balance: bal,
    receiptUrl: `${origin}/v/${card.id}`,
    receiptId: card.id,
  });
}
