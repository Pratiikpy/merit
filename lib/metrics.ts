/**
 * Live metrics snapshot (W3) — the data the dashboard surfaces AND the machine-tracked Canteen traction push
 * reports. Composes settlement history, the self-improving Auditor's appeal calibration, the principal count,
 * and a per-source earnings leaderboard into one object. Pure aggregation over the durable store.
 */
import { historyStats } from "./history";
import { globalCalibration } from "./learn";
import { listPrincipals } from "./auth";
import { getSources } from "./registry";
import { ledgerTotals } from "./ledger";
import { laborTotals } from "./labor";

export interface MetricsSnapshot {
  sources: number;
  creators: number; // sources with a payable wallet
  principals: number; // onboarded API-key principals
  calibration: ReturnType<typeof globalCalibration>;
  totalSettledUsdc: number; // monotonic cumulative — never falls (Bet 3)
  settlementCount: number;
  distinctPayees: number;
  runCount: number;
  leaderboard: Array<{ id: string; name: string; merit: number; releaseRate: number; earned: number }>;
  // The agent-to-agent x402 labor market — real on-chain settlements, NOT judge-gated (kept distinct from the
  // verified creator totals above so it never inflates them).
  agentLabor: { settlements: number; volumeUsdc: number; distinctAgents: number; distinctSpecialists: number };
}

export function snapshotMetrics(): MetricsSnapshot {
  const sources = getSources();
  const board = sources
    .map((s) => {
      const h = historyStats(s.id);
      return { id: s.id, name: s.name, merit: s.merit, releaseRate: h.releaseRate, earned: h.totalEarned };
    })
    .sort((a, b) => b.earned - a.earned || b.merit - a.merit)
    .slice(0, 10);
  const led = ledgerTotals(); // monotonic cumulative — independent of the capped history tail (Bet 3)
  return {
    sources: sources.length,
    creators: sources.filter((s) => !!s.wallet).length,
    principals: listPrincipals().length,
    calibration: globalCalibration(),
    totalSettledUsdc: led.totalSettledUsdc,
    settlementCount: led.settlementCount,
    distinctPayees: led.payees.length,
    runCount: led.runCount,
    leaderboard: board,
    agentLabor: laborTotals(),
  };
}
