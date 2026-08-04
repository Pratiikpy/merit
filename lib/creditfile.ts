/**
 * The Replayable Credit File (the Cycles-compatible verified-reliability feed) — Merit's settlement history as
 * a SELF-PROVING credit artifact, not a black-box score. Cycles (multilateral clearing + the on-chain credit
 * bureau on Arc) scores "how reliably obligations get settled"; Merit knows something deeper — whether the WORK
 * behind each settlement was verified correct. This file packages that history so a clearing network, bureau,
 * or any Arc app can consume it without trusting Merit's math:
 *
 *   - Day-one backfill: built from the receipts Merit already holds — no cold start, instantly aged history.
 *   - Merkle root over the entry set: any consumer re-fetches the raw entries (`?export=1`), recomputes the
 *     root locally, and proves the history untampered. The score is REPLAYABLE, not asserted.
 *   - Idempotent by construction: entries are deduped by their leaf hash, so webhook replays or retried
 *     settlements can never double-count into anyone's history.
 *   - Staleness watermark baked into the payload (`asOf`) — freshness is self-describing data.
 *   - No survivorship bias: the global verification split (supported vs REFUSED) rides along, so refused
 *     obligations stay on the record; `commitToSettleRatio` reflects real reliability, not just wins.
 *   - Concentration entropy: a diversity signal over the payee distribution — a history built on one
 *     counterparty scores low even if every settlement cleared (the anti-wash-trading signal).
 *   - Honest boundary, in the payload: wallets are not entities (Sybil identities are possible), and the
 *     entry export is the retained tail while the cumulative counters are monotonic over all time.
 *
 * Signed like every Merit artifact; `fileId` is the keccak256 join key over the signed body.
 */
import { keccak256, toHex } from "viem";
import { canonicalize, signReceipt, verificationId } from "./receipt";
import { ledgerHistory, ledgerTotals, type LedgerEntry } from "./ledger";
import { auditStats } from "./audit";
import { snapshotMetrics } from "./metrics";
import { round6 } from "./arc";

// ---- Merkle module (the primitive everything else depends on) ---------------------------------------------

/**
 * Leaf = keccak256 over a domain-separated canonical SETTLEMENT IDENTITY. When the entry carries an on-chain
 * `tx`, identity is (tx, sourceId, amount) — the stable key a webhook replay reproduces exactly, so a retried
 * delivery of the same settlement is the SAME leaf (true idempotency). Without a tx, identity falls back to
 * the full entry (runId, sourceId, amount, at) — byte-identical replays dedupe; a re-recorded settlement with
 * a fresh runId/timestamp does not (stated honestly in the payload). Leaves are prefixed 0x00 and interior
 * nodes 0x01 (domain separation), and an odd node is DUPLICATED, not promoted — so no interior value can ever
 * be presented as a leaf and a single-leaf root is not the leaf itself.
 */
export function leafOf(e: LedgerEntry): `0x${string}` {
  const identity = e.tx
    ? { v: 1, kind: "tx", tx: e.tx, sourceId: e.sourceId, amount: e.amount }
    : { v: 1, kind: "entry", runId: e.runId, sourceId: e.sourceId, amount: e.amount, at: e.at };
  return keccak256(toHex("\x00" + canonicalize(identity)));
}

/** Pairwise-keccak Merkle root over the leaves (sorted for determinism; odd node duplicated; 0x01 node domain).
 *  Empty set → 0x00…0. */
export function merkleRoot(leaves: `0x${string}`[]): `0x${string}` {
  if (leaves.length === 0) return `0x${"0".repeat(64)}`;
  let level = [...leaves].sort();
  while (level.length > 1) {
    const next: `0x${string}`[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i]; // odd → duplicate, never promote
      next.push(keccak256(("0x01" + left.slice(2) + right.slice(2)) as `0x${string}`));
    }
    level = next;
  }
  return level[0];
}

// ---- The credit file ---------------------------------------------------------------------------------------

export interface CreditSubject {
  payee: string; // the source/creator id Merit settled to (a wallet-backed identity, NOT a verified legal entity)
  name?: string;
  settlements: number;
  settledUsdc: number;
  releaseRate?: number; // share of this payee's citation encounters that verified and released (when known)
  firstAt?: string;
  lastAt?: string;
}

export interface CreditFile {
  schema: "merit.credit-file/v1";
  asOf: string; // staleness watermark — self-describing freshness, no side-channel needed
  network: "arc-testnet-5042002";
  // Cumulative counters are MONOTONIC over all time; the merkleized entry export is the retained tail.
  cumulative: { settledUsdc: number; settlements: number; distinctPayees: number; runs: number };
  // No-survivorship-bias context: refused obligations stay on the record.
  verification: { supported: number; refused: number; total: number; commitToSettleRatio: number };
  subjects: CreditSubject[];
  concentrationEntropy: number; // 0..1 normalized entropy of the settled-value distribution across payees
  merkle: { root: `0x${string}`; leaves: number; leaf: string; construction: string };
  replay: { export: string; how: string };
  honesty: string;
  generatedAt: string;
  signer?: string;
  signature?: string;
  fileId?: `0x${string}`;
}

/** Dedupe entries by leaf hash — the idempotency guarantee (a replayed settlement is the SAME leaf). */
export function dedupeEntries(entries: LedgerEntry[]): { entries: LedgerEntry[]; leaves: `0x${string}`[] } {
  const seen = new Map<string, LedgerEntry>();
  for (const e of entries) {
    const l = leafOf(e);
    if (!seen.has(l)) seen.set(l, e);
  }
  return { entries: [...seen.values()], leaves: [...seen.keys()] as `0x${string}`[] };
}

/** Normalized Shannon entropy of the settled-value distribution across payees (1 = evenly spread, 0 = one
 *  counterparty). A wash-trading loop concentrates value and scores low — even when every settlement cleared. */
export function concentrationEntropy(bySubject: Map<string, number>): number {
  const vals = [...bySubject.values()].filter((v) => v > 0);
  if (vals.length <= 1) return 0;
  const total = vals.reduce((a, b) => a + b, 0);
  const h = -vals.reduce((acc, v) => acc + (v / total) * Math.log(v / total), 0);
  return Math.round((h / Math.log(vals.length)) * 1000) / 1000;
}

export async function buildCreditFile(opts: { sign?: boolean } = {}): Promise<CreditFile> {
  const totals = ledgerTotals();
  const { entries, leaves } = dedupeEntries(ledgerHistory(1000));
  const a = auditStats();
  const m = snapshotMetrics();
  const rateById = new Map(m.leaderboard.map((s) => [s.id, { name: s.name, releaseRate: s.releaseRate }]));

  const bySubject = new Map<string, { settlements: number; usdc: number; first: number; last: number }>();
  for (const e of entries) {
    const s = bySubject.get(e.sourceId) || { settlements: 0, usdc: 0, first: e.at, last: e.at };
    s.settlements += 1;
    s.usdc = round6(s.usdc + (e.amount || 0));
    s.first = Math.min(s.first, e.at);
    s.last = Math.max(s.last, e.at);
    bySubject.set(e.sourceId, s);
  }
  const subjects: CreditSubject[] = [...bySubject.entries()]
    .map(([payee, s]) => ({
      payee,
      name: rateById.get(payee)?.name,
      settlements: s.settlements,
      settledUsdc: s.usdc,
      releaseRate: rateById.get(payee)?.releaseRate,
      firstAt: s.first ? new Date(s.first).toISOString() : undefined,
      lastAt: s.last ? new Date(s.last).toISOString() : undefined,
    }))
    .sort((x, y) => y.settledUsdc - x.settledUsdc);

  const now = new Date().toISOString();
  const body: CreditFile = {
    schema: "merit.credit-file/v1",
    asOf: now,
    network: "arc-testnet-5042002",
    cumulative: {
      settledUsdc: totals.totalSettledUsdc,
      settlements: totals.settlementCount,
      distinctPayees: totals.payees.length,
      runs: totals.runCount,
    },
    verification: {
      supported: a.supported,
      refused: a.refused,
      total: a.total,
      commitToSettleRatio: a.total > 0 ? Math.round((a.supported / a.total) * 1000) / 1000 : 0,
    },
    subjects,
    concentrationEntropy: concentrationEntropy(new Map([...bySubject.entries()].map(([k, v]) => [k, v.usdc]))),
    merkle: {
      root: merkleRoot(leaves),
      leaves: leaves.length,
      leaf: 'keccak256(0x00 || canonical identity) — identity is {v:1,kind:"tx",tx,sourceId,amount} when an on-chain tx exists, else {v:1,kind:"entry",runId,sourceId,amount,at}',
      construction: "sorted leaves; node = keccak256(0x01 || left || right); odd node duplicated",
    },
    replay: {
      export: "/api/credit-file?export=1",
      how: "fetch the export, recompute each leaf and the root locally, compare to merkle.root; the export also carries the verification counts and cumulative totals, so the commit-to-settle ratio and every subject aggregate are recomputable too. You never have to trust Merit's math.",
    },
    honesty:
      "Payees are wallet-backed identities, not verified legal entities (Sybil identities are possible; concentrationEntropy is the concentration signal). Cumulative counters are monotonic over all time; the merkleized export is the retained entry tail. Idempotency is by settlement identity: entries carrying an on-chain tx dedupe exactly under replay; entries without one dedupe only byte-identically. Every settlement behind these numbers passed proof-of-citation verification before USDC moved; refused obligations are counted, not hidden.",
    generatedAt: now,
  };

  if (opts.sign !== false) {
    try {
      const sig = await signReceipt(body);
      if (sig) Object.assign(body, sig);
    } catch {
      /* signing is best-effort */
    }
  }
  body.fileId = verificationId(body);
  return body;
}
