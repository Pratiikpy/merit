/**
 * Pre-deploy preflight — verifies the LIVE config before you deploy: env present,
 * each private key derives to its declared address, the wallets are funded for gas
 * and payments, and the LLM key actually works. Catches the config mistakes that
 * otherwise cause a silent failed deploy. Read-only — no funds move.
 *   Run:  node --env-file=.env.local scripts/preflight.mjs
 * Exits non-zero if any CRITICAL check fails.
 */
import { createPublicClient, http, formatUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const USDC = "0x3600000000000000000000000000000000000000";
const CHAIN_ID = 5042002;

let crit = 0;
let warn = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  crit++;
  console.log(`  ✗ ${m}`);
};
const wrn = (m) => {
  warn++;
  console.log(`  ! ${m}`);
};

const client = createPublicClient({ transport: http(RPC) });
const erc20Balance = (addr) =>
  client
    .readContract({
      address: USDC,
      abi: [
        {
          name: "balanceOf",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "a", type: "address" }],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "balanceOf",
      args: [addr],
    })
    .catch(() => null);

console.log(`\nMerit preflight → ${RPC}\n`);

// 1) mode
console.log("[1] mode");
const stub = process.env.STUB === "1";
if (stub) wrn("STUB=1 — running OFFLINE (no real settlement). Set STUB=0 to go live.");
else ok("STUB=0 — live on-chain settlement");
const repOn = process.env.REPUTATION_ONCHAIN === "1";
ok(`REPUTATION_ONCHAIN=${repOn ? "1 (writes ERC-8004)" : "0 (merit cache only)"}`);

// 2) chain reachable
console.log("\n[2] Arc RPC");
let chainId = null;
try {
  chainId = await client.getChainId();
} catch {
  /* unreachable */
}
if (chainId === CHAIN_ID) ok(`RPC reachable, chainId ${chainId}`);
else if (chainId) bad(`RPC chainId ${chainId} != expected ${CHAIN_ID}`);
else bad(`RPC unreachable at ${RPC}`);

// 3) keys -> addresses -> funding
console.log("\n[3] wallets");
for (const role of ["BUYER", "OPERATOR"]) {
  const pk = process.env[`${role}_PRIVATE_KEY`];
  const declared = process.env[`${role}_ADDRESS`];
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    if (role === "OPERATOR" && !repOn) wrn(`${role}_PRIVATE_KEY missing (ok — REPUTATION_ONCHAIN=0)`);
    else bad(`${role}_PRIVATE_KEY missing or malformed`);
    continue;
  }
  let acct;
  try {
    acct = privateKeyToAccount(pk);
  } catch {
    bad(`${role}_PRIVATE_KEY invalid`);
    continue;
  }
  if (declared && getAddress(declared) !== acct.address) bad(`${role}_ADDRESS ${declared} != key-derived ${acct.address}`);
  else ok(`${role} key → ${acct.address}`);

  if (chainId === CHAIN_ID && !stub) {
    const gas = await client.getBalance({ address: acct.address }).catch(() => null);
    if (gas == null) wrn(`${role} gas balance unreadable`);
    else if (gas === 0n) bad(`${role} has 0 gas (native USDC) — fund at faucet.circle.com`);
    else ok(`${role} gas: ${formatUnits(gas, 18)} USDC`);
    if (role === "BUYER") {
      const bal = await erc20Balance(acct.address);
      if (bal == null) wrn("BUYER USDC (ERC-20) balance unreadable");
      else if (bal === 0n) bad("BUYER has 0 USDC (ERC-20) — needs funds for the Gateway deposit + payments");
      else ok(`BUYER USDC: ${formatUnits(bal, 6)}`);
    }
  }
}

// 4) LLM
console.log("\n[4] LLM");
const key = process.env.LLM_API_KEY;
const base = process.env.LLM_BASE_URL || "https://integrate.api.nvidia.com/v1";
const model = process.env.LLM_MODEL || "moonshotai/kimi-k2.6";
if (!key || /^your-/.test(key)) {
  wrn("LLM_API_KEY unset — the agent falls back to templated answers + lexical citation");
} else {
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
    });
    if (res.ok) ok(`LLM reachable (${model})`);
    else if (res.status === 401 || res.status === 403) bad(`LLM auth failed (HTTP ${res.status}) — check LLM_API_KEY`);
    else wrn(`LLM returned HTTP ${res.status} (key may be valid; verify LLM_MODEL/LLM_BASE_URL)`);
  } catch (e) {
    bad(`LLM unreachable: ${e.message}`);
  }
}

console.log(`\n${crit === 0 ? "✅ READY" : "❌ NOT READY"} — ${crit} blocker(s), ${warn} warning(s)\n`);
process.exit(crit === 0 ? 0 : 1);
