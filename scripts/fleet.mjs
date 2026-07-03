/**
 * User-fleet dogfood driver — N distinct principals, each running a COMPLETE persona journey end-to-end
 * through the real product (no shortcuts, no direct store writes): onboard → fund (real on-chain USDC
 * deposit) → verify at metered depths → sessions → signed AP2 mandates → webhooks → citation tolls →
 * receipts → disputes → withdraw (real on-chain). Every effect lands through the same code paths a real
 * user hits; every dollar is real test-USDC on Arc. Honest by construction: refused citations pay nothing,
 * over-cap sessions are refused, and the report only counts what the API actually returned.
 *
 *   STUB=0 MERIT_BASE=http://localhost:3011 node --env-file=.env.local scripts/fleet.mjs
 *
 * Pacing: LLM-bound calls share one global limiter (the judge budget is finite); numeric-depth verifies,
 * reads, and CRUD run faster. Writes .data/fleet-report.json when done.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { createWalletClient, createPublicClient, http, encodeFunctionData, getAddress, defineChain } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const BASE = process.env.MERIT_BASE || "http://localhost:3011";
const USDC = "0x3600000000000000000000000000000000000000";
const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const arc = defineChain({
  id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const ERC20 = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * ms * 0.5);
const j = (r) => r.json();
const api = (path, init = {}) => fetch(BASE + path, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const post = (path, body, key) => api(path, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
const get = (path, key) => api(path, { headers: key ? { authorization: `Bearer ${key}` } : {} });
const del = (path, key) => api(path, { method: "DELETE", headers: key ? { authorization: `Bearer ${key}` } : {} });

// One global limiter for LLM-bound calls (full/nli-depth verifies, tolls, mandates, procure): the judge
// budget is shared with everything else running, so pace hard and let the strict gate stay honest.
let llmGate = Promise.resolve();
const LLM_SPACING_MS = Number(process.env.FLEET_LLM_MS || 9000);
function llmSlot() {
  const wait = llmGate.then(() => sleep(jitter(LLM_SPACING_MS)));
  llmGate = wait.catch(() => {});
  return wait;
}

// ---- personas ----------------------------------------------------------------------------------------
const NAMES = [
  "mira", "jonas", "priya", "santiago", "aiko", "lena", "tomas", "zara", "felix", "nadia",
  "oskar", "ines", "ravi", "clara", "mateo", "hana", "viktor", "amara", "diego", "sofia",
  "emil", "leila", "arjun", "greta", "noor", "pavel", "rosa", "kenji", "alba", "yusuf",
];
const R = { profiles: [], deposits: [], withdrawals: [], verifies: { ok: 0, refused: 0, err: 0 }, tolls: { settled: 0, refused: 0, paused: 0 }, sessions: 0, sessionCapHits: 0, mandates: { cleared: 0, refused: 0 }, webhooks: 0, feeds: [], registered: [], disputes: 0, procured: 0, receipts: [], errors: [] };
const DISPUTABLE = []; // { id, source } — receipts whose FULL source we hold, for authoritative disputes
const err = (who, what, detail) => { R.errors.push({ who, what, detail: String(detail).slice(0, 120) }); console.log(`  ! ${who} ${what}: ${String(detail).slice(0, 90)}`); };

// claims that decide DETERMINISTICALLY (numeric verifier, zero LLM) — high-volume-safe either way
const NUMERIC_REFUSE = [
  { claim: "StableData reported $40 trillion in annualized settlement volume in 2026.", source: "The StableData API index shows cross-border B2B stablecoin settlement reached $4.1 trillion in annualized volume in 2026." },
  { claim: "CryptoBuzz says stablecoin volume grew 4,000% last quarter.", source: "CryptoBuzz reported stablecoin volume grew 400% last quarter across major venues." },
  { claim: "The report counts 90 million active wallets in 2026.", source: "The report counts 9 million active wallets in 2026, up from 4 million." },
];
const NUMERIC_OK = [
  { claim: "Cross-border B2B stablecoin settlement reached $4.1 trillion in annualized volume in 2026.", source: "The StableData API index shows cross-border B2B stablecoin settlement reached $4.1 trillion in annualized volume in 2026." },
  { claim: "The index reports 9 million active wallets in 2026.", source: "The report counts 9 million active wallets in 2026, up from 4 million." },
];
// full-depth pairs (NLI + judge; paced through llmSlot)
const FULL_OK = [
  { claim: "The Eiffel Tower is located in Paris.", source: "The Eiffel Tower is a landmark located in Paris, France." },
  { claim: "Water freezes at zero degrees Celsius at standard pressure.", source: "At standard atmospheric pressure, water freezes at 0 °C (32 °F)." },
];
const FULL_REFUSE = [
  { claim: "The Eiffel Tower is located in Berlin.", source: "The Eiffel Tower is a landmark located in Paris, France." },
];
// link-toll claims against the seed sources (the RFB-6 surface)
const TOLL_TARGETS = [
  { handle: "ledgerlens", claim: "Sub-cent nanopayments are the fastest-growing payment primitive of 2026." },
  { handle: "stabledata", claim: "Cross-border B2B stablecoin settlement reached $4.1 trillion in annualized volume in 2026." },
  { handle: "ortiz", claim: "Programmable settlement rails reduce reconciliation cost for B2B payments." },
];
// real public feeds for the publisher persona
const FEEDS = [
  "https://simonwillison.net/atom/everything/",
  "https://blog.cloudflare.com/rss/",
  "https://hnrss.org/frontpage",
  "https://www.schneier.com/feed/atom/",
];

// buyer wallet (funds the on-chain deposits)
const buyer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);
const wallet = createWalletClient({ account: buyer, chain: arc, transport: http(RPC) });
const pub = createPublicClient({ chain: arc, transport: http(RPC) });

// Retry once on a nonce race — the buyer account also signs Gateway deposits from concurrent runs.
async function sendTx(req) {
  try {
    return await wallet.sendTransaction(req);
  } catch (e) {
    if (!/nonce/i.test(String(e))) throw e;
    await sleep(4000);
    return await wallet.sendTransaction(req);
  }
}

async function sendUsdc(to, amount) {
  const hash = await sendTx({
    to: USDC,
    data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [getAddress(to), BigInt(Math.round(amount * 1e6))] }),
  });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error("transfer reverted");
  return hash;
}

// Native gas so the derived deposit address can SIGN its own withdrawal later (Arc gas = native USDC).
async function sendGas(to, amount) {
  const hash = await sendTx({ to: getAddress(to), value: BigInt(Math.round(amount * 1e18)) });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

const TAG = process.env.FLEET_TAG || "r1";
async function onboard(name, role) {
  const r = await post("/api/onboard/wallet", { email: `${name}.${TAG}@fleet.merit.local`, name: `${name} (${role})` });
  if (!r.body?.apiKey) throw new Error(`onboard failed ${r.status}`);
  const p = { name, role, key: r.body.apiKey, principalId: r.body.principal?.id, wallet: r.body.wallet?.address };
  R.profiles.push({ name, role, principalId: p.principalId });
  return p;
}

// ---- journeys ----------------------------------------------------------------------------------------

// funded developer: real deposit → metered verifies (mixed depths) → status → (some) withdraw on-chain
async function devJourney(p, { withdraw }) {
  const bal = await get("/api/balance", p.key);
  const addr = bal.body?.depositTo;
  if (!addr) return err(p.name, "no deposit address", JSON.stringify(bal.body).slice(0, 80));
  const amt = Number(process.env.FLEET_DEPOSIT || 0.22);
  const tx = await sendUsdc(addr, amt);
  if (withdraw) await sendGas(addr, 0.004); // gas so the address can sign its own withdrawal tx later
  R.deposits.push({ who: p.name, tx, amount: amt });
  await sleep(4000);
  const credit = await post("/api/balance", { action: "deposit", txHash: tx }, p.key);
  if (!credit.body?.ok) return err(p.name, "credit failed", credit.body?.error);
  console.log(`  ${p.name} funded $${amt} on-chain (${tx.slice(0, 12)}…)`);

  // numeric depth = the cheap fabrication SCREEN (deterministic, zero model): fabrications must REFUSE.
  for (const c of NUMERIC_REFUSE.slice(0, 2)) {
    const r = await post("/api/verify/balance", { ...c, depth: "numeric" }, p.key);
    if (r.body?.verdict === "REFUSED") R.verifies.refused++; else R.verifies.err++;
    if (r.body?.receiptId) R.receipts.push(r.body.receiptId);
    await sleep(jitter(1500));
  }
  // nli depth = encoder-only positive verdicts (the self-hosted HHEM leg — model-backed, no LLM budget)
  let lastVerifyReceipt = null;
  for (const c of [...FULL_OK, ...NUMERIC_OK].slice(0, 3)) {
    const r = await post("/api/verify/balance", { ...c, depth: "nli" }, p.key);
    if (r.body?.verdict === "SUPPORTED") R.verifies.ok++; else if (r.body?.verdict === "REFUSED") R.verifies.refused++; else R.verifies.err++;
    if (r.body?.receiptId) { R.receipts.push(r.body.receiptId); lastVerifyReceipt = { id: r.body.receiptId, source: c.source }; }
    await sleep(jitter(1800));
  }
  // one full-depth verify (paced on the LLM gate)
  await llmSlot();
  const full = await post("/api/verify/balance", { ...FULL_OK[Math.floor(Math.random() * FULL_OK.length)], depth: "full" }, p.key);
  if (full.body?.verdict === "SUPPORTED") R.verifies.ok++; else if (full.body?.verdict === "REFUSED") R.verifies.refused++; else R.verifies.err++;
  if (lastVerifyReceipt) DISPUTABLE.push(lastVerifyReceipt); // receipts we hold the FULL source for (authoritative dispute)

  await get("/api/balance", p.key); // status read (populated state)
  if (withdraw) {
    const dest = privateKeyToAccount(generatePrivateKey()).address;
    const w = await post("/api/balance", { action: "withdraw", toWallet: dest }, p.key);
    if (w.body?.tx) { R.withdrawals.push({ who: p.name, tx: w.body.tx, amount: w.body.amount }); console.log(`  ${p.name} withdrew $${w.body.amount} on-chain (${w.body.tx.slice(0, 12)}…)`); }
    else err(p.name, "withdraw", w.body?.error);
  }
}

// session team-lead: fund a bit → issue capped session → spend to the cap → revoke
async function sessionJourney(p) {
  const bal = await get("/api/balance", p.key);
  if (bal.body?.depositTo) {
    const tx = await sendUsdc(bal.body.depositTo, 0.1);
    R.deposits.push({ who: p.name, tx, amount: 0.1 });
    await sleep(4000);
    await post("/api/balance", { action: "deposit", txHash: tx }, p.key);
  }
  const s = await post("/api/session", { cap: 0.004, ttlHours: 2, label: `${p.name}-ci` }, p.key);
  if (!s.body?.sessionKey) return err(p.name, "session issue", s.body?.error);
  R.sessions++;
  // spend under the session at nli depth until the cap refuses (letter suffixes — a digit would trip the
  // numeric verifier as a figure absent from the source, which is correct behavior we don't want to trigger)
  const tags = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];
  for (let i = 0; i < 7; i++) {
    const c = FULL_OK[i % FULL_OK.length];
    const r = await post("/api/verify/balance", { claim: c.claim.replace(/\.$/, ` (${tags[i]} check).`), source: c.source, depth: "nli" }, s.body.sessionKey);
    if (r.status === 402 || /session limit|cap/i.test(r.body?.error || "")) { R.sessionCapHits++; console.log(`  ${p.name} session hit its cap (refused honestly)`); break; }
    if (r.body?.verdict) (r.body.verdict === "SUPPORTED" ? R.verifies.ok++ : R.verifies.refused++);
    await sleep(jitter(1600));
  }
  await del(`/api/session?id=${encodeURIComponent(s.body.id || "")}`, p.key);
}

// agent boss: sign an AP2 mandate with its own wallet → settle a verified claim → a refused claim clears nothing
async function mandateJourney(p) {
  const signer = privateKeyToAccount(generatePrivateKey());
  const m = { type: "citation-payment", authorizer: signer.address, maxAmount: 0.02, scope: "citation", expiresAt: Date.now() + 3_600_000, nonce: `${p.name}-${Date.now()}` };
  const msg = JSON.stringify({ type: m.type, authorizer: getAddress(m.authorizer), maxAmount: m.maxAmount, scope: m.scope, expiresAt: m.expiresAt, nonce: m.nonce });
  const signature = await signer.signMessage({ message: msg });
  await llmSlot();
  const ok = await post("/api/mandate/settle", { ...FULL_OK[0], mandate: m, signature, amount: 0.005 });
  if (ok.body?.cleared) R.mandates.cleared++; else err(p.name, "mandate clear", ok.body?.error || ok.body?.chain);
  if (ok.body?.receiptId) R.receipts.push(ok.body.receiptId);
  await llmSlot();
  const bad = await post("/api/mandate/settle", { ...FULL_REFUSE[0], mandate: m, signature, amount: 0.005 });
  if (bad.body?.verified === false && !bad.body?.cleared) R.mandates.refused++;
  if (bad.body?.receiptId) R.receipts.push(bad.body.receiptId);
}

// integrator: register a signed webhook → fire a toll so a delivery goes out → list → (some) remove
async function integratorJourney(p, { remove }) {
  const wh = await post("/api/webhooks", { url: "https://httpbin.org/post" }, p.key);
  if (!wh.body?.id && !wh.body?.url) return err(p.name, "webhook register", wh.body?.error);
  R.webhooks++;
  await llmSlot();
  const t = TOLL_TARGETS[Math.floor(Math.random() * TOLL_TARGETS.length)];
  const toll = await post(`/api/link/${t.handle}`, { claim: t.claim });
  if (toll.body?.verdict === "SUPPORTED" && toll.body?.settled && !toll.body.settled.paused && !toll.body.settled.error) R.tolls.settled++;
  else if (toll.body?.settled?.paused) R.tolls.paused++;
  else if (toll.body?.verdict === "REFUSED") R.tolls.refused++;
  if (toll.body?.id) R.receipts.push(toll.body.id);
  await get("/api/webhooks", p.key);
  if (remove && wh.body?.id) await del(`/api/webhooks?id=${encodeURIComponent(wh.body.id)}`, p.key);
}

// publisher: onboard a real feed (or register directly) → get cited via a toll → check the receipt
async function publisherJourney(p, i) {
  if (i < FEEDS.length) {
    const r = await post("/api/creators/from-feed", { feedUrl: FEEDS[i] });
    if (r.body?.id || r.body?.name) { R.feeds.push({ who: p.name, feed: FEEDS[i], id: r.body.id }); console.log(`  ${p.name} onboarded feed ${FEEDS[i].split("/")[2]}`); }
    else err(p.name, "from-feed", r.body?.error);
  } else {
    const r = await post("/api/creators/register", { name: `${p.name} letter`, url: `https://${p.name}.fleet.merit.local`, price: 0.01, content: `${p.name}'s independent research letter covering programmable settlement, stablecoin rails, and nanopayment economics in 2026. Sub-cent nanopayments are the fastest-growing payment primitive of 2026.` });
    if (r.body?.id) { R.registered.push({ who: p.name, id: r.body.id }); console.log(`  ${p.name} registered as a creator (${r.body.id})`); }
    else err(p.name, "register", r.body?.error);
  }
  await llmSlot();
  const t = TOLL_TARGETS[i % TOLL_TARGETS.length];
  const toll = await post(`/api/link/${t.handle}`, { claim: t.claim });
  if (toll.body?.verdict === "SUPPORTED" && toll.body?.settled && !toll.body.settled.paused && !toll.body.settled.error) R.tolls.settled++;
  else if (toll.body?.settled?.paused) R.tolls.paused++;
  else if (toll.body?.verdict === "REFUSED") R.tolls.refused++;
  if (toll.body?.id) R.receipts.push(toll.body.id);
}

// skeptic: free verifies (fabrications refused with zero LLM) → dispute a receipt → read the audit chain
async function skepticJourney(p) {
  for (const c of NUMERIC_REFUSE) {
    const r = await post("/api/verify", c);
    if (r.body?.verdict === "REFUSED") R.verifies.refused++; else R.verifies.err++;
    await sleep(jitter(1800));
  }
  await llmSlot();
  const probe = await post("/api/verify", FULL_REFUSE[0]);
  if (probe.body?.verdict === "REFUSED") R.verifies.refused++;
  // Authoritative dispute: we hold the FULL source for these receipts, so the re-check is byte-for-byte.
  if (DISPUTABLE.length) {
    const t = DISPUTABLE[Math.floor(Math.random() * DISPUTABLE.length)];
    await llmSlot();
    const d = await post("/api/dispute", { receiptId: t.id, source: t.source });
    if (d.status === 200) { R.disputes++; console.log(`  ${p.name} disputed receipt ${t.id} → ${d.body?.outcome || d.body?.result || "re-verified"}`); }
    else err(p.name, "dispute", d.body?.error);
  }
  await get("/api/audit?verify=1&limit=3");
  await get("/api/proof");
}

// procurer: verified procurement of a real page (LLM-paced)
async function procureJourney(p) {
  await llmSlot();
  const r = await post("/api/procure", { url: "https://en.wikipedia.org/wiki/USD_Coin", claim: "USD Coin is a stablecoin pegged to the United States dollar." }, p.key);
  if (r.body?.verdict) { R.procured++; if (r.body?.receiptId || r.body?.card?.id) R.receipts.push(r.body.receiptId || r.body.card.id); }
  else err(p.name, "procure", r.body?.error);
}

// every profile also reads the public surfaces (views are part of real usage)
async function readerPass() {
  for (const path of ["/api/pricing", "/api/opportunity?claims=12", "/api/honesty", "/api/benchmark", "/api/metrics", "/api/card?limit=6"]) { await get(path); await sleep(400); }
  if (R.receipts.length) await fetch(`${BASE}/v/${R.receipts[R.receipts.length - 1]}`).catch(() => {});
}

// ---- run the fleet -----------------------------------------------------------------------------------
console.log(`\nfleet → ${BASE} · 30 profiles · full end-to-end journeys (paced)\n`);
const t0 = Date.now();

const roles = [
  ...Array(8).fill("developer"),
  ...Array(5).fill("team-lead"),
  ...Array(4).fill("agent-boss"),
  ...Array(5).fill("integrator"),
  ...Array(5).fill("publisher"),
  ...Array(2).fill("skeptic"),
  ...Array(1).fill("procurer"),
];

let devN = 0, intN = 0, pubN = 0;
for (let i = 0; i < roles.length; i++) {
  const role = roles[i];
  const name = NAMES[i % NAMES.length];
  try {
    const p = await onboard(name, role);
    console.log(`\n[${i + 1}/${roles.length}] ${name} · ${role}`);
    if (role === "developer") await devJourney(p, { withdraw: devN++ % (Number(process.env.FLEET_WITHDRAW_EVERY) || 3) === 0 });
    else if (role === "team-lead") await sessionJourney(p);
    else if (role === "agent-boss") await mandateJourney(p);
    else if (role === "integrator") await integratorJourney(p, { remove: intN++ % 2 === 1 });
    else if (role === "publisher") await publisherJourney(p, pubN++);
    else if (role === "skeptic") await skepticJourney(p);
    else if (role === "procurer") await procureJourney(p);
    await readerPass();
  } catch (e) {
    err(name, role, e.message);
  }
  await sleep(jitter(3000));
}

const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`\n── fleet done in ${mins} min ──`);
console.log(`profiles ${R.profiles.length} · deposits ${R.deposits.length} (real tx) · withdrawals ${R.withdrawals.length} (real tx)`);
console.log(`verifies ok/refused/err ${R.verifies.ok}/${R.verifies.refused}/${R.verifies.err} · tolls settled/refused/paused ${R.tolls.settled}/${R.tolls.refused}/${R.tolls.paused}`);
console.log(`sessions ${R.sessions} (cap-hits ${R.sessionCapHits}) · mandates cleared/refused ${R.mandates.cleared}/${R.mandates.refused} · webhooks ${R.webhooks}`);
console.log(`feeds ${R.feeds.length} · registered ${R.registered.length} · disputes ${R.disputes} · procured ${R.procured} · receipts ${R.receipts.length} · errors ${R.errors.length}`);
mkdirSync(".data", { recursive: true });
writeFileSync(".data/fleet-report.json", JSON.stringify({ at: new Date().toISOString(), base: BASE, minutes: Number(mins), ...R }, null, 2));
console.log(`→ wrote .data/fleet-report.json`);
