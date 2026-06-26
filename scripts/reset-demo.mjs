/**
 * Reset the registry to a clean demo state: restore the seven seed sources'
 * merit + balance to their defaults and drop any registered/test creators —
 * while PRESERVING each seed source's wallet and cached ERC-8004 agentId, so
 * runs stay fast (no re-minting). Restart the server afterward to reload.
 *   Run:  node scripts/reset-demo.mjs
 */
import fs from "node:fs";
import path from "node:path";

const FILE = path.join(process.cwd(), ".data", "registry.json");
const SEED = {
  stabledata: { merit: 95, balance: 128.4 },
  chainletter: { merit: 92, balance: 84.1 },
  ortiz: { merit: 88, balance: 210.7 },
  ledgerlens: { merit: 79, balance: 56.2 },
  cryptobuzz: { merit: 41, balance: 1.1 },
  anon: { merit: 63, balance: 0 },
  northbridge: { merit: 74, balance: 18.6 }, // the cited-but-unsupported trap — kept so its wallet isn't rotated each reset
};
const ORDER = ["stabledata", "chainletter", "ortiz", "ledgerlens", "cryptobuzz", "anon", "northbridge"];

if (!fs.existsSync(FILE)) {
  console.log("No registry file — it will seed fresh on next boot.");
  process.exit(0);
}
const reg = JSON.parse(fs.readFileSync(FILE, "utf-8"));
const kept = [];
for (const s of reg) {
  if (SEED[s.id]) {
    s.merit = SEED[s.id].merit;
    s.balance = SEED[s.id].balance;
    delete s.privateKey; // never write private keys to disk (receive-only, unused)
    kept.push(s); // wallet, agentId, content preserved
  }
}
kept.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
const tmp = FILE + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(kept, null, 2));
fs.renameSync(tmp, FILE);
console.log(
  `Reset ${kept.length} seed sources to fresh merit/balance; dropped ${reg.length - kept.length} test creators; agentIds preserved.`,
);

// Specialist agents (the agent-labor crew): reset merit to a per-tier baseline and
// zero earnings/job counters — but keep their stable wallets and minted ERC-8004 ids.
const SPEC_FILE = path.join(process.cwd(), ".data", "specialists.json");
if (fs.existsSync(SPEC_FILE)) {
  const specs = JSON.parse(fs.readFileSync(SPEC_FILE, "utf-8"));
  for (const s of specs) {
    s.merit = s.tier === "pro" ? 90 : 58;
    s.balance = 0;
    s.hires = 0;
    s.fails = 0;
    delete s.privateKey; // never write private keys to disk
  }
  const st = SPEC_FILE + ".tmp";
  fs.writeFileSync(st, JSON.stringify(specs, null, 2));
  fs.renameSync(st, SPEC_FILE);
  console.log(`Reset ${specs.length} specialist agents to baseline merit; wallets + agentIds preserved.`);
}
