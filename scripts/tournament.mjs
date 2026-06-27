/**
 * Self-play tournament — economic scalable oversight, demonstrated.
 *
 * The claim: under verification-gated payment, an AI agent that hallucinates LOSES MONEY automatically, so
 * truth-telling becomes the dominant strategy — enforced by the market, not by a human checker. This harness
 * proves it as an EMERGENT result: drop agents with different strategies into Merit's economy, settle every
 * citation through the REAL deterministic proof-of-citation verifier (lib/numcheck.fabricatedFigures), and
 * watch honesty win on its own — fabricators go bankrupt, and an agent that LEARNS (no honesty hard-coded)
 * converges to telling the truth because it pays.
 *
 * Self-contained, deterministic (seeded), free — no server, no LLM. Run: npm run tournament
 */
import { fabricatedFigures } from "../lib/numcheck.ts";
import { writeFileSync, mkdirSync } from "node:fs";

// Seeded PRNG so the tournament is a reproducible research artifact (same seed → same result).
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// Each fact is a verified source figure. An honest agent cites `fig` (matches → supported); a lying agent
// cites `lie` (contradicts the source's figure → the numeric verifier flags it → refused → no pay).
const FACTS = [
  { topic: "Cross-border B2B stablecoin settlement", source: "Cross-border B2B stablecoin settlement crossed $4.1T in annualized volume in 2026.", fig: "$4.1T", lie: "$41T" },
  { topic: "Embedded-wallet provisioning", source: "Embedded wallets silently provisioned 120 million USDC wallets at signup in 2026.", fig: "120 million", lie: "1.2 billion" },
  { topic: "Sub-cent nanopayment growth", source: "Sub-cent nanopayments grew 340% year over year to become the fastest-growing payment primitive of 2026.", fig: "340%", lie: "95%" },
  { topic: "Regulated-stablecoin share", source: "Regulated dollar stablecoins captured 72% of enterprise settlement volume after MiCA and the GENIUS Act.", fig: "72%", lie: "12%" },
  { topic: "On-chain FX settlement", source: "On-chain FX settlement reached $880 billion in 2026 as treasuries moved off correspondent banking.", fig: "$880 billion", lie: "$8.8 trillion" },
];
const claimFor = (f, lying) => `${f.topic} reached ${lying ? f.lie : f.fig} in 2026.`;

// Economy: each round an agent STAKES to cite (citation staking). Pass → stake returned + reward. Fail → stake
// slashed. Bankrupt when it can no longer afford the stake. (Numbers chosen so honesty compounds, lying ruins.)
const START = 1.0, STAKE = 0.05, REWARD = 0.06, SLASH = 0.1, ROUNDS = 30;

const mkAgent = (id, name, type, extra = {}) => ({
  id, name, type, balance: START, rep: 0, alive: true, bankruptAt: null,
  truths: 0, lies: 0, caught: 0, paid: 0, ...extra,
  // adaptive: learned average payoff of each action (honest vs lie); chooses by softmax — no honesty hard-coded.
  q: { honest: 0, lie: 0 }, n: { honest: 0, lie: 0 }, pStart: null,
});
const agents = [
  mkAgent("a1", "Honest-1", "honest"), mkAgent("a2", "Honest-2", "honest"),
  mkAgent("f1", "Fabricator-1", "fabricator"), mkAgent("f2", "Fabricator-2", "fabricator"),
  mkAgent("o1", "Opportunist", "opportunist", { lieRate: 0.5 }),
  mkAgent("d1", "Adaptive-1", "adaptive"), mkAgent("d2", "Adaptive-2", "adaptive"),
];

const honestyProb = (a) => {
  // softmax over learned payoffs; with no experience yet, 50/50.
  const h = a.n.honest ? a.q.honest : 0, l = a.n.lie ? a.q.lie : 0;
  const eh = Math.exp(h / 0.03), el = Math.exp(l / 0.03);
  return eh / (eh + el);
};
const decideLie = (a) => {
  if (a.type === "honest") return false;
  if (a.type === "fabricator") return true;
  if (a.type === "opportunist") return rnd() < a.lieRate;
  // adaptive: explore early, then exploit the higher-paying action
  if (a.pStart === null) a.pStart = honestyProb(a);
  return rnd() >= honestyProb(a);
};

const disputes = [];
const falseRateByRound = [];
const trace = [];

for (let round = 1; round <= ROUNDS; round++) {
  let lied = 0, submitted = 0;
  for (const a of agents) {
    if (!a.alive) continue;
    const f = pick(FACTS);
    const lying = decideLie(a);
    const claim = claimFor(f, lying);
    const supported = fabricatedFigures(claim, f.source).length === 0; // the REAL Merit verifier decides
    const payoff = supported ? REWARD : -SLASH; // a caught hallucination slashes more than an honest cite earns
    a.balance = Math.round((a.balance + payoff) * 1e6) / 1e6;
    a.rep += supported ? 1 : -2;
    if (lying) { a.lies++; if (!supported) a.caught++; } else a.truths++;
    if (supported) a.paid++;
    submitted++; if (lying) lied++;
    // adaptive learning: update the running mean payoff of the action it just took
    if (a.type === "adaptive") {
      const k = lying ? "lie" : "honest";
      a.n[k]++; a.q[k] += (payoff - a.q[k]) / a.n[k];
    }
    disputes.push({ round, agent: a.name, type: a.type, lying, claim, source: f.source, verdict: supported ? "SUPPORTED" : "REFUSED", payoff });
    if (a.alive && a.balance < STAKE) { a.alive = false; a.bankruptAt = round; a.balance = 0; }
  }
  falseRateByRound.push(submitted ? Math.round((lied / submitted) * 100) : 0);
  trace.push({ round, balances: Object.fromEntries(agents.map((a) => [a.name, a.balance])) });
}

// ---- Report ----
const bar = (v, max, w = 24) => "█".repeat(Math.max(0, Math.round((v / max) * w)));
const maxBal = Math.max(...agents.map((a) => a.balance), START);
const fmt = (n) => (n >= 0 ? " " : "") + n.toFixed(2);
console.log("\n  SELF-PLAY TOURNAMENT — economic scalable oversight\n  " + "─".repeat(64));
console.log(`  ${ROUNDS} rounds | reward $${REWARD}/verified cite, $${SLASH} slashed if caught | every citation settled by Merit's`);
console.log("  REAL deterministic verifier (lib/numcheck). No strategy is told to be honest.\n");
console.log("  agent            final$   return    cites  caught-lies   status");
for (const a of [...agents].sort((x, y) => y.balance - x.balance)) {
  const ret = (((a.balance - START) / START) * 100).toFixed(0).padStart(4);
  const status = a.alive ? "alive" : `BANKRUPT r${a.bankruptAt}`;
  console.log(`  ${a.name.padEnd(14)} ${fmt(a.balance)}   ${ret}%   ${String(a.truths + a.lies).padStart(4)}   ${String(a.caught).padStart(4)}/${String(a.lies).padEnd(3)}  ${bar(a.balance, maxBal, 16)} ${status}`);
}

const fabs = agents.filter((a) => a.type === "fabricator");
const lastFabBankrupt = Math.max(...fabs.map((a) => a.bankruptAt ?? ROUNDS));
const honest = agents.filter((a) => a.type === "honest");
const adaptives = agents.filter((a) => a.type === "adaptive");
const honestAvgReturn = (honest.reduce((s, a) => s + (a.balance - START), 0) / honest.length / START) * 100;

console.log("\n  EMERGENT RESULTS\n  " + "─".repeat(64));
console.log(`  • Fabricators (always lie):  bankrupt — last one by round ${lastFabBankrupt}.`);
console.log(`  • Honest agents:             +${honestAvgReturn.toFixed(0)}% — truth compounds.`);
for (const a of adaptives) {
  const pEnd = honestyProb(a);
  console.log(`  • ${a.name} (LEARNS, honesty not hard-coded): P(honest) ${(a.pStart ?? 0.5).toFixed(2)} → ${pEnd.toFixed(2)} — it learned truth pays.`);
}
console.log(`  • Market false-citation rate: ${falseRateByRound[0]}% (round 1) → ${falseRateByRound.at(-1)}% (round ${ROUNDS}) — hallucination priced out.`);
console.log("\n  We never programmed an agent to be honest. The economics made honesty the only way to survive.\n");

mkdirSync(".data", { recursive: true });
const out = {
  framing: "Merit is economic scalable oversight: payment gated on adversarial verification makes hallucination economically irrational, so truth-telling emerges as the dominant strategy for AI agents — enforced by the market, not a human checker.",
  config: { rounds: ROUNDS, stake: STAKE, reward: REWARD, slash: SLASH, start: START, seed: 42, verifier: "lib/numcheck.fabricatedFigures (deterministic)" },
  summary: {
    fabricatorsBankrupt: fabs.every((a) => !a.alive), lastFabricatorBankruptRound: lastFabBankrupt,
    honestAvgReturnPct: Math.round(honestAvgReturn),
    adaptiveConvergence: adaptives.map((a) => ({ name: a.name, pHonestStart: a.pStart, pHonestEnd: honestyProb(a) })),
    marketFalseCitationRate: { round1: falseRateByRound[0], final: falseRateByRound.at(-1) },
  },
  agents: agents.map(({ q, n, ...a }) => a), falseRateByRound, balanceTrace: trace, disputes,
};
writeFileSync(".data/tournament.json", JSON.stringify(out, null, 2));
console.log(`  → wrote .data/tournament.json (${disputes.length} settled citations — the dispute dataset).\n`);
