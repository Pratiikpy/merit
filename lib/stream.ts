/**
 * Verified streaming payments (RFB-4 — pay-per-tick, verification-gated). A consumer opens a stream against
 * its prepaid balance with a per-tick rate + a spend cap; each tick delivers a chunk (a claim + its source)
 * and Merit verifies it with a CHEAP tier (numeric + self-hosted NLI — never the per-call LLM judge, whose
 * cost would exceed a sub-cent tick). A passing tick releases the per-tick amount; a FAILING tick releases
 * nothing and HALTS the stream (auto-stop on quality drift), and the cap being reached halts it too. So value
 * flows only toward verified-correct delivery, second by second — "start a stream, but pay only for what
 * verifies." Pay-as-you-go: nothing is reserved up front, so there is nothing to refund — you only ever paid
 * for the ticks that passed. This file is the pure, atomic STATE logic; the route runs the verify + the
 * balance debit and calls recordPass/recordFail. Store-backed + Supabase-mirrored so a stream survives across
 * serverless instances; per-stream serialized so concurrent ticks can't over-spend the cap.
 */
import { round6 } from "./arc";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";
import { serialize } from "./locks";

export interface Stream {
  id: string;
  principalId: string; // whose prepaid balance the ticks charge
  ratePerTick: number; // USDC released per verified tick
  cap: number; // max total USDC this stream may spend before it halts
  spent: number; // total released so far (verified ticks only)
  released: number; // count of verified ticks that were paid
  failed: number; // count of ticks that did not verify
  halted: boolean;
  haltReason?: string;
  closed: boolean;
  label?: string;
  lastVerificationId?: string; // the join key of the most recent tick
  createdAt: number;
  lastAt: number;
}
interface StreamLog {
  streams: Record<string, Stream>;
}

const DOC = "streams";
const MAX_RATE = 1; // sanity bound: a "tick" is a nanopayment, not a bulk charge

let cache: StreamLog | null = null;
function load(): StreamLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<StreamLog>(DOC, { streams: {} });
  if (!value.streams) value.streams = {};
  if (cacheable) cache = value;
  return value;
}
/** Read-your-writes refresh from the durable mirror before a tick on serverless (a stream opened on another
 *  instance would otherwise be invisible here). No-op off the ephemeral Supabase mirror. */
export async function refreshStreamsFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<StreamLog>(DOC);
  if (v && typeof v === "object") {
    if (!v.streams) v.streams = {};
    cache = v;
  }
}
function persist(): void {
  if (cache) saveDoc(DOC, cache);
}

/** Open a verified stream against a principal's prepaid balance. */
export function openStream(principalId: string, opts: { ratePerTick: number; cap: number; label?: string }): Stream {
  const rate = Math.min(MAX_RATE, Math.max(0.000001, round6(Number(opts.ratePerTick) || 0)));
  const cap = Math.max(rate, round6(Number(opts.cap) || 0));
  const log = load();
  const id = "stream_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const now = Date.now();
  const s: Stream = { id, principalId, ratePerTick: rate, cap, spent: 0, released: 0, failed: 0, halted: false, closed: false, label: (opts.label || "").slice(0, 80), createdAt: now, lastAt: now };
  log.streams[id] = s;
  cache = log;
  persist();
  return s;
}

export function getStream(id: string): Stream | undefined {
  return load().streams[id];
}

export interface StreamView {
  id: string;
  ratePerTick: number;
  cap: number;
  spent: number;
  released: number;
  failed: number;
  remaining: number;
  halted: boolean;
  haltReason?: string;
  closed: boolean;
  live: boolean;
  lastVerificationId?: string;
}
export function streamView(s: Stream): StreamView {
  const remaining = round6(Math.max(0, s.cap - s.spent));
  return { id: s.id, ratePerTick: s.ratePerTick, cap: s.cap, spent: s.spent, released: s.released, failed: s.failed, remaining, halted: s.halted, haltReason: s.haltReason, closed: s.closed, live: !s.halted && !s.closed && remaining >= s.ratePerTick, lastVerificationId: s.lastVerificationId };
}

/**
 * Record a PASSING tick: atomically (per-stream lock) charge the per-tick amount against the cap. Refuses when
 * the stream is halted/closed or the cap can't cover one more tick — and auto-halts when the cap is reached,
 * so the caller never over-spends. Returns the remaining cap; the caller (route) has already run the verify
 * and is responsible for the actual balance debit before calling this.
 */
export async function recordPass(id: string, verificationId?: string): Promise<{ ok: true; remaining: number; released: number } | { ok: false; reason: string }> {
  return serialize("stream:" + id, async () => {
    const s = load().streams[id];
    if (!s) return { ok: false, reason: "stream not found" };
    if (s.closed) return { ok: false, reason: "stream closed" };
    if (s.halted) return { ok: false, reason: `stream halted — ${s.haltReason || "quality drift"}` };
    if (round6(s.spent + s.ratePerTick) > s.cap + 1e-9) {
      s.halted = true;
      s.haltReason = `cap ($${s.cap}) reached`;
      s.lastAt = Date.now();
      persist();
      return { ok: false, reason: `cap ($${s.cap}) reached — stream halted` };
    }
    s.spent = round6(s.spent + s.ratePerTick);
    s.released += 1;
    if (verificationId) s.lastVerificationId = verificationId;
    s.lastAt = Date.now();
    persist();
    return { ok: true, remaining: round6(Math.max(0, s.cap - s.spent)), released: s.released };
  });
}

/** Undo a recorded pass and halt — used ONLY when the balance debit that should follow a pass fails (a rare
 *  race where the balance emptied between the fail-fast check and the charge). Keeps stream.spent consistent
 *  with the money actually charged, and halts the stream since it can no longer pay. */
export function rollbackTick(id: string, reason: string): void {
  const s = load().streams[id];
  if (!s) return;
  s.spent = round6(Math.max(0, s.spent - s.ratePerTick));
  s.released = Math.max(0, s.released - 1);
  s.halted = true;
  s.haltReason = reason.slice(0, 120);
  s.lastAt = Date.now();
  persist();
}

/** Record a FAILING tick: the stream auto-halts (pay-per-second stops the instant quality drifts). No charge. */
export function recordFail(id: string, reason: string, verificationId?: string): void {
  const s = load().streams[id];
  if (!s || s.closed) return;
  s.failed += 1;
  s.halted = true;
  s.haltReason = reason.slice(0, 120);
  if (verificationId) s.lastVerificationId = verificationId;
  s.lastAt = Date.now();
  persist();
}

/** Close a stream (final). Pay-as-you-go, so there is no refund — the consumer only paid for verified ticks. */
export function closeStream(id: string, principalId: string): StreamView | null {
  const s = load().streams[id];
  if (!s || s.principalId !== principalId) return null;
  s.closed = true;
  s.lastAt = Date.now();
  persist();
  return streamView(s);
}

export function listStreams(principalId: string): StreamView[] {
  return Object.values(load().streams)
    .filter((s) => s.principalId === principalId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(streamView);
}

/** Test seam. */
export function _resetStreams(): void {
  cache = null;
}
