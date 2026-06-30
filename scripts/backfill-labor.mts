// One-shot: populate the agent-labor counter from the multi-pay settlements file, so the already-settled
// x402 volume shows on /api/metrics (and mirrors to Supabase). Idempotent — recompute + overwrite.
import { readFileSync } from "node:fs";
import { setLaborLedger } from "../lib/labor.ts";
type S = { payer?: string; specialist?: string; amount?: number };
const { settlements } = JSON.parse(readFileSync(".data/settlements.json", "utf8")) as { settlements: S[] };
const payers = [...new Set(settlements.map((s) => String(s.payer || "").toLowerCase()))].filter(Boolean);
const specialists = [...new Set(settlements.map((s) => s.specialist))].filter(Boolean) as string[];
const volumeUsdc = Math.round(settlements.reduce((a, s) => a + (s.amount || 0), 0) * 1e6) / 1e6;
setLaborLedger({ settlements: settlements.length, volumeUsdc, payers, specialists, lastAt: Date.now() });
console.log(`backfilled agentlabor → ${settlements.length} settlements · ${payers.length} distinct agents · $${volumeUsdc}`);
await new Promise((r) => setTimeout(r, 4000)); // let the Supabase mirror flush
