/**
 * The autonomous loop — Arc's own named archetype, built literally: "deploy a team of agents that
 * hold a treasury on Arc, pay for services in USDC, and are left to cook... zero-person companies
 * that earn, spend, and settle entirely onchain."
 *
 * A scheduled tick (Vercel cron, see app/api/cron/autonomous/route.ts) picks the next real question
 * off a versioned backlog, runs Merit's own agent against it with real discovery (live RSS, not seed
 * fixtures) and a small budget drawn from Merit's own treasury wallet (lib/treasury.ts — the same
 * BUYER wallet every run already spends from), and records what happened. No human clicks anything.
 *
 * Bounded on purpose, entirely in-app rather than against a third-party spend-cap contract: a
 * per-tick ceiling, a rolling-24h total cap, and a reserve floor the loop will never spend the
 * treasury below. (An open, Arc-native bounded-spend primitive — AgentVault/MandateEscrow — already
 * exists and proves this pattern works; it is also explicitly "not audited yet" by its own builder,
 * so Merit's real treasury does not route through it. The caps here are the same shape, just kept
 * under Merit's own control until that changes.)
 */
import { randomBytes } from "node:crypto";
import { runAgent, type Emit } from "./agent";
import { readTreasuryBalance } from "./treasury";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";
import { round6 } from "./arc";

/** Real, falsifiable claims worth researching — Merit's own domain (stablecoins, Arc, agent
 *  payments), so a genuine citation either holds up or doesn't. Versioned and append-only: add to
 *  the end, never reorder or delete (ticks index into this by position, and the log records which
 *  index ran so a question is never silently re-asked out of order). */
export const AUTONOMOUS_BACKLOG: string[] = [
  "Has Arc mainnet processed over 500 million USDC in circulating supply within its first two weeks of launch?",
  "Does Arc use USDC as its native gas token, with no separate volatile gas token required?",
  "Is Circle the first publicly traded company to mint a network token for a new blockchain?",
  "Does the EIP-3009 TransferWithAuthorization standard allow a wallet with zero native gas to authorize a USDC transfer that someone else broadcasts and pays gas for?",
  "Does Arc's RPC cap eth_getLogs requests at a fixed block-range regardless of how much log data is actually requested?",
  "Is BlackRock's 'The Machine-Native Economy' whitepaper framed around machine-to-machine payments and settlement, and does it reference Arc and USDC specifically?",
  "Does the x402 protocol settle payments using an HTTP 402 Payment Required status code as its core mechanism?",
  "Does Circle's Cross-Chain Transfer Protocol (CCTP) move USDC across chains by burning on the source chain and minting on the destination, rather than by locking and wrapping?",
  "Is ERC-8004 a standard specifically for AI agent identity, reputation, and validation registries on Ethereum-compatible chains?",
  "Does Arc's native USDC system emitter (the EIP-7708 address) log every USDC movement at 18 decimals, including ones that originate from the 6-decimal ERC-20 interface?",
];

const DOC = "autonomous";
const MAX_LOG = 300;

export interface AutonomousTick {
  id: string;
  backlogIndex: number;
  question: string;
  budget: number;
  startedAt: string;
  finishedAt?: string;
  treasuryBefore: number | null;
  treasuryAfter: number | null;
  spent: number | null; // ledger.totals.spent from the run, when it completed
  outcome: "ok" | "skipped" | "error";
  skipReason?: string;
  error?: string;
  summary?: unknown; // the run's own signed receipt body, verbatim — the proof
  /** The REAL treasury drop (treasuryBefore - treasuryAfter), which includes gas for every on-chain
   *  write the run made — not just `spent` (the labor/citation ledger total `budget` actually bounds).
   *  ERC-8004 identity minting is a real, one-time-per-identity cost that does NOT scale down just
   *  because `budget` is small: a tick that happens to discover several never-before-seen sources or
   *  specialists can cost several times the nominal budget in mint gas alone, even though it refuses
   *  to cite anything. Verified directly: a cold isolated test registry's first tick cost $1.01 against
   *  a $0.02 budget (9 fresh identity mints); the same backlog's second tick, with those identities now
   *  cached, cost $0.009. costAnomaly flags when realCostUsdc materially exceeds the nominal budget, so
   *  a mint-storm is visible on the dashboard rather than silently explained away after the fact. */
  realCostUsdc?: number | null;
  costAnomaly?: boolean;
}
interface AutonomousLog {
  ticks: AutonomousTick[];
  nextBacklogIndex: number;
}

let cache: AutonomousLog | null = null;
function load(): AutonomousLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<AutonomousLog>(DOC, { ticks: [], nextBacklogIndex: 0 });
  if (!Array.isArray(value.ticks)) value.ticks = [];
  if (typeof value.nextBacklogIndex !== "number") value.nextBacklogIndex = 0;
  if (cacheable) cache = value;
  return value;
}
export async function refreshAutonomousFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<AutonomousLog>(DOC);
  if (v && Array.isArray(v.ticks)) cache = v;
}
function persist(log: AutonomousLog): void {
  cache = log;
  saveDoc(DOC, log);
}
function newId(): string {
  return BigInt("0x" + randomBytes(8).toString("hex")).toString(36).slice(0, 11);
}

export function listTicks(limit = 40): AutonomousTick[] {
  const t = load().ticks;
  return t.slice(Math.max(0, t.length - limit)).reverse();
}
export function autonomousStats(): { totalTicks: number; totalSpentUsdc: number; lastTickAt: string | null } {
  const t = load().ticks;
  const spent = t.reduce((s, x) => s + (x.spent || 0), 0);
  return { totalTicks: t.length, totalSpentUsdc: round6(spent), lastTickAt: t.length ? t[t.length - 1].startedAt : null };
}

/** Per-tick ceiling: what one run may spend at most. Override with MERIT_AUTONOMOUS_TICK_USDC. */
const TICK_BUDGET_USDC = Math.max(0.005, Number(process.env.MERIT_AUTONOMOUS_TICK_USDC) || 0.02);
/** Rolling-24h total the loop may spend across all ticks. Override with MERIT_AUTONOMOUS_DAILY_CAP_USDC. */
const DAILY_CAP_USDC = Math.max(TICK_BUDGET_USDC, Number(process.env.MERIT_AUTONOMOUS_DAILY_CAP_USDC) || 0.3);
/** The treasury balance the loop will never spend below. Override with MERIT_AUTONOMOUS_RESERVE_USDC. */
const RESERVE_FLOOR_USDC = Math.max(0, Number(process.env.MERIT_AUTONOMOUS_RESERVE_USDC) || 0.1);

export function spentInLast24h(ticks: AutonomousTick[], now: number): number {
  const cutoff = now - 24 * 3600 * 1000;
  return round6(
    ticks
      .filter((t) => t.outcome === "ok" && new Date(t.startedAt).getTime() >= cutoff)
      .reduce((s, t) => s + (t.spent || 0), 0),
  );
}

/** The safety decision, pure and independent of the network/LLM call it gates — so it's directly
 *  unit-testable without a chain, a treasury, or an agent run. Both caps are checked (never short-
 *  circuited) so a skip always names the real reason, not just the first one that happened to fire. */
export function checkAutonomousCaps(input: {
  treasuryBefore: number;
  ticksSoFar: AutonomousTick[];
  now: number;
  tickBudget?: number;
  dailyCap?: number;
  reserveFloor?: number;
}): { allowed: boolean; reason?: string } {
  const tickBudget = input.tickBudget ?? TICK_BUDGET_USDC;
  const dailyCap = input.dailyCap ?? DAILY_CAP_USDC;
  const reserveFloor = input.reserveFloor ?? RESERVE_FLOOR_USDC;
  // round6 before comparing — a raw float subtraction can land a hair under an exact boundary
  // (0.12 - 0.02 === 0.09999999999999999 in JS) and wrongly block a tick that's actually fine. USDC
  // itself has no precision finer than 1e-6, so rounding to it loses nothing real.
  const spent24h = spentInLast24h(input.ticksSoFar, input.now);
  if (round6(spent24h + tickBudget) > dailyCap) {
    return { allowed: false, reason: `rolling-24h spend $${spent24h} + this tick's $${tickBudget} would exceed the $${dailyCap} daily cap` };
  }
  if (round6(input.treasuryBefore - tickBudget) < reserveFloor) {
    return { allowed: false, reason: `treasury $${input.treasuryBefore} minus this tick's $${tickBudget} would fall below the $${reserveFloor} reserve floor` };
  }
  return { allowed: true };
}

/**
 * Run one autonomous tick: pick the next backlog question, check every safety cap against the REAL
 * treasury balance, and — only if every cap clears — run the agent for real. Always records what
 * happened, including a skip or an error, so the public log is never silently missing a beat.
 */
export async function runAutonomousTick(): Promise<AutonomousTick> {
  const log = load();
  const now = Date.now();
  const idx = log.nextBacklogIndex % AUTONOMOUS_BACKLOG.length;
  const question = AUTONOMOUS_BACKLOG[idx];

  const tick: AutonomousTick = {
    id: newId(),
    backlogIndex: idx,
    question,
    budget: TICK_BUDGET_USDC,
    startedAt: new Date(now).toISOString(),
    treasuryBefore: null,
    treasuryAfter: null,
    spent: null,
    outcome: "skipped",
  };

  const treasuryBefore = await readTreasuryBalance();
  tick.treasuryBefore = treasuryBefore;

  if (treasuryBefore === null) {
    tick.skipReason = "treasury balance unreadable (no BUYER_ADDRESS configured or RPC unavailable)";
    tick.finishedAt = new Date().toISOString();
    log.ticks.push(tick);
    log.nextBacklogIndex = (idx + 1) % AUTONOMOUS_BACKLOG.length;
    if (log.ticks.length > MAX_LOG) log.ticks = log.ticks.slice(-MAX_LOG);
    persist(log);
    return tick;
  }

  const capCheck = checkAutonomousCaps({ treasuryBefore, ticksSoFar: log.ticks, now });
  if (!capCheck.allowed) tick.skipReason = capCheck.reason;

  if (tick.skipReason) {
    tick.finishedAt = new Date().toISOString();
    log.ticks.push(tick);
    log.nextBacklogIndex = (idx + 1) % AUTONOMOUS_BACKLOG.length;
    if (log.ticks.length > MAX_LOG) log.ticks = log.ticks.slice(-MAX_LOG);
    persist(log);
    return tick;
  }

  // Collect the run's own SSE events; the final "summary" event is the signed receipt body — the proof.
  let summary: unknown = null;
  const emit: Emit = (event, data) => {
    if (event === "summary") summary = data;
  };

  try {
    await runAgent(question, TICK_BUDGET_USDC, emit, undefined, { discover: true });
    const totals = (summary as { totals?: { spent?: number } } | null)?.totals;
    tick.outcome = "ok";
    tick.spent = round6(totals?.spent || 0);
    tick.summary = summary;
  } catch (e) {
    tick.outcome = "error";
    tick.error = (e as Error).message.slice(0, 300);
  }

  tick.treasuryAfter = await readTreasuryBalance();
  tick.finishedAt = new Date().toISOString();

  if (tick.treasuryBefore !== null && tick.treasuryAfter !== null) {
    tick.realCostUsdc = round6(tick.treasuryBefore - tick.treasuryAfter);
    // Flagged, not blocked (the money already moved by the time this runs) — a gas-heavy tick (fresh
    // identity mints for several never-before-seen sources/specialists) is real and expected to happen
    // occasionally, not an error. ANOMALY_MULTIPLE over the nominal budget, with a floor so a tiny
    // budget doesn't flag on ordinary gas variance. Override with MERIT_AUTONOMOUS_ANOMALY_USDC.
    const anomalyFloor = Math.max(TICK_BUDGET_USDC * 5, Number(process.env.MERIT_AUTONOMOUS_ANOMALY_USDC) || 0.05);
    tick.costAnomaly = tick.realCostUsdc > anomalyFloor;
  }

  log.ticks.push(tick);
  log.nextBacklogIndex = (idx + 1) % AUTONOMOUS_BACKLOG.length;
  if (log.ticks.length > MAX_LOG) log.ticks = log.ticks.slice(-MAX_LOG);
  persist(log);
  return tick;
}

export const AUTONOMOUS_CAPS = { TICK_BUDGET_USDC, DAILY_CAP_USDC, RESERVE_FLOOR_USDC };
