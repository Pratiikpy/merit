import { NextResponse } from "next/server";
import { authGate } from "@/lib/auth";
import { isVerifyError, verifyCitation } from "@/lib/verify/engine";
import { verifyWithCache, refreshVcacheFromMirror } from "@/lib/vcache";
import { available, balanceStatus, chargeVerified, depositAddressFor, noteRefused, refreshBalanceFromMirror } from "@/lib/balance";
import { cardFromVerdict, refreshCardsFromMirror, saveCard } from "@/lib/cards";
import { recordAuditVerdict, refreshAuditFromMirror } from "@/lib/audit";
import { openStream, getStream, recordPass, recordFail, rollbackTick, closeStream, streamView, listStreams, refreshStreamsFromMirror } from "@/lib/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Verified streaming (RFB-4). A principal opens a stream (rate per tick + a spend cap), then POSTs one tick per
// interval with the delivered chunk (claim + source). Each tick is verified with a CHEAP tier (numeric + NLI,
// never the per-call LLM judge — its cost would exceed a sub-cent tick). A PASSING tick releases the per-tick
// amount from the prepaid balance; a FAILING tick releases nothing and HALTS the stream (auto-stop on quality
// drift); the cap being reached halts it too. Value flows only toward verified-correct delivery, second by
// second. Every tick is a signed receipt carrying the verificationId join key.
function principalOr401(req: Request) {
  const gate = authGate(req);
  if (!gate.ok) return { error: gate.error, status: gate.status } as const;
  if (!gate.principal) return { error: "a stream requires an API key (Authorization: Bearer <key>)", status: 401 } as const;
  return { principal: gate.principal } as const;
}

// GET /api/stream?id=… — one stream's status, or list this principal's streams.
export async function GET(req: Request) {
  const g = principalOr401(req);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  await refreshStreamsFromMirror().catch(() => {});
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const s = getStream(id);
    if (!s || s.principalId !== g.principal.id) return NextResponse.json({ error: "stream not found" }, { status: 404 });
    return NextResponse.json(streamView(s));
  }
  return NextResponse.json({ streams: listStreams(g.principal.id) });
}

// POST /api/stream { action:"open", ratePerTick, cap, label } | { action:"tick", streamId, claim, source } | { action:"close", streamId }
export async function POST(req: Request) {
  const g = principalOr401(req);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  let body: { action?: string; streamId?: string; ratePerTick?: number; cap?: number; label?: string; claim?: string; source?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = body.action || (body.streamId ? "tick" : "open");

  // ---- open ----
  if (action === "open") {
    const rate = Number(body.ratePerTick);
    const cap = Number(body.cap);
    if (!(rate > 0) || !(cap > 0)) return NextResponse.json({ error: "provide { ratePerTick, cap } as positive USDC" }, { status: 400 });
    if (cap < rate) return NextResponse.json({ error: "cap must be at least one tick (ratePerTick)" }, { status: 400 });
    await refreshStreamsFromMirror().catch(() => {});
    await refreshBalanceFromMirror().catch(() => {});
    // Fail fast if the balance can't fund even one tick.
    if (available(g.principal.id) + 1e-9 < rate) {
      return NextResponse.json({ error: "insufficient prepaid balance to fund a stream — top up first", depositTo: depositAddressFor(g.principal.id), balance: balanceStatus(g.principal.id) }, { status: 402 });
    }
    const s = openStream(g.principal.id, { ratePerTick: rate, cap, label: body.label });
    return NextResponse.json({
      ok: true,
      ...streamView(s),
      note: `POST { action:"tick", streamId, claim, source } per interval — a passing tick releases $${s.ratePerTick} from your balance, a failing tick HALTS the stream. Ticks verify with numeric+NLI (cheap); the LLM judge is never run per tick.`,
    });
  }

  // ---- tick ----
  if (action === "tick") {
    const streamId = (body.streamId || "").trim();
    const claim = (body.claim || "").trim();
    const source = (body.source || "").trim();
    if (!streamId || !claim || !source) return NextResponse.json({ error: "provide { streamId, claim, source }" }, { status: 400 });
    await refreshStreamsFromMirror().catch(() => {});
    const s = getStream(streamId);
    if (!s || s.principalId !== g.principal.id) return NextResponse.json({ error: "stream not found" }, { status: 404 });
    if (s.closed) return NextResponse.json({ error: "stream closed", ...streamView(s) }, { status: 409 });
    if (s.halted) return NextResponse.json(streamView(s), { status: 409 });

    // Balance must cover one tick before we spend compute on it.
    await refreshBalanceFromMirror().catch(() => {});
    if (available(g.principal.id) + 1e-9 < s.ratePerTick) {
      recordFail(streamId, "prepaid balance exhausted");
      return NextResponse.json({ reason: "insufficient prepaid balance", ...streamView(getStream(streamId)!), depositTo: depositAddressFor(g.principal.id) }, { status: 402 });
    }

    // Verify this tick with the CHEAP tier (numeric + NLI); NEVER the per-call LLM judge.
    await refreshVcacheFromMirror().catch(() => {});
    const { outcome: out, cached } = await verifyWithCache(`${claim} [stream-tick]`, source, () => verifyCitation(claim, source, { useNLI: true, useJudge: false }));
    if (isVerifyError(out)) return NextResponse.json({ error: out.error, ...(out.numericOnly ? { numericOnly: true } : {}) }, { status: out.status });
    const v = out.verdict;
    if (!cached) {
      try {
        await refreshAuditFromMirror();
        recordAuditVerdict(v, claim);
      } catch {
        /* audit never fails a tick */
      }
    }
    await refreshCardsFromMirror().catch(() => {});
    const card = saveCard(cardFromVerdict(v, { kind: "verify", source, depth: "nli", createdAt: new Date().toISOString() }));
    const origin = process.env.MERIT_ORIGIN || new URL(req.url).origin;

    if (v.verdict === "SUPPORTED") {
      // recordPass is the atomic cap gate; then charge the balance; roll back + halt if the balance raced empty.
      const pass = await recordPass(streamId, v.verificationId);
      if (!pass.ok) return NextResponse.json({ reason: pass.reason, ...streamView(getStream(streamId)!), receiptId: card.id, receiptUrl: `${origin}/v/${card.id}` }, { status: 409 });
      const charge = chargeVerified(g.principal.id, s.ratePerTick);
      if (!charge.ok) {
        rollbackTick(streamId, "prepaid balance exhausted mid-tick");
        return NextResponse.json({ reason: "insufficient prepaid balance", ...streamView(getStream(streamId)!) }, { status: 402 });
      }
      return NextResponse.json({
        tick: "released",
        verdict: v.verdict,
        releasedUsd: s.ratePerTick,
        ...streamView(getStream(streamId)!),
        verificationId: v.verificationId,
        receiptId: card.id,
        receiptUrl: `${origin}/v/${card.id}`,
        balance: balanceStatus(g.principal.id),
      });
    }
    // FAILED tick — halt the stream, charge nothing.
    noteRefused(g.principal.id);
    recordFail(streamId, v.reason || "tick did not verify", v.verificationId);
    return NextResponse.json({
      tick: "refused-halted",
      verdict: v.verdict,
      reason: v.reason,
      ...streamView(getStream(streamId)!),
      verificationId: v.verificationId,
      receiptId: card.id,
      receiptUrl: `${origin}/v/${card.id}`,
    });
  }

  // ---- close ----
  if (action === "close") {
    await refreshStreamsFromMirror().catch(() => {});
    const view = closeStream((body.streamId || "").trim(), g.principal.id);
    if (!view) return NextResponse.json({ error: "stream not found" }, { status: 404 });
    return NextResponse.json({ ok: true, ...view });
  }

  return NextResponse.json({ error: 'action must be "open" | "tick" | "close"' }, { status: 400 });
}

// DELETE /api/stream?id=… — close a stream.
export async function DELETE(req: Request) {
  const g = principalOr401(req);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  await refreshStreamsFromMirror().catch(() => {});
  const view = closeStream(new URL(req.url).searchParams.get("id") || "", g.principal.id);
  if (!view) return NextResponse.json({ error: "stream not found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...view });
}
