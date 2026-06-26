/**
 * Prove the moat (be-the-best) — one command that demonstrates proof-of-citation gating settlement ON-CHAIN.
 *
 * Runs a VERIFIED question (citations pass → ERC-8183 escrow RELEASED) and an OFF-TOPIC one (citations fail →
 * the hook REVERTS complete() → refund) against a live Merit, and confirms the gate fired BOTH ways. The
 * canonical claim, reproducible in one command. Requires the server started with MERIT_HOOK_ONCHAIN=1 + a
 * funded STUB=0 wallet (else the hook-settlement is a no-op and this reports it honestly).
 *   MERIT_BASE=http://localhost:3013 node scripts/prove-moat.mjs
 * Exits non-zero if the gate does not enforce (a verified run must release; a failed one must revert).
 */
const BASE = process.env.MERIT_BASE || "http://localhost:3000";

function parseSSE(text) {
  const out = [];
  for (const frame of text.split("\n\n")) {
    let type = null,
      data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (type && data) {
      try {
        out.push({ type, data: JSON.parse(data) });
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

async function run(question) {
  const res = await fetch(`${BASE}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, budget: 0.3 }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const ev = parseSSE(await res.text());
  return {
    summary: ev.find((e) => e.type === "summary")?.data,
    hook: ev.find((e) => e.type === "hook-settlement")?.data,
  };
}

const fail = (m) => {
  console.error(`\n  ✗ ${m}\n`);
  process.exit(1);
};

console.log(`\nProve the moat → ${BASE}  (proof-of-citation gating ERC-8183 settlement on-chain)\n`);

console.log("[1] VERIFIED question — expect the escrow to RELEASE");
const a = await run("What is driving stablecoin payment adoption in 2026?").catch((e) => ({ error: e.message }));
if (a.error) fail(`run failed: ${a.error}`);
const aReleased = a.summary?.totals?.releasedCount ?? 0;
console.log(`    settled $${a.summary?.totals?.released ?? 0} to ${aReleased} creators`);
if (!a.hook) fail("no hook-settlement event — start the server with MERIT_HOOK_ONCHAIN=1 + a funded STUB=0 wallet");
console.log(`    hook → ${a.hook.outcome}  (job ${a.hook.jobId}):  ${(a.hook.txs || []).map((t) => t.step).join(" → ")}`);
if (a.hook.outcome !== "released") fail(`a verified run did NOT release the escrow (got "${a.hook.outcome}")`);

await new Promise((r) => setTimeout(r, 9000)); // respect the run cooldown

console.log("\n[2] OFF-TOPIC question — expect the hook to REVERT complete()");
const b = await run("What is the capital of France and its population?").catch((e) => ({ error: e.message }));
if (b.error) fail(`run failed: ${b.error}`);
console.log(`    settled $${b.summary?.totals?.released ?? 0} to ${b.summary?.totals?.releasedCount ?? 0} creators (proof-of-citation refused the rest)`);
if (!b.hook) fail("no hook-settlement event on the off-topic run");
console.log(`    hook → ${b.hook.outcome}  (job ${b.hook.jobId}):  ${(b.hook.txs || []).map((t) => t.step).join(" → ")}`);
if (!/revert/i.test(b.hook.outcome)) fail(`a failed citation did NOT revert the release (got "${b.hook.outcome}")`);

console.log(`\n  ✓ The moat is enforced ON-CHAIN: a verified citation releases the escrow (job ${a.hook.jobId}),`);
console.log(`    a failed one reverts complete() and refunds (job ${b.hook.jobId}). Verify: jobs(id) + verdictOf(host,id).\n`);
process.exit(0);
