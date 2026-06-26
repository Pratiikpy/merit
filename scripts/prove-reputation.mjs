/**
 * Proof that ERC-8004 reputation works on Arc testnet end to end:
 * operator (owner) mints an agent identity, buyer (validator) rates it.
 * Run: node --env-file=.env.local scripts/prove-reputation.mjs
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  keccak256,
  toHex,
} from "viem";
import { arcTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "https://rpc.testnet.arc.network";
const ID = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REP = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const EXP = "https://testnet.arcscan.app/tx/";
const ID_ABI = parseAbi(["function register(string metadataURI)"]);
const REP_ABI = parseAbi([
  "function giveFeedback(uint256 agentId, int128 score, uint8 feedbackType, string tag, string metadataURI, string evidenceURI, string comment, bytes32 feedbackHash)",
]);
const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

const t = http(RPC);
const pc = createPublicClient({ chain: arcTestnet, transport: t });
const operator = privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY);
const buyer = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);
const opWallet = createWalletClient({ account: operator, chain: arcTestnet, transport: t });
const buyerWallet = createWalletClient({ account: buyer, chain: arcTestnet, transport: t });

console.log("operator(owner)   :", operator.address);
console.log("buyer(validator)  :", buyer.address);

// 1) register identity (operator owns it)
const regTx = await opWallet.writeContract({
  address: ID,
  abi: ID_ABI,
  functionName: "register",
  args: ["merit:proof:" + Date.now()],
});
console.log("\nregister tx       :", EXP + regTx);
const regRcpt = await pc.waitForTransactionReceipt({ hash: regTx });
console.log("  status          :", regRcpt.status);
const logs = await pc.getLogs({
  address: ID,
  event: TRANSFER,
  args: { to: operator.address },
  fromBlock: regRcpt.blockNumber,
  toBlock: regRcpt.blockNumber,
});
const agentId = logs.length ? logs[logs.length - 1].args.tokenId : null;
console.log("  agentId         :", agentId?.toString());
if (agentId == null) {
  console.log("FAILED: no agentId parsed from Transfer event");
  process.exit(1);
}

// 2) giveFeedback (buyer rates the agent — distinct from owner)
const tag = "merit-proof";
const fbTx = await buyerWallet.writeContract({
  address: REP,
  abi: REP_ABI,
  functionName: "giveFeedback",
  args: [agentId, 100n, 0, tag, "", "", "", keccak256(toHex(tag))],
});
console.log("\ngiveFeedback tx   :", EXP + fbTx);
const fbRcpt = await pc.waitForTransactionReceipt({ hash: fbTx });
console.log("  status          :", fbRcpt.status);
console.log("\n" + (fbRcpt.status === "success" ? "PROOF OK — ERC-8004 reputation is live on Arc ✓" : "PROOF FAILED"));
