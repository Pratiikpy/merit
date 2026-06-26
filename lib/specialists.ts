/**
 * Specialist agents — the *supply side* of the agent-labor market. Each is an
 * autonomous service the lead agent HIRES and pays per job over x402 (its wallet
 * is the payTo). They earn USDC for verified work and accrue on-chain reputation;
 * bad work is refused + downranked, so the lead stops hiring them. This is what
 * makes Merit an agent-to-agent economy, not just an agent paying creators.
 *
 * Stable wallets persist (so reputation + earnings compound across runs), exactly
 * like the seed sources — separate file so it never touches the source registry.
 */
import fs from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export type Role = "search" | "write" | "verify";

export interface Specialist {
  id: string;
  role: Role;
  name: string;
  handle: string;
  initials: string;
  avatarBg: string;
  wallet: `0x${string}`; // payout address — RECEIVE-ONLY; Merit never holds its key
  price: number; // USDC the lead pays per hire
  merit: number; // 0..100 reputation
  agentId?: string; // ERC-8004 IdentityRegistry token id
  balance: number; // lifetime earnings
  hires: number; // jobs completed + paid
  fails: number; // jobs refused (failed verification)
  // `tier` is the agent's quality/price segment: a proven "pro" vs a cheaper,
  // lower-reputation "budget" alternative. The lead hires by reputation, so it picks
  // the pro and passes the budget rival over (surfaced as the demo's "chosen over"
  // note). Merit still moves for whoever IS hired — a pro that ever failed would drop
  // below its rival and lose the next job — so the reputation gate is self-correcting.
  tier: "pro" | "budget";
  // What the agent actually does — shown in the marketplace directory. For the VERIFY
  // role this is a real CAPABILITY difference (the pro Auditor runs the LLM judge; the
  // budget Tally runs similarity-only and can't catch contradictions). For search/write
  // the two tiers are same-capability competitors that differ on price + reputation.
  capability: string;
}

const DATA_DIR = process.env.MERIT_DATA_DIR || path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "specialists.json");

// Receive-only payout address; the key is derived-then-discarded (specialists never sign).
function newWallet() {
  return { wallet: privateKeyToAccount(generatePrivateKey()).address };
}

/** Two competitors per role — a proven "pro" and a cheaper, lower-reputation
 *  "budget" alternative — so the lead's reputation-gated hire is a real, visible
 *  choice between them (the demo's "chosen over" note). */
function seed(): Specialist[] {
  const mk = (s: Omit<Specialist, "wallet">): Specialist => ({ ...s, ...newWallet() });
  return [
    mk({ id: "scout", role: "search", name: "Scout", handle: "@scout", initials: "SC", avatarBg: "#0891B2",
      price: 0.006, merit: 88, balance: 0, hires: 0, fails: 0, tier: "pro",
      capability: "Source discovery + relevance ranking" }),
    mk({ id: "ferret", role: "search", name: "Ferret", handle: "@ferret", initials: "FE", avatarBg: "#64748B",
      price: 0.003, merit: 60, balance: 0, hires: 0, fails: 0, tier: "budget",
      capability: "Source discovery + relevance ranking" }),
    mk({ id: "scribe", role: "write", name: "Scribe", handle: "@scribe", initials: "SB", avatarBg: "#8B5CF6",
      price: 0.012, merit: 90, balance: 0, hires: 0, fails: 0, tier: "pro",
      capability: "Thorough drafting — covers every supported claim" }),
    mk({ id: "quill", role: "write", name: "Quill", handle: "@quill", initials: "QL", avatarBg: "#64748B",
      price: 0.006, merit: 55, balance: 0, hires: 0, fails: 0, tier: "budget",
      capability: "Terser drafting — fewer claims, fewer citations" }),
    mk({ id: "auditor", role: "verify", name: "Auditor", handle: "@auditor", initials: "AU", avatarBg: "#0D9488",
      price: 0.008, merit: 93, balance: 0, hires: 0, fails: 0, tier: "pro",
      capability: "Proof-of-citation: LLM judge + similarity" }),
    mk({ id: "tally", role: "verify", name: "Tally", handle: "@tally", initials: "TA", avatarBg: "#64748B",
      price: 0.004, merit: 57, balance: 0, hires: 0, fails: 0, tier: "budget",
      capability: "Proof-of-citation: similarity only (no judge)" }),
  ];
}

let cache: Specialist[] | null = null;

function ensureLoaded(): Specialist[] {
  if (cache) return cache;
  if (fs.existsSync(FILE)) {
    // Parse errors PROPAGATE — never silently re-seed over a real file, or a transient
    // read/parse error would wipe earned balances, hire counts, and minted agentIds
    // (the same rule registry.ts enforces for sources).
    const loaded = JSON.parse(fs.readFileSync(FILE, "utf-8")) as Specialist[];
    if (!Array.isArray(loaded)) throw new Error("specialists.json is not an array");
    cache = loaded;
    // Keep static seed metadata (`capability`) synced with the code on load — it's not
    // earned data, so a change in the seed should propagate. Earned fields (wallet, merit,
    // balance, hires, agentId) are NEVER touched here.
    const seeded = new Map(seed().map((s) => [s.id, s] as const));
    let backfilled = false;
    for (const s of cache) {
      const seedCap = seeded.get(s.id)?.capability;
      if (seedCap !== undefined && s.capability !== seedCap) {
        s.capability = seedCap;
        backfilled = true;
      }
    }
    // Additively backfill any seed specialist not yet on disk (e.g. a newly added
    // role/rival) — fresh wallet for the newcomer, existing agents left untouched.
    const have = new Set(cache.map((s) => s.id));
    const missing = seed().filter((s) => !have.has(s.id));
    if (missing.length) cache.push(...missing);
    if (missing.length || backfilled) persist();
  } else {
    cache = seed();
    persist();
  }
  return cache;
}

function persist() {
  if (!cache) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    // No secrets to strip — a Specialist carries only a receive-only address, never a key.
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error("[specialists] persist failed:", (e as Error).message);
  }
}

export function getSpecialists(role?: Role): Specialist[] {
  const all = ensureLoaded();
  return role ? all.filter((s) => s.role === role) : all;
}

export function getSpecialist(id: string): Specialist | undefined {
  return ensureLoaded().find((s) => s.id === id);
}

/** The lead agent's hiring rule: hire the most-trusted specialist for the role,
 *  price breaking ties. Reputation gates the market — a proven agent wins the work,
 *  and a cheaper-but-unproven one has to earn its merit before it gets hired.
 *
 *  `tier` is an optional preference: an "economy" run hires the cheaper budget crew
 *  (weaker, e.g. similarity-only verification) and a "pro" run the proven one. Within
 *  the chosen tier the reputation gate still applies. Falls back to the full pool if
 *  the requested tier has no agent for this role. */
const UNDERDOG_HIRES = 3; // below this, a specialist discounts its bid to win work + build reputation
const UNDERDOG_DISCOUNT = 0.85;

/** A specialist's bid for a job (#12) — the price it offers (an underdog with few hires discounts to win)
 *  and the lead's value score for it: quality-weighted (merit²) per bid-dollar, so the lead pays more for a
 *  proven specialist, yet a close, cheaper rival can still win. */
export function specialistBid(s: Specialist): { bidPrice: number; bidScore: number } {
  const bidPrice = s.hires < UNDERDOG_HIRES ? Math.round(s.price * UNDERDOG_DISCOUNT * 1e6) / 1e6 : s.price;
  return { bidPrice, bidScore: (s.merit * s.merit) / Math.max(1e-9, bidPrice) };
}

export function pickSpecialist(role: Role, tier?: "pro" | "budget"): Specialist | undefined {
  const all = getSpecialists(role);
  if (all.length === 0) return undefined;
  const inTier = tier ? all.filter((s) => s.tier === tier) : all;
  const pool = inTier.length ? inTier : all;
  // #12: a value auction — pick the highest bid score (quality² per bid-dollar), not just the top merit.
  return pool.slice().sort((a, b) => specialistBid(b).bidScore - specialistBid(a).bidScore)[0];
}

/** Record a job outcome: paid + merit up on success, refused + merit down on fail. */
export function recordJob(id: string, opts: { ok: boolean; earned?: number; meritDelta: number }) {
  const s = getSpecialist(id);
  if (!s) return;
  s.merit = Math.max(0, Math.min(100, s.merit + opts.meritDelta));
  if (opts.ok) {
    s.hires += 1;
    if (opts.earned) s.balance = Math.round((s.balance + opts.earned) * 1e6) / 1e6;
  } else {
    s.fails += 1;
  }
  persist();
}

export function setSpecialistAgentId(id: string, agentId: string) {
  const s = getSpecialist(id);
  if (s) {
    s.agentId = agentId;
    persist();
  }
}

/** Public view of a specialist for the API — an EXPLICIT allowlist projection, NOT a `{ ...s }`
 *  spread, so a field newly added to `Specialist` is excluded by default and cannot silently leak
 *  through every `hire` SSE event and the /api/agents directory. `wallet` is a receive-only payout
 *  address and Merit holds no private key, so every field below is public-safe. To expose a new
 *  field, add it here deliberately (mirrors how `publicView` projects a Source). */
export function specialistView(s: Specialist) {
  return {
    id: s.id,
    role: s.role,
    name: s.name,
    handle: s.handle,
    initials: s.initials,
    avatarBg: s.avatarBg,
    wallet: s.wallet,
    price: s.price,
    bid: specialistBid(s), // #12: the specialist's auction bid {bidPrice, bidScore} for this role
    merit: s.merit,
    agentId: s.agentId,
    balance: s.balance,
    hires: s.hires,
    fails: s.fails,
    tier: s.tier,
    capability: s.capability,
  };
}
