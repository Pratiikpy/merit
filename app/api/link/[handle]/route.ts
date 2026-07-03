import { NextResponse, after } from "next/server";
import { applyOutcome, publicView, refreshRegistryFromMirror, resolveSourceRef } from "@/lib/registry";
import { emitWebhookEvent, refreshWebhooksFromMirror, type WebhookEvent } from "@/lib/webhooks";
import { isVerifyError, verifyCitation } from "@/lib/verify/engine";
import { verifyWithCache, refreshVcacheFromMirror } from "@/lib/vcache";
import { cardFromVerdict, refreshCardsFromMirror, saveCard } from "@/lib/cards";
import { recordAuditVerdict, refreshAuditFromMirror } from "@/lib/audit";
import { accrueCustody, refreshCustodyFromMirror } from "@/lib/custody";
import { computeSplits, hasSplits, type ResolvedShare } from "@/lib/splits";
import { canSettle, recordSettle, refreshLinkBudgetFromMirror, remainingInWindow } from "@/lib/linkbudget";
import { canSpend, recordSpend, refreshGuardFromMirror } from "@/lib/guard";
import { ensureDeposit, payOnce } from "@/lib/pay";
import { serialize } from "@/lib/locks";
import { recordLedgerSettlement } from "@/lib/ledger";
import { recordSettlement } from "@/lib/history";
import { effectivePrice } from "@/lib/pricing";
import { isStub, round6 } from "@/lib/arc";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // NLI + adversarial judge + a Gateway settle can take several seconds

// GET /api/link/[handle] — the public view of a creator's Merit Link (identity, price, gate, live budget).
export async function GET(_req: Request, ctx: { params: Promise<{ handle: string }> }) {
  const { handle } = await ctx.params;
  await refreshRegistryFromMirror().catch(() => {});
  const s = resolveSourceRef(handle);
  if (!s) return NextResponse.json({ error: "unknown creator" }, { status: 404 });
  return NextResponse.json({
    source: publicView(s),
    custodial: !!s.custodial,
    hasContent: !!(s.content && s.content.length > 0),
    tollBudgetRemaining: remainingInWindow(Date.now()),
    stub: isStub(),
  });
}

// POST /api/link/[handle] { claim } — the citation toll. Verifies the claim against THIS creator's source with
// the full engine (numeric + NLI + adversarial judge); on SUPPORTED it settles the creator's price — real USDC
// on Arc for a wallet-holding creator (bounded by the public toll budget), or accrued to Merit custody for a
// custodial one. On REFUSED it pays nothing and returns why. Either way it mints a shareable receipt card.
export async function POST(req: Request, ctx: { params: Promise<{ handle: string }> }) {
  const gate = checkChallengeLimit(Date.now());
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "busy — try again in a moment", retryAfterMs: gate.retryMs },
      { status: gate.status, headers: { "Retry-After": String(Math.ceil((gate.retryMs ?? 3000) / 1000)) } },
    );
  }

  const { handle } = await ctx.params;
  await refreshRegistryFromMirror().catch(() => {});
  const s = resolveSourceRef(handle);
  if (!s) return NextResponse.json({ error: "unknown creator" }, { status: 404 });
  if (!s.content || s.content.length === 0) {
    return NextResponse.json({ error: "this creator has no readable source content to cite yet" }, { status: 400 });
  }

  let body: { claim?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const claim = (body.claim || "").trim();
  if (!claim) return NextResponse.json({ error: "provide a { claim } to cite this creator for" }, { status: 400 });

  await refreshVcacheFromMirror().catch(() => {});
  const { outcome: out, cached } = await verifyWithCache(claim, s.content, () => verifyCitation(claim, s.content));
  if (isVerifyError(out)) {
    return NextResponse.json({ error: out.error, ...(out.numericOnly ? { numericOnly: true } : {}) }, { status: out.status });
  }
  const v = out.verdict;
  if (!cached) {
    try {
      await refreshAuditFromMirror();
      recordAuditVerdict(v, claim);
    } catch {
      /* the audit trail never fails a verification */
    }
  }

  const price = round6(effectivePrice(s.price, s.merit, s.priceMode));
  const now = Date.now();
  // settled shapes: {onchain-real} | {custody} | {stub} | {paused} | {error}; null = refused (no payment attempted).
  let settled:
    | { amount: number; tx?: string; explorerUrl?: string; onchain?: boolean; custody?: boolean; stub?: boolean; paused?: boolean; reason?: string; error?: string; splits?: ResolvedShare[] }
    | null = null;

  if (v.verdict === "SUPPORTED") {
    if (hasSplits(s.splits)) {
      // #12: multi-author source — split the VERIFIED price across contributors (recursively down the lineage),
      // accruing each leaf's share to its own Merit custody (claimable via domain proof). Downstream of the
      // verify gate: only a passing citation's amount is ever split; no buyer-wallet spend (custody accrual).
      await refreshCustodyFromMirror().catch(() => {});
      const shares = computeSplits(s.splits, price);
      for (const sh of shares) accrueCustody(`split:${(sh.domain || sh.name).toLowerCase()}`, sh.name, sh.amount, sh.domain ? { domain: sh.domain } : undefined);
      applyOutcome(s.id, { meritDelta: 1, earned: price });
      recordSettlement({ runId: "link", sourceId: s.id, cited: true, released: true, amount: price, confidence: v.score ?? 0, reason: "link:split", at: now });
      settled = { amount: price, custody: true, onchain: false, splits: shares };
    } else if (s.custodial) {
      // Wallet-less creator: hold the earning in Merit custody (claimable on-chain via domain proof). No buyer
      // spend, so this is not subject to the public toll budget.
      await refreshCustodyFromMirror().catch(() => {});
      accrueCustody(s.id, s.name, price, { domain: s.domain });
      applyOutcome(s.id, { meritDelta: 1, earned: price });
      recordSettlement({ runId: "link", sourceId: s.id, cited: true, released: true, amount: price, confidence: v.score ?? 0, reason: "link:custody", at: now });
      settled = { amount: price, custody: true, onchain: false };
    } else if (isStub()) {
      // No key on this deployment — settle nothing and DON'T fabricate a tx. The verification is still real.
      settled = { amount: price, stub: true };
    } else {
      // Serialize the whole budget check → settle → record so the window cap can't be raced: canSettle reads the
      // spend log, but recordSettle only lands AFTER the multi-second payOnce, so concurrent tolls would otherwise
      // all read a pre-settlement budget and collectively overspend (a check-then-act race on real USDC). The lock
      // makes check-and-spend atomic on this instance; the mirror refresh inside narrows the cross-instance window.
      settled = await serialize("link-settle", async () => {
        await refreshLinkBudgetFromMirror().catch(() => {});
        await refreshGuardFromMirror().catch(() => {});
        // Second predicate: settle only if verified AND the operator guard allows (not frozen, under the daily
        // hard cap). A verified citation whose settlement the guard pauses is honest — the verdict stands, the
        // money just doesn't move.
        const g = canSpend(price, now);
        if (!g.ok) return { amount: price, paused: true, reason: g.reason } as const;
        if (!canSettle(price, now)) {
          // The public toll budget for this window is spent — verify, but pause on-chain settlement (honest).
          return { amount: price, paused: true } as const;
        }
        try {
          const base = process.env.MERIT_ORIGIN
            ? process.env.MERIT_ORIGIN.replace(/\/+$/, "")
            : process.env.VERCEL_URL
              ? `https://${process.env.VERCEL_URL}`
              : `http://localhost:${process.env.PORT || 3000}`;
          await ensureDeposit(Math.max(0.5, price), "1");
          const ceiling = round6(s.price * 1.5); // seller re-quotes merit-gated price at settle; authorize up to its max
          const r = await payOnce(`${base}/api/source/${s.id}`, ceiling);
          const charged = round6(r.amount || price);
          recordSettle(charged, now);
          recordSpend(charged, now); // guard: track spend + trip the velocity circuit breaker on a burst
          applyOutcome(s.id, { meritDelta: 1, earned: charged });
          recordSettlement({ runId: "link", sourceId: s.id, cited: true, released: true, amount: charged, confidence: v.score ?? 0, reason: "link:released", at: now });
          if (r.onchain) recordLedgerSettlement({ runId: "link_" + randomBytes(6).toString("hex"), sourceId: s.id, amount: charged, at: now });
          return { amount: charged, tx: r.transaction, explorerUrl: r.explorerUrl, onchain: r.onchain };
        } catch (e) {
          // Verification passed but the on-chain settle failed — report it, don't pretend it paid.
          return { amount: price, error: (e as Error).message.slice(0, 140) };
        }
      });
    }
  }

  // Mint a shareable receipt. A real on-chain settle OR a custody accrual carries the paid amount as a
  // "settlement" card; everything else (refused, paused, stub, settle-error) is a plain "verify" card with no
  // payment claimed. The `custody` flag keeps an accrual from ever being rendered as an on-chain "settled".
  const paid = settled && !settled.error && !settled.paused && !settled.stub ? settled.amount : undefined;
  const isCustody = !!(settled && settled.custody);
  await refreshCardsFromMirror().catch(() => {});
  const card = saveCard(
    cardFromVerdict(v, {
      kind: paid !== undefined ? "settlement" : "verify",
      source: s.content,
      sourceUrl: s.url,
      sourceName: s.name,
      paidUsdc: paid,
      custody: isCustody || undefined,
      // When the accrual was distributed, carry the per-recipient breakdown so the receipt attributes each
      // share to who actually received it — never to the collective's custody (it holds none of it).
      splits: settled?.splits?.map((sh) => ({ name: sh.name, amount: sh.amount })),
      tx: settled?.tx,
      explorerUrl: settled?.explorerUrl,
      createdAt: new Date(now).toISOString(),
    }),
  );

  const origin = process.env.MERIT_ORIGIN || new URL(req.url).origin;
  const receiptUrl = `${origin}/v/${card.id}`;

  // Emit a SIGNED, verdict-carrying webhook so an integrator reacts to WHY money did or didn't move. Public
  // event (same data as /proof), delivered after the response so it never blocks the toll. Best-effort.
  const claimPreview = claim.length > 120 ? claim.slice(0, 120) + "…" : claim;
  const common = { at: new Date(now).toISOString(), verdict: v.verdict, claim: claimPreview, sourceName: s.name, receiptUrl, receiptId: card.id };
  let evt: WebhookEvent | null = null;
  if (v.verdict !== "SUPPORTED") {
    evt = { type: "citation.refused", reason: v.reason, ...common };
  } else if (settled?.paused) {
    evt = { type: "toll.paused", reason: settled.reason || "public toll budget reached for this window", amount: price, ...common };
  } else if (settled?.error) {
    evt = { type: "citation.settle_failed", reason: settled.error, amount: price, ...common };
  } else if (settled && !settled.stub) {
    evt = { type: "citation.settled", reason: "citation verified", amount: settled.amount, custody: !!settled.custody, onchain: !!settled.onchain, tx: settled.tx || null, ...(settled.splits ? { splits: settled.splits } : {}), ...common };
  }
  if (evt) {
    const toSend = evt;
    after(async () => {
      await refreshWebhooksFromMirror().catch(() => {});
      await emitWebhookEvent(toSend);
    });
  }

  return NextResponse.json({
    id: card.id,
    url: receiptUrl,
    verdict: v.verdict,
    reason: v.reason,
    gates: v.gates,
    price,
    settled,
    cached, // the verification was served from cache; settlement still ran fresh
    card,
  });
}
