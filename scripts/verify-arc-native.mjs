#!/usr/bin/env node
/**
 * End-to-end proof of Merit's Arc-native settlement layer, against a real Arc testnet with real USDC.
 *
 * Nothing here is simulated. It drives the product's own HTTP routes, moves real (testnet) USDC through the
 * predeployed Memo and Multicall3From contracts, and then re-derives every claim from chain logs. Each step
 * prints PASS or FAIL with the evidence a reader would need to check it independently.
 *
 *   1. batched claim      several custodial balances → ONE Arc transaction, one memo per line
 *   2. memo readback      GET /api/memo?tx=…  every audit check, including sender preservation
 *   3. memo lookup        GET /api/memo?id=…  find the payment by memoId, from chain logs alone
 *   4. single claim       the non-batched path, memoed
 *   5. reconciliation     GET /api/reconcile  ledger→chain and chain→ledger
 *   6. gasless funding    a wallet that has NEVER sent a transaction funds a prepaid balance via EIP-3009
 *
 * Usage:  node scripts/verify-arc-native.mjs [--base http://localhost:3011]
 * Requires: a live (STUB=0) server with BUYER_PRIVATE_KEY / CUSTODY_KEY, MERIT_WALLET_SEED and
 * MERIT_ADMIN_TOKEN, pointed at an ISOLATED store (MERIT_DATA_DIR) so a test never writes the shared ledger.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbiItem,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const args = process.argv.slice(2);
const BASE = (args[args.indexOf("--base") + 1] || "").startsWith("http") ? args[args.indexOf("--base") + 1] : "http://localhost:3011";
const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const USDC = "0x3600000000000000000000000000000000000000";
const CHAIN_ID = 5042002;
const DATA_DIR = process.env.MERIT_DATA_DIR || path.join(process.cwd(), ".data");
// Two real domains that each serve /.well-known/merit.json, so the BATCH path (two balances on one domain)
// and the SINGLE path (one balance on another) can both be driven through the real claim route in one run.
const DOMAIN = process.env.MERIT_TEST_DOMAIN || "onmerit.xyz";
const DOMAIN2 = process.env.MERIT_TEST_DOMAIN2 || "www.onmerit.xyz";
const SEED_ONLY = process.argv.includes("--seed");

const env = Object.fromEntries(
  readFileSync(path.join(process.cwd(), ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const ADMIN = process.env.MERIT_ADMIN_TOKEN || env.MERIT_ADMIN_TOKEN;
const FUNDER_KEY = (process.env.CUSTODY_KEY || process.env.BUYER_PRIVATE_KEY || env.CUSTODY_KEY || env.BUYER_PRIVATE_KEY || "").trim();

const pub = createPublicClient({ transport: http(RPC) });
const results = [];
const ok = (n, d) => { results.push({ n, ok: true, d }); console.log(`  PASS  ${n}\n        ${d}`); };
const bad = (n, d) => { results.push({ n, ok: false, d }); console.log(`  FAIL  ${n}\n        ${d}`); };
const step = (t) => console.log(`\n=== ${t} ===`);

async function api(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 400) }; }
  return { status: res.status, body };
}

const ERC20 = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }];
const BALANCE_OF = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const usdcOf = async (a) => Number(await pub.readContract({ address: USDC, abi: BALANCE_OF, functionName: "balanceOf", args: [a] })) / 1e6;

/** Seed the custody ledger directly. This sets up the PRECONDITION (balances already accrued from earlier
 *  verified citations); the claim path under test is then driven entirely through the real HTTP route. */
function seedCustody(entries) {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, "custody.json");
  const cur = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { entries: {} };
  for (const e of entries) cur.entries[e.id] = e;
  writeFileSync(file, JSON.stringify(cur, null, 2));
  return cur;
}
const vid = (s) => keccak256(toHex(`verification:${s}`));

/** The three balances this run settles. Deterministic ids so --seed and the run agree. */
const STAMP = process.env.ARC_TEST_STAMP || String(Math.floor(Date.now() / 1000));
const seeds = () => {
  const now = new Date().toISOString();
  return {
    A: { id: `arctest:a:${STAMP}`, name: "Arc Test Publisher A", domain: DOMAIN, earned: 0.000004, claimed: 0, lastAt: now, refs: [{ v: vid("a1"), a: 0.000002, at: Date.now() }, { v: vid("a2"), a: 0.000002, at: Date.now() }] },
    B: { id: `arctest:b:${STAMP}`, name: "Arc Test Publisher B", domain: DOMAIN, earned: 0.000003, claimed: 0, lastAt: now, refs: [{ run: "run-arctest", a: 0.000003, at: Date.now() }] },
    C: { id: `arctest:c:${STAMP}`, name: "Arc Test Publisher C", domain: DOMAIN2, earned: 0.000002, claimed: 0, lastAt: now, refs: [{ v: vid("c1"), a: 0.000002, at: Date.now() }] },
  };
};

async function main() {
  if (SEED_ONLY) {
    const sd = seeds();
    seedCustody([sd.A, sd.B, sd.C]);
    console.log(`seeded ${sd.A.id}, ${sd.B.id} (${DOMAIN}) and ${sd.C.id} (${DOMAIN2}) into ${DATA_DIR}`);
    console.log(`ARC_TEST_STAMP=${STAMP}`);
    return;
  }
  console.log(`Merit · Arc-native settlement verification\nbase=${BASE}  rpc=${RPC}  store=${DATA_DIR}\n`);

  const health = await api("/api/health");
  if (health.status !== 200) return bad("server reachable", `GET /api/health → ${health.status}`);
  if (health.body.stub) return bad("server is live", "the server is in STUB mode — this test requires STUB=0 and real keys");
  ok("server is live", `mode=${health.body.mode || "live"} chain=${health.body.chainId || CHAIN_ID}`);

  // The domain must really serve a passport, because the claim route really fetches it.
  const passport = await fetch(`https://${DOMAIN}/.well-known/merit.json`, { redirect: "follow" }).then((r) => r.json()).catch(() => null);
  if (!passport?.wallet) return bad("test domain serves a passport", `https://${DOMAIN}/.well-known/merit.json did not return {wallet}`);
  const PAYEE = passport.wallet;
  ok("test domain serves a passport", `${DOMAIN} → ${PAYEE}`);

  // ---------------------------------------------------------------------------------------------------
  step("1. BATCHED CLAIM — several balances, ONE Arc transaction");
  // ---------------------------------------------------------------------------------------------------
  const { A, B } = seeds();
  const before = await usdcOf(PAYEE);
  const claim = await api("/api/claim", { method: "POST", body: JSON.stringify({ domain: DOMAIN }) });
  if (claim.status !== 200) return bad("POST /api/claim (batch)", `${claim.status} ${JSON.stringify(claim.body).slice(0, 300)}`);
  if (!claim.body.batched) bad("claim used the batch path", `batched=${claim.body.batched} — expected ONE transaction for ${claim.body.claims?.length} creators`);
  else ok("claim used the batch path", `${claim.body.claims.length} creators settled in tx ${claim.body.tx}`);
  const batchTx = claim.body.tx;
  if (!batchTx) return bad("batch produced a transaction", JSON.stringify(claim.body).slice(0, 300));
  if (claim.body.memoed) ok("batch lines carry memos", `memoed=true, ids ${claim.body.claims.map((c) => (c.memoId || "").slice(0, 12)).join(", ")}`);
  else bad("batch lines carry memos", `memoNote=${claim.body.memoNote}`);

  const rc = await pub.getTransactionReceipt({ hash: batchTx });
  const erc20Logs = rc.logs.filter((l) => l.address.toLowerCase() === USDC.toLowerCase());
  if (erc20Logs.length === 2) ok("ONE transaction carried BOTH transfers", `${erc20Logs.length} USDC Transfer logs, gasUsed ${rc.gasUsed}`);
  else bad("ONE transaction carried BOTH transfers", `expected 2 ERC-20 Transfer logs, saw ${erc20Logs.length}`);

  const after = await usdcOf(PAYEE);
  const moved = Math.round((after - before) * 1e6) / 1e6;
  const expected = Math.round((A.earned + B.earned) * 1e6) / 1e6;
  if (Math.abs(moved - expected) < 1e-9) ok("the payee's real USDC balance rose by exactly the claimed amount", `${before} → ${after} (+${moved})`);
  else bad("the payee's real USDC balance rose by exactly the claimed amount", `expected +${expected}, saw +${moved}`);

  // ---------------------------------------------------------------------------------------------------
  step("2. MEMO READBACK — every audit check, from the receipt alone");
  // ---------------------------------------------------------------------------------------------------
  const read = await api(`/api/memo?tx=${batchTx}`);
  if (read.status !== 200) bad("GET /api/memo?tx", `${read.status} ${JSON.stringify(read.body).slice(0, 200)}`);
  else {
    const memos = read.body.memos || [];
    if (memos.length === 2) ok("both memos are on chain", `memoIndexes ${memos.map((m) => m.memoIndex).join(", ")}`);
    else bad("both memos are on chain", `expected 2 memos, saw ${memos.length}`);
    for (const m of memos) {
      const failed = (m.audit?.checks || []).filter((c) => !c.ok);
      if (m.audit?.ok) ok(`memo ${String(m.memoId).slice(0, 12)}… audits clean`, `kind=${m.payload?.kind} id=${m.payload?.id} usdc=${m.payload?.usdc} n=${m.payload?.n}`);
      else bad(`memo ${String(m.memoId).slice(0, 12)}… audits clean`, failed.map((c) => `${c.name}: ${c.detail}`).join(" | "));
    }
    const senders = new Set((read.body.transfers?.erc20 || []).map((t) => t.from.toLowerCase()));
    const custodyWallet = (env.CUSTODY_ADDRESS || env.BUYER_ADDRESS || "").toLowerCase();
    if (senders.size === 1 && custodyWallet && senders.has(custodyWallet)) {
      ok("sender preservation held through TWO wrappers", `Transfer.from = ${[...senders][0]} (the EOA), not Multicall3From or Memo`);
    } else {
      bad("sender preservation held through TWO wrappers", `Transfer.from = ${[...senders].join(", ")}, expected the custodial EOA ${custodyWallet}`);
    }
    const sys = read.body.transfers?.system || [];
    const erc = read.body.transfers?.erc20 || [];
    const agree = erc.length === sys.length && erc.every((e, i) => BigInt(sys[i].wei) === BigInt(e.atomic) * BigInt(1e12));
    if (agree) ok("both Arc USDC emitters tell the same story", `${erc.length} × (6dp ERC-20, 18dp EIP-7708 system)`);
    else bad("both Arc USDC emitters tell the same story", `erc20=${JSON.stringify(erc)} system=${JSON.stringify(sys)}`);

    // The verificationIds we seeded must actually be published on chain.
    const published = memos.flatMap((m) => m.payload?.vids || []);
    const wantVid = vid("a1");
    if (published.includes(wantVid)) ok("the memo publishes the verificationIds behind the money", `${wantVid.slice(0, 14)}… found in memoData`);
    else bad("the memo publishes the verificationIds behind the money", `published=${JSON.stringify(published).slice(0, 200)}`);
    if (published.some((v) => v.startsWith("run:"))) ok("a run-derived accrual is labelled as such", published.find((v) => v.startsWith("run:")));
    else bad("a run-derived accrual is labelled as such", `published=${JSON.stringify(published).slice(0, 200)}`);
  }

  // ---------------------------------------------------------------------------------------------------
  step("3. MEMO LOOKUP — find the payment by memoId, with no Merit records involved");
  // ---------------------------------------------------------------------------------------------------
  const lookupId = (claim.body.claims || []).map((c) => c.memoId).find(Boolean);
  if (!lookupId) bad("a memoId to look up", "the claim returned no memoId");
  else {
    const found = await api(`/api/memo?id=${lookupId}&blocks=10000`);
    const hit = (found.body.memos || []).find((m) => (m.tx || "").toLowerCase() === batchTx.toLowerCase());
    if (hit) ok("the payment is findable by memoId from chain logs", `memoId ${lookupId.slice(0, 14)}… → tx ${hit.tx.slice(0, 14)}… (window ${found.body.window?.blocks} blocks)`);
    else bad("the payment is findable by memoId from chain logs", `${found.status} count=${found.body.count} window=${JSON.stringify(found.body.window)}`);
  }

  // ---------------------------------------------------------------------------------------------------
  step("4. SINGLE CLAIM — the non-batched path is memoed too");
  // ---------------------------------------------------------------------------------------------------
  const single = await api("/api/claim", { method: "POST", body: JSON.stringify({ domain: DOMAIN2 }) });
  const line = (single.body.claims || [])[0];
  if (single.status === 200 && line?.ok && single.body.batched === false) ok("single-creator claim takes the direct path", `tx ${line.tx}`);
  else bad("single-creator claim takes the direct path", `${single.status} batched=${single.body.batched} ${JSON.stringify(single.body).slice(0, 250)}`);
  if (line?.memoed) {
    const sread = await api(`/api/memo?tx=${line.tx}`);
    const m = (sread.body.memos || [])[0];
    if (m?.audit?.ok) ok("the single payout's memo audits clean", `${m.payload?.id} · ${m.payload?.usdc} USDC · ${m.payload?.n} ref(s)`);
    else bad("the single payout's memo audits clean", JSON.stringify(m?.audit?.checks?.filter((c) => !c.ok)).slice(0, 300));
  } else bad("the single payout is memoed", `memoNote=${line?.memoNote}`);

  // ---------------------------------------------------------------------------------------------------
  step("5. RECONCILIATION — the ledger, checked against Arc");
  // ---------------------------------------------------------------------------------------------------
  const rec = await api("/api/reconcile?limit=25&blocks=20000");
  if (rec.status !== 200) bad("GET /api/reconcile", `${rec.status} ${JSON.stringify(rec.body).slice(0, 250)}`);
  else {
    const l2c = rec.body.ledgerToChain;
    const ours = (l2c.rows || []).filter((r) => [batchTx, line?.tx].includes(r.tx));
    if (ours.length && ours.every((r) => r.status === "match")) ok("every payout we just made reconciles against chain", ours.map((r) => `${r.id} $${r.claimedUsdc}=${r.onchainUsdc}`).join(" · "));
    else bad("every payout we just made reconciles against chain", JSON.stringify(ours).slice(0, 400));
    if (ours.every((r) => r.emittersAgree)) ok("the 18-decimal system log independently confirms each row", `${ours.length} rows cross-checked`);
    else bad("the 18-decimal system log independently confirms each row", JSON.stringify(ours.map((r) => [r.id, r.emittersAgree])));
    if (l2c.failed === 0) ok("no published row is contradicted by the chain", `${l2c.matched} matched / ${l2c.rowsChecked} checked (${l2c.unreadable} non-tx rows counted separately)`);
    else bad("no published row is contradicted by the chain", `${l2c.failed} failing rows`);

    const c2l = rec.body.chainToLedger;
    if (!c2l) bad("outflow scan ran", rec.body.outflowError || "no scan result");
    else {
      const ourTxs = new Set([batchTx?.toLowerCase(), line?.tx?.toLowerCase()].filter(Boolean));
      const unexplainedOurs = (c2l.unexplainedTransfers || []).filter((t) => ourTxs.has(t.tx.toLowerCase()));
      if (unexplainedOurs.length === 0) ok("our payouts are all explained by published rows", `window ${c2l.window.blocks} blocks (~${c2l.window.approxHours}h), ${c2l.transfersSeen} outbound transfers seen, ${c2l.unexplained} unexplained overall`);
      else bad("our payouts are all explained by published rows", JSON.stringify(unexplainedOurs).slice(0, 300));
    }
  }

  // ---------------------------------------------------------------------------------------------------
  step("6. GASLESS FUNDING — a wallet that has never sent a transaction funds a balance");
  // ---------------------------------------------------------------------------------------------------
  if (!ADMIN) bad("admin token available to mint a test API key", "MERIT_ADMIN_TOKEN is not set");
  else if (!FUNDER_KEY) bad("a funded wallet to seed the payer", "no CUSTODY_KEY / BUYER_PRIVATE_KEY");
  else {
    const mk = await api("/api/admin/keys", { method: "POST", headers: { "x-admin-token": ADMIN }, body: JSON.stringify({ name: `arc-native-test-${Date.now()}` }) });
    const apiKey = mk.body.key;
    if (!apiKey) return bad("mint a test API key", `${mk.status} ${JSON.stringify(mk.body).slice(0, 200)}`);
    ok("mint a test API key", `principal ${mk.body.principal?.id}`);

    const info = await api("/api/relay", { headers: { authorization: `Bearer ${apiKey}` } });
    if (info.status !== 200) return bad("GET /api/relay", `${info.status} ${JSON.stringify(info.body).slice(0, 200)}`);
    if (info.body.eip712?.domainSeparator?.matches) ok("the domain we publish is the one the token enforces", `${info.body.eip712.domainSeparator.onchain}`);
    else bad("the domain we publish is the one the token enforces", JSON.stringify(info.body.eip712?.domainSeparator));
    const depositTo = info.body.depositTo;
    if (!depositTo) return bad("a deposit address to fund", "depositsEnabled=false (MERIT_WALLET_SEED unset?)");

    // A brand-new payer. It will sign, never send — the whole point.
    const payerKey = generatePrivateKey();
    const payer = privateKeyToAccount(payerKey);
    const funder = privateKeyToAccount(FUNDER_KEY.startsWith("0x") ? FUNDER_KEY : `0x${FUNDER_KEY}`);
    const funderWallet = createWalletClient({ account: funder, transport: http(RPC) });
    const seedAmount = BigInt(30); // 0.00003 USDC — enough that the transfer is not a full drain
    const fundTx = await funderWallet.sendTransaction({ to: USDC, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [payer.address, seedAmount] }), chain: null });
    await pub.waitForTransactionReceipt({ hash: fundTx });
    ok("seeded a brand-new payer wallet", `${payer.address} ← ${Number(seedAmount) / 1e6} USDC (tx ${fundTx.slice(0, 14)}…)`);

    const nonce = keccak256(toHex(`merit-relay-test-${Date.now()}-${Math.random()}`));
    const value = BigInt(10); // 0.00001 USDC
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const signature = await payer.signTypedData({
      domain: { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization",
      message: { from: payer.address, to: depositTo, value, validAfter: BigInt(0), validBefore, nonce },
    });

    const payerTxsBefore = await pub.getTransactionCount({ address: payer.address });
    const relay = await api("/api/relay", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from: payer.address, to: depositTo, value: value.toString(), validAfter: "0", validBefore: validBefore.toString(), nonce, signature }),
    });
    if (relay.status !== 200) bad("POST /api/relay", `${relay.status} ${JSON.stringify(relay.body).slice(0, 300)}`);
    else {
      ok("the authorization was relayed on-chain", `tx ${relay.body.tx} · moved ${relay.body.usdc} USDC · relayer paid ${relay.body.gasPaidUsdc} USDC of gas (${relay.body.gasUsed} gas)`);
      const payerTxsAfter = await pub.getTransactionCount({ address: payer.address });
      if (payerTxsBefore === 0 && payerTxsAfter === 0) ok("the payer NEVER sent a transaction", `nonce stayed 0 across the transfer — it held no gas and needed none`);
      else bad("the payer NEVER sent a transaction", `nonce ${payerTxsBefore} → ${payerTxsAfter}`);
      if (relay.body.credited?.credited === Number(value) / 1e6) ok("the relayed transfer was credited as prepaid balance", `+$${relay.body.credited.credited}, available $${relay.body.balance?.available}`);
      else bad("the relayed transfer was credited as prepaid balance", `${JSON.stringify(relay.body.credited)} note=${relay.body.creditNote}`);

      // Replay protection: the same authorization must never settle twice.
      const replay = await api("/api/relay", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ from: payer.address, to: depositTo, value: value.toString(), validAfter: "0", validBefore: validBefore.toString(), nonce, signature }),
      });
      if (replay.status === 409) ok("a replayed authorization is refused", replay.body.error);
      else bad("a replayed authorization is refused", `${replay.status} ${JSON.stringify(replay.body).slice(0, 200)}`);

      // A REDIRECTED authorization must not verify. Same signer, same affordable amount, fresh nonce — the only
      // change is the recipient, so nothing but the signature itself can reject it. That is the point: this must
      // fail on cryptography, not on a balance check that would have caught it anyway.
      const attacker = privateKeyToAccount(generatePrivateKey()).address;
      const redirected = await api("/api/relay", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ from: payer.address, to: attacker, value: value.toString(), validAfter: "0", validBefore: validBefore.toString(), nonce: keccak256(toHex(`t-${Date.now()}`)), signature }),
      });
      if (redirected.status >= 400 && /revert/i.test(redirected.body.error || "")) {
        ok("an authorization redirected to another payee is refused on the signature alone", `${redirected.status} — ${redirected.body.error}`);
      } else {
        bad("an authorization redirected to another payee is refused on the signature alone", `${redirected.status} ${JSON.stringify(redirected.body).slice(0, 250)}`);
      }

      // And an over-value tamper is caught before any gas is spent.
      const tampered = await api("/api/relay", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ from: payer.address, to: depositTo, value: "999999", validAfter: "0", validBefore: validBefore.toString(), nonce: keccak256(toHex(`t2-${Date.now()}`)), signature }),
      });
      if (tampered.status >= 400) ok("a tampered amount is refused before any gas is spent", `${tampered.status} — ${tampered.body.error}`);
      else bad("a tampered amount is refused before any gas is spent", JSON.stringify(tampered.body).slice(0, 200));

      // An expired authorization is refused against the CHAIN's clock, not the server's.
      const expired = await api("/api/relay", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ from: payer.address, to: depositTo, value: "1", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) - 60), nonce: keccak256(toHex(`t3-${Date.now()}`)), signature }),
      });
      if (expired.status === 400 && /expired/i.test(expired.body.error || "")) ok("an expired authorization is refused", expired.body.error);
      else bad("an expired authorization is refused", `${expired.status} ${JSON.stringify(expired.body).slice(0, 200)}`);
    }
  }

  step("SUMMARY");
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed}/${results.length} checks passed`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.n} — ${r.d}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(1);
});
