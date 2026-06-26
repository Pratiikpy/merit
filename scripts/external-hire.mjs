/**
 * External agent — a SEPARATE process that hires a Merit specialist over x402.
 *
 * Proves the open market: any external agent (not just Merit's in-process lead) can
 * discover a specialist's priced x402 service and pay it directly — a real USDC
 * settlement to the specialist's OWN wallet. The 402 challenge advertises the price +
 * payTo; this script reads it and completes the payment with its own Gateway client.
 *
 * (It funds from the BUYER wallet, since that's what holds a Gateway deposit on this
 * testnet — in production this is simply a different funded agent. The FLOW is what's
 * real: discover → pay → settle, across a process boundary.)
 *
 *   Run:  node --env-file=.env.local scripts/external-hire.mjs [specialistId]
 *         MERIT_BASE=https://your-host node --env-file=.env.local scripts/external-hire.mjs scribe
 */
import { GatewayClient } from "@circle-fin/x402-batching/client";

const BASE = process.env.MERIT_BASE || "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 0) BROWSE — read the public marketplace directory (the labor supply side).
const dir = await fetch(`${BASE}/api/agents`)
  .then((r) => r.json())
  .catch(() => null);
if (dir?.agents?.length) {
  console.log(`\nMerit agent market — ${dir.count} hireable specialists:`);
  for (const a of dir.agents) {
    // Show the capability — the real differentiator a buyer weighs (e.g. the Auditor's LLM judge
    // vs Tally's similarity-only), not just price/tier.
    console.log(
      `  ${a.name.padEnd(9)} ${a.role.padEnd(7)} $${a.price}/job   merit ${String(a.merit).padStart(3)}   ${String(a.tier).padEnd(6)} ${a.capability || ""}`,
    );
  }
}
// Pick a specialist: an explicit id, else the highest-reputation agent — what a
// rational external buyer hires, since reputation gates the market.
const id =
  process.argv[2] ||
  (dir?.agents?.length ? [...dir.agents].sort((x, y) => y.merit - x.merit)[0].id : "scout");
const PAY = `${BASE}/api/agent/${id}/pay`;

// 1) DISCOVER — read the chosen specialist's x402 payment challenge (no payment yet).
const probe = await fetch(PAY);
if (probe.status !== 402) {
  console.error(`Expected a 402 x402 challenge from ${PAY}, got HTTP ${probe.status}. Is the server live (STUB=0)?`);
  process.exit(1);
}
const hdr = probe.headers.get("payment-required");
if (!hdr) {
  console.error("No payment-required challenge header — endpoint is not a valid x402 service.");
  process.exit(1);
}
const challenge = JSON.parse(Buffer.from(hdr, "base64").toString("utf-8"));
const accept = challenge.accepts?.[0];
const priceUsdc = Number(accept?.amount || 0) / 1e6;
console.log(`\nExternal agent → discovered Merit specialist "${id}" over x402:`);
console.log(`  "${challenge.resource?.description || ""}"`);
console.log(`  price ${priceUsdc} USDC  ·  payTo ${accept?.payTo}  ·  ${accept?.network}\n`);

// 2) PAY — settle the x402 payment to the specialist's own wallet.
const pk = process.env.BUYER_PRIVATE_KEY;
if (!pk) {
  console.error("Set BUYER_PRIVATE_KEY (the external agent's funded wallet) and STUB=0.");
  process.exit(1);
}
const g = new GatewayClient({ chain: "arcTestnet", privateKey: pk, rpcUrl: process.env.ARC_RPC_URL });

let avail = Number((await g.getBalances()).gateway.available) / 1e6;
console.log(`  external agent Gateway balance: ${avail} USDC`);
if (avail < priceUsdc) {
  console.log(`  depositing 1 USDC into Gateway…`);
  await g.deposit("1");
  for (let i = 0; i < 30 && avail < priceUsdc; i++) {
    await sleep(2000);
    avail = Number((await g.getBalances()).gateway.available) / 1e6;
  }
  if (avail < priceUsdc) {
    console.error(`  deposit did not register (available=${avail}).`);
    process.exit(1);
  }
}

console.log(`  paying ${id}…`);
const r = await g.pay(PAY, { method: "GET" });
if (!r.transaction) {
  console.error("  payment returned no transfer id — settlement failed.");
  process.exit(1);
}
const isTx = String(r.transaction).startsWith("0x");
console.log(`\n  ✓ SETTLED — the external agent paid ${r.formattedAmount || priceUsdc + " USDC"} to ${id}'s wallet`);
console.log(
  `  ${r.transaction}${isTx ? `  →  https://testnet.arcscan.app/tx/${r.transaction}` : "  (Gateway batch transfer-id; on-chain once the batch lands)"}`,
);
console.log(`\n  A separate process just hired + paid a Merit specialist over x402. The market is open.\n`);
