/**
 * Show Merit's Circle Developer-Controlled Wallet — KMS-custodied on Arc, no plaintext private key.
 * Provisions one if none exists yet, then reads its on-chain USDC balance. Proof Merit uses Circle Wallets.
 *   node --env-file=.env.local scripts/dcw.mjs
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
if (!apiKey || !entitySecret) {
  console.error("\n  Set CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET in .env.local first.\n");
  process.exit(1);
}
const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

let address = process.env.MERIT_DCW_WALLET_ADDRESS;
let walletId = process.env.MERIT_DCW_WALLET_ID;
if (!walletId) {
  const ws = await client.createWalletSet({ name: "merit-buyer" });
  const r = await client.createWallets({ blockchains: ["ARC-TESTNET"], count: 1, accountType: "SCA", walletSetId: ws.data.walletSet.id });
  address = r.data.wallets[0].address;
  walletId = r.data.wallets[0].id;
  console.log("  Provisioned a new Merit Circle wallet. Add to .env.local:");
  console.log("  MERIT_DCW_WALLET_ADDRESS=" + address);
  console.log("  MERIT_DCW_WALLET_ID=" + walletId);
}

console.log("\n  Merit · Circle Developer-Controlled Wallet  (Arc testnet)");
console.log("  ────────────────────────────────────────────────────────");
console.log("  custody  : Circle KMS — no plaintext private key in env");
console.log("  address  :", address);
console.log("  walletId :", walletId);
try {
  const bal = await client.getWalletTokenBalance({ id: walletId });
  const usdc = (bal.data?.tokenBalances || []).find((t) => /USDC/i.test(t.token?.symbol || ""));
  console.log("  USDC     :", usdc ? usdc.amount : "0.00", usdc ? "" : "(fund at faucet.circle.com)");
} catch (e) {
  console.log("  USDC     : (balance read unavailable:", (e.message || "").slice(0, 60) + ")");
}
console.log("  explorer : https://testnet.arcscan.app/address/" + address + "\n");
