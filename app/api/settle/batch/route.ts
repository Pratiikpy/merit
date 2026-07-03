import { NextResponse } from "next/server";
import { authGate , refreshAuthFromMirror} from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { resolveSourceRef, refreshRegistryFromMirror } from "@/lib/registry";
import { effectivePrice } from "@/lib/pricing";
import { refreshCustodyFromMirror } from "@/lib/custody";
import { refreshCardsFromMirror } from "@/lib/cards";
import { settleVerifiedBatch, summarize, type BatchItemResolved, type BatchLine } from "@/lib/netsettle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

const MAX_ITEMS = 20;

// POST /api/settle/batch { items: [{ claim, sourceRef? | source?, amount?, sourceName? }] } — verified net
// settlement. Verify a whole basket of cited lines and settle ONLY the ones that verify, quarantining the rest;
// the buyer authorizes N and pays only the k that support their claims. Keyed — it moves value + runs a
// verification pass per line. Each settled line is a signed /v/<id> receipt.
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) return NextResponse.json({ error: "busy — try again in a moment" }, { status: rl.status });
  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!gate.principal) return NextResponse.json({ error: "batch settlement requires an API key (Authorization: Bearer <key>)" }, { status: 401 });

  let body: { items?: Array<{ claim?: string; sourceRef?: string; source?: string; amount?: number; sourceName?: string }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return NextResponse.json({ error: "provide { items: [{ claim, sourceRef | source, amount? }] }" }, { status: 400 });
  if (items.length > MAX_ITEMS) return NextResponse.json({ error: `a batch is at most ${MAX_ITEMS} items` }, { status: 400 });

  await refreshRegistryFromMirror().catch(() => {});
  const resolved: BatchItemResolved[] = [];
  const preLines: BatchLine[] = []; // lines that fail to resolve — reported as errors, never settled

  for (const it of items) {
    const claim = (it.claim || "").trim();
    if (!claim) {
      preLines.push({ sourceName: it.sourceName || it.sourceRef || "unknown", claim: "", amount: Number(it.amount) || 0, verdict: "error", settled: false, reason: "missing claim" });
      continue;
    }
    if (it.sourceRef) {
      const s = resolveSourceRef(it.sourceRef);
      if (!s || !s.content) {
        preLines.push({ sourceName: it.sourceRef, claim, amount: Number(it.amount) || 0, verdict: "error", settled: false, reason: "unknown source ref" });
        continue;
      }
      const amount = Number(it.amount) > 0 ? Number(it.amount) : effectivePrice(s.price, s.merit, s.priceMode);
      resolved.push({ sourceId: s.id, sourceName: s.name, content: s.content, claim, amount, domain: s.domain, sourceUrl: s.url });
    } else if (it.source && it.source.trim()) {
      const amount = Number(it.amount);
      if (!(amount > 0)) {
        preLines.push({ sourceName: it.sourceName || "inline", claim, amount: 0, verdict: "error", settled: false, reason: "inline line needs a positive amount" });
        continue;
      }
      resolved.push({ sourceName: it.sourceName || "inline source", content: it.source.trim(), claim, amount });
    } else {
      preLines.push({ sourceName: it.sourceName || "unknown", claim, amount: Number(it.amount) || 0, verdict: "error", settled: false, reason: "provide sourceRef or source" });
    }
  }

  await refreshCustodyFromMirror().catch(() => {});
  await refreshCardsFromMirror().catch(() => {});
  const result = await settleVerifiedBatch(resolved);

  const origin = process.env.MERIT_ORIGIN || new URL(req.url).origin;
  const lines = [...result.lines, ...preLines].map((l) => ({ ...l, receiptUrl: l.receiptId ? `${origin}/v/${l.receiptId}` : undefined }));
  const totals = summarize(lines);

  return NextResponse.json({
    ...totals,
    lines,
    savings: `Authorized ${totals.count} lines ($${totals.totalAuthorized}); settled the ${totals.settledCount} that VERIFIED ($${totals.totalSettled}) and quarantined ${totals.quarantinedCount} ($${totals.totalQuarantined}) whose content did not support its claim. On a pay-on-delivery rail the full $${totals.totalAuthorized} would have moved — $${totals.totalQuarantined} of it for unverified work.`,
    note: "Net settlement pays a basket down to its verified subset — every line is verified with the signed CVO before any money moves, and a quarantined line costs the buyer nothing.",
  });
}
