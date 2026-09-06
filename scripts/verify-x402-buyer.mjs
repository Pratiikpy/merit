#!/usr/bin/env node
/**
 * Prove that a BUYER — not Merit's own code path — can discover, pay and consume Merit's metered oracle over
 * x402 on Arc, with real USDC.
 *
 * This is the claim the Agentic Economy track actually cares about, so it is checked the way an outside agent
 * would experience it, in three separate steps:
 *
 *   1. DISCOVER  — read the 402 challenge with a plain `fetch`, and parse the payment requirements out of the
 *                  RESPONSE BODY. This is the step that used to be impossible: Merit sent the requirements
 *                  only in the base64 `PAYMENT-REQUIRED` header and an empty `{}` body, so Circle's batching
 *                  client (which reads the header) worked while every generic x402 client got nothing to pay
 *                  with. Reading the body here is the regression test for that fix, against the live site.
 *   2. PAY       — settle the toll through Circle Gateway batched nanopayments (@circle-fin/x402-batching),
 *                  the same rail an Agent Stack agent uses.
 *   3. CONSUME   — assert the paid response is a real signed verdict, and that its numbers agree with what the
 *                  402 quoted. A 200 is not a pass; the deliverable has to be the thing that was sold.
 *
 * The payer must NOT be the payee. Circle's facilitator rejects a self-transfer, so paying Merit's own CVO
 * from Merit's own buyer wallet fails with `self_transfer` — correctly. This script therefore pays from an
 * independent wallet (X402_BUYER_KEY, defaulting to OPERATOR_PRIVATE_KEY), which is also the more honest test:
 * an outside agent, not Merit paying itself.
 *
 * Usage:  node scripts/verify-x402-buyer.mjs [--base https://www.onmerit.xyz]
 * Needs:  X402_BUYER_KEY (or OPERATOR_PRIVATE_KEY) holding Arc USDC — it deposits into Gateway on demand.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";

const argv = process.argv.slice(2);
const at = argv.indexOf("--base");
const BASE = at >= 0 && argv[at + 1] ? argv[at + 1].replace(/\/$/, "") : "https://www.onmerit.xyz";
const ENDPOINT = `${BASE}/api/verify/paid`;

// A claim whose source genuinely supports it, so a SUPPORTED verdict is the correct outcome and the run
// exercises the paid path rather than the refusal path.
const CLAIM = "At sea level, water boils at 100 degrees Celsius.";
const SOURCE = "Water boils at 100 degrees Celsius (212 degrees Fahrenheit) at standard atmospheric pressure at sea level.";

const env = Object.fromEntries(
  readFileSync(path.join(process.cwd(), ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const results = [];
const ok = (n, d) => { results.push(true); console.log(`  PASS  ${n}\n        ${d}`); };
const bad = (n, d) => { results.push(false); console.log(`  FAIL  ${n}\n        ${d}`); };
const step = (t) => console.log(`\n=== ${t} ===`);

async function main() {
  console.log(`Merit · x402 buyer verification\nendpoint=${ENDPOINT}\n`);

  // ---------------------------------------------------------------------------------------------------
  step("1. DISCOVER — read the toll the way a generic x402 client does");
  // ---------------------------------------------------------------------------------------------------
  const challenge = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ claim: CLAIM, source: SOURCE }),
  });
  if (challenge.status !== 402) return bad("unpaid request is challenged", `expected 402, got ${challenge.status}`);
  ok("unpaid request is challenged", "HTTP 402 Payment Required");

  const body = await challenge.json().catch(() => null);
  if (!body || !Array.isArray(body.accepts) || body.accepts.length === 0) {
    return bad("the 402 BODY carries the payment requirements", `body was ${JSON.stringify(body)} — a generic x402 client has nothing to pay with`);
  }
  const quoted = body.accepts[0];
  ok("the 402 BODY carries the payment requirements", `x402Version ${body.x402Version} · ${body.accepts.length} scheme(s) · error "${body.error}"`);
  ok(
    "the quote names price, asset, network and payee",
    `${Number(quoted.amount) / 1e6} USDC · ${quoted.asset} on ${quoted.network} → ${quoted.payTo}`,
  );

  const header = challenge.headers.get("payment-required");
  if (!header) bad("the PAYMENT-REQUIRED header is still present for Circle's client", "header missing — this would break Merit's own buyer");
  else {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    const same = JSON.stringify(decoded.accepts) === JSON.stringify(body.accepts);
    same
      ? ok("body and header agree", "a client reading either one is quoted the same terms")
      : bad("body and header agree", `header ${JSON.stringify(decoded.accepts)} vs body ${JSON.stringify(body.accepts)}`);
  }

  // ---------------------------------------------------------------------------------------------------
  step("2. PAY — settle the toll over Circle Gateway nanopayments");
  // ---------------------------------------------------------------------------------------------------
  const pk = (process.env.X402_BUYER_KEY || env.X402_BUYER_KEY || env.OPERATOR_PRIVATE_KEY || "").trim();
  if (!pk) return bad("an independent buyer wallet", "set X402_BUYER_KEY (or OPERATOR_PRIVATE_KEY) — a wallet that is NOT the toll's payee");
  const buyer = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  // Circle's facilitator rejects a transfer to yourself, so a buyer that is also the payee cannot test this
  // path. Say so up front rather than surfacing it as an opaque "verify failed" from the settlement.
  if (buyer.address.toLowerCase() === String(quoted.payTo).toLowerCase()) {
    return bad(
      "the buyer is independent of the payee",
      `buyer ${buyer.address} IS the payee — Circle rejects that as a self_transfer. Set X402_BUYER_KEY to a different funded wallet.`,
    );
  }
  ok("the buyer is independent of the payee", `paying as ${buyer.address} → ${quoted.payTo}`);
  const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: pk.startsWith("0x") ? pk : `0x${pk}`, rpcUrl: env.ARC_RPC_URL });

  const priceUsdc = Number(quoted.amount) / 1e6;
  let avail = Number((await gateway.getBalances()).gateway.available) / 1e6;
  ok("buyer Gateway balance read", `${avail} USDC available`);
  if (avail < priceUsdc) {
    console.log(`  …depositing into Gateway to cover ${priceUsdc} USDC`);
    await gateway.deposit("1");
    for (let i = 0; i < 30 && avail < priceUsdc; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      avail = Number((await gateway.getBalances()).gateway.available) / 1e6;
    }
    if (avail < priceUsdc) return bad("Gateway balance covers the toll", `still ${avail} USDC after depositing`);
    ok("deposited into Gateway", `${avail} USDC available`);
  }

  let paid;
  try {
    paid = await gateway.pay(ENDPOINT, { method: "POST", body: JSON.stringify({ claim: CLAIM, source: SOURCE }), headers: { "content-type": "application/json" } });
  } catch (e) {
    return bad("the buyer settles the toll", `${(e && e.message) || e}`);
  }
  if (!paid.transaction) return bad("the buyer settles the toll", "settlement returned no transfer id");
  const settled = Number(paid.formattedAmount || 0);
  ok("the buyer settles the toll", `transfer ${String(paid.transaction).slice(0, 22)}… · ${settled} USDC`);
  Math.abs(settled - priceUsdc) < 1e-9
    ? ok("charged exactly what was quoted", `quoted ${priceUsdc}, settled ${settled}`)
    : bad("charged exactly what was quoted", `quoted ${priceUsdc}, settled ${settled}`);

  // ---------------------------------------------------------------------------------------------------
  step("3. CONSUME — the deliverable has to be the thing that was sold");
  // ---------------------------------------------------------------------------------------------------
  const data = paid.data;
  if (!data || typeof data !== "object") return bad("a verdict came back", `payload was ${typeof data}`);
  ["verdict", "verificationId", "signature", "signer"].every((k) => k in data)
    ? ok("the payload is a signed verdict", `${data.verdict} · verificationId ${String(data.verificationId).slice(0, 14)}… · signed by ${data.signer}`)
    : bad("the payload is a signed verdict", `missing fields; got ${Object.keys(data).join(", ")}`);
  data.paid === true ? ok("the response is marked paid", "paid:true") : bad("the response is marked paid", `paid=${data.paid}`);
  data.receiptUrl
    ? ok("a permalinked receipt was minted inline", data.receiptUrl)
    : bad("a permalinked receipt was minted inline", "no receiptUrl");
  // The point of the whole product: the verdict is the settlement switch, and it is stated either way.
  typeof data.settlement === "string" && /GROUNDED/.test(data.settlement)
    ? ok("the verdict states whether a payment may settle on it", data.settlement)
    : bad("the verdict states whether a payment may settle on it", `settlement=${data.settlement}`);

  step("SUMMARY");
  const passed = results.filter(Boolean).length;
  console.log(`${passed}/${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(1);
});
