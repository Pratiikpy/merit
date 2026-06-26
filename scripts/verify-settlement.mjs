/**
 * "Don't trust, verify" for the MONEY. recompute.mjs rebuilds reputation from chain and verify-validation
 * reads the Auditor verdict; this proves the USDC actually MOVED. Given a creator/specialist payout wallet
 * (from a run receipt or /api/sources), it reads the USDC Transfer logs on Arc and sums what that wallet
 * truly received — the money analogue of recompute, with NO Merit server. Batched Gateway payments resolve
 * to real on-chain Transfers once the batch lands, so the settlement leg is checkable, not just asserted.
 *   Run:  node scripts/verify-settlement.mjs <walletAddress>
 */
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const EXPLORER = "https://testnet.arcscan.app";
const USDC = "0x3600000000000000000000000000000000000000";
// keccak("Transfer(address,address,uint256)") — topic[2] is the indexed `to`, value is the log data.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const die = (e) => {
  console.error(`\n  Could not verify settlement on Arc: ${e?.message || e}\n  Retry (the public RPC may be rate-limiting) or set ARC_RPC_URL.\n`);
  process.exit(1);
};
process.on("unhandledRejection", die);
process.on("uncaughtException", die);

const wallet = process.argv[2];
if (!/^0x[0-9a-fA-F]{40}$/.test(wallet || "")) {
  console.error("Usage: node scripts/verify-settlement.mjs <walletAddress>   (a payout wallet from a receipt / /api/sources)");
  process.exit(1);
}

const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const head = await pub.getBlockNumber();
const from = head > 9000n ? head - 9000n : 0n; // RPC caps eth_getLogs at ~10k blocks; recent window
const toTopic = "0x" + wallet.slice(2).toLowerCase().padStart(64, "0");

const logs = await pub.request({
  method: "eth_getLogs",
  params: [
    {
      address: USDC,
      topics: [TRANSFER_TOPIC, null, toTopic],
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + head.toString(16),
    },
  ],
});

const xfers = logs.map((l) => ({
  value: Number(BigInt(l.data)) / 1e6, // USDC token amounts are 6-dec
  from: "0x" + l.topics[1].slice(26),
  tx: l.transactionHash,
  block: Number(BigInt(l.blockNumber)),
}));
const total = xfers.reduce((a, x) => a + x.value, 0);

console.log(`\nUSDC settled to ${wallet} — read live from Arc (no Merit server, no cache):`);
console.log(`  USDC ${USDC}  ·  recent ~9k blocks\n`);
if (!xfers.length) {
  console.log("  No USDC Transfers to this wallet in the recent window (none settled yet — a Gateway batch may\n  still be pending — or older than ~9k blocks).\n");
  process.exit(0);
}
for (const x of xfers) console.log(`    +$${x.value.toFixed(6)}  ·  from ${x.from.slice(0, 10)}…  ·  block ${x.block}  ·  ${EXPLORER}/tx/${x.tx}`);
console.log(`\n  ${xfers.length} transfer(s)  ·  total $${total.toFixed(6)} received on-chain`);
console.log(`  Recomputed from raw USDC Transfer logs — the money is on Arc, verifiable by anyone.\n`);
