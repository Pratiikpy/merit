/**
 * Merit source/creator registry — file-backed so source wallets are stable
 * across restarts and the app runs with zero external DB. Supabase (if
 * configured) is used only as a realtime mirror for receipts (see lib/db.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { effectivePrice } from "./pricing";
import { learnedTrust } from "./history";
import { dataDir, saveDoc } from "./store";

export interface Source {
  id: string;
  name: string;
  handle: string;
  kind: string;
  initials: string;
  avatarBg: string;
  merit: number; // 0..100 reputation
  price: number; // USDC per use (dollar number) — the BASE price
  priceMode?: "fixed" | "merit-gated"; // #4: merit-gated scales the effective price 0.5×..1.5× by reputation
  wallet: `0x${string}`; // payTo for x402 settlement — RECEIVE-ONLY; Merit never holds its key
  content: string; // the source material the agent reads + we verify against (static, or a provider fallback)
  provider?: string; // #9: a provider id (e.g. "fixture", "firecrawl") that fetches content LIVE per call
  verifyWith?: string[]; // #10: extra verification adapters this source must pass (numeric/schema/freshness/...)
  verified: boolean; // has a verifiable on-chain identity (identity gate)
  agentId?: string; // ERC-8004 IdentityRegistry token id, once minted
  balance: number; // lifetime earnings (leaderboard)
  trap?: boolean; // a demo source whose on-topic content CONTRADICTS the claim — only the Auditor catches it
}

// Configurable so a deploy can mount a persistent disk (set MERIT_DATA_DIR); on serverless (Vercel) the cwd
// is read-only, so this falls back to /tmp — shared with lib/store.ts so all state lands in one place
// (otherwise registry writes EROFS-fail silently and new creators never persist).
const DATA_DIR = dataDir();
const FILE = path.join(DATA_DIR, "registry.json");

// Generate a receive-only payout address. The key is derived-then-discarded — Merit never stores
// it (creators/specialists only RECEIVE, never sign), so a key it doesn't hold can't be misused.
function newWallet() {
  return { wallet: privateKeyToAccount(generatePrivateKey()).address };
}

/** Seed sources, with genuine (not hardcoded) outcomes that exercise all THREE refusal paths:
 *  CryptoBuzz is off-topic (won't be cited), Anon is unverified (fails the identity gate), and
 *  Northbridge is cited + on-topic + verified but its content CONTRADICTS the claim — the one only
 *  the Auditor's judge can catch, which a similarity filter would wrongly pay. */
function seed(): Source[] {
  const mk = (s: Omit<Source, "wallet">): Source => ({
    ...s,
    ...newWallet(),
  });
  return [
    mk({
      id: "stabledata", name: "StableData API", handle: "stabledata.xyz", kind: "API",
      initials: "SD", avatarBg: "#0A0A0A", merit: 95, price: 0.009, priceMode: "merit-gated", balance: 128.4,
      verified: true,
      content:
        "Cross-border B2B stablecoin settlement crossed $4.1T in annualized volume in 2026, now the dominant on-chain payment flow. Enterprises route supplier and payroll payments through USDC to cut FX and wire costs. Settlement finality under one second on stablecoin-native chains removed the last operational objection for treasury teams.",
    }),
    mk({
      id: "chainletter", name: "Chainletter Weekly", handle: "@chainletter", kind: "Newsletter",
      initials: "CL", avatarBg: "#0EA5E9", merit: 92, price: 0.018, balance: 84.1,
      verified: true,
      content:
        "Embedded wallets drove the first real consumer stablecoin usage in 2026: apps now provision a USDC wallet silently at signup, so users hold and spend digital dollars without knowing they touched crypto. This consumer on-ramp, not trading, is what pushed active stablecoin addresses past prior highs.",
    }),
    mk({
      id: "ortiz", name: "Dr. Lena Ortiz", handle: "@lortiz_pay", kind: "Researcher",
      initials: "LO", avatarBg: "#8B5CF6", merit: 88, price: 0.025, priceMode: "merit-gated", balance: 210.7,
      verified: true,
      content:
        "Regulatory clarity was the unlock for stablecoin payments: the EU's MiCA framework and the US GENIUS Act gave banks and enterprises the legal comfort to settle real volume in regulated dollar stablecoins. Adoption accelerated sharply in the two quarters after each rule took effect.",
    }),
    mk({
      id: "ledgerlens", name: "Ledger Lens", handle: "@ledgerlens", kind: "Analyst",
      initials: "LL", avatarBg: "#0891B2", merit: 79, price: 0.015, balance: 56.2,
      verified: true,
      content:
        "Sub-cent nanopayments are the fastest-growing payment primitive of 2026. Gas-free batched settlement made amounts as small as $0.000001 economical, opening pay-per-call, pay-per-second and pay-per-citation models that card rails could never support below ~30 cents.",
    }),
    mk({
      id: "cryptobuzz", name: "CryptoBuzz Daily", handle: "@cryptobuzz", kind: "Blog",
      initials: "CB", avatarBg: "#9CA3AF", merit: 41, price: 0.03, balance: 1.1,
      verified: true,
      // Deliberately off-topic — a good agent will NOT cite this for a stablecoin-payments question.
      content:
        "Top 10 celebrity memecoins that could 100x this week! A famous influencer just tweeted a dog picture and the token mooned 400%. Here is our astrology-based price prediction and the three coins our editor 'feels good about' for the weekend pump.",
    }),
    mk({
      id: "anon", name: "Anon Substack #4412", handle: "unverified", kind: "Unverified",
      initials: "??", avatarBg: "#6B7280", merit: 63, price: 0.012, balance: 0,
      // On-topic content, but NO verifiable identity → fails the identity gate.
      verified: false,
      content:
        "Stablecoin payment volume is growing because businesses want faster cross-border settlement and lower fees than traditional banking rails provide.",
    }),
    mk({
      id: "northbridge", name: "Northbridge Research", handle: "@northbridge", kind: "Analyst",
      initials: "NB", avatarBg: "#B45309", merit: 74, price: 0.02, balance: 18.6,
      // Verified identity (passes the identity gate) and ON-TOPIC (high similarity) — but its content
      // CONTRADICTS the claim it gets cited for. Only the Auditor's judge catches this; similarity can't.
      verified: true,
      trap: true,
      content:
        "Stablecoin payment adoption stalled in 2026. Cross-border B2B settlement never scaled past a niche, staying under $90M in annualized volume as enterprises kept routing payments over traditional wires. The digital-dollar narrative outran the actual flows, which stayed marginal.",
    }),
  ];
}

let cache: Source[] | null = null;

// Discovered (live-RSS) sources are ephemeral and payable for the duration of a
// run, but not persisted to the seed registry or the leaderboard.
const discovered = new Map<string, Source>();

/** Register live-discovered sources so the x402 seller can settle to them.
 * Bounded: discovered sources are only needed during their own run, so we cap
 * the map and evict the oldest entries to avoid unbounded growth over many runs. */
export function registerDiscovered(sources: Source[]): void {
  // Idempotent on the (deterministic) article id: a given article keeps ONE stable payout wallet for
  // the life of the process. Last-writer-wins would let a second concurrent discover run overwrite the
  // first run's object for the same id, so the first run's nanopayment would settle to the wrong (still
  // valid, ephemeral) wallet and its merit/agentId updates would land on the wrong object.
  for (const s of sources) if (!discovered.has(s.id)) discovered.set(s.id, s);
  const MAX = 2000; // well above any concurrent working set; entries are tiny
  if (discovered.size > MAX) {
    let excess = discovered.size - MAX;
    for (const k of discovered.keys()) {
      if (excess-- <= 0) break;
      discovered.delete(k); // Map preserves insertion order → oldest first
    }
  }
}

function ensureLoaded(): Source[] {
  if (cache) return cache;
  // Never silently re-seed over an existing file: a transient read/parse error
  // must not wipe accumulated merit / balances / agentIds. Seed ONLY when the
  // file genuinely doesn't exist; otherwise let a parse error propagate.
  if (fs.existsSync(FILE)) {
    cache = JSON.parse(fs.readFileSync(FILE, "utf-8")) as Source[];
    // Forward-compat: a NEW seed source (e.g. the cited-but-unsupported trap added later) must appear
    // even in a registry persisted before it existed — or the headline demo beat silently never fires on
    // a long-lived deploy. Add ONLY missing seed ids (each gets a fresh receive-only wallet); never touch
    // an existing row, so accumulated merit / balances / agentIds are preserved. Persist if anything changed.
    const have = new Set(cache.map((s) => s.id));
    const missing = seed().filter((s) => !have.has(s.id));
    if (missing.length) {
      cache.push(...missing);
      persist();
    }
    return cache;
  }
  cache = seed();
  persist(true); // LOCAL ONLY — the deterministic seed must never mirror (it would clobber the durable
  //               Supabase registry — onboarded creators — if a fresh instance seeds before boot-hydration).
  return cache;
}

function persist(localOnly = false) {
  if (!cache) return;
  // saveDoc writes dataDir()/registry.json atomically AND (unless localOnly) mirrors to Supabase
  // (after()-flushed on serverless), so onboarded creators survive cold starts. A Source carries only a
  // receive-only payout address (newWallet), never a private key, so the mirrored registry is key-free.
  // The fresh seed passes localOnly=true so a pre-hydration cold start can't overwrite real persisted state.
  saveDoc("registry", cache, localOnly ? { mirror: false } : undefined);
}

// ---- Per-publisher ERC-8004 identities (discovered sources) ----
// Kept in a SEPARATE file from the seed registry so this never touches the seed
// source format. Lets per-publisher reputation survive restarts: a redeploy
// reuses the same on-chain identity instead of minting a fresh one per article.
const PUB_FILE = path.join(DATA_DIR, "publishers.json");
let pubIds: Record<string, string> | null = null;

function loadPubIds(): Record<string, string> {
  if (pubIds) return pubIds;
  try {
    pubIds = JSON.parse(fs.readFileSync(PUB_FILE, "utf-8")) as Record<string, string>;
  } catch {
    pubIds = {};
  }
  return pubIds;
}

export function getPublisherAgentId(domain: string): string | undefined {
  return loadPubIds()[domain];
}

export function setPublisherAgentId(domain: string, agentId: string): void {
  const m = loadPubIds();
  if (m[domain] === agentId) return;
  m[domain] = agentId;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${PUB_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, PUB_FILE);
  } catch (e) {
    console.error("[registry] persist publisher id failed:", (e as Error).message);
  }
}

export function getSources(): Source[] {
  return ensureLoaded();
}

export function getSource(id: string): Source | undefined {
  return ensureLoaded().find((s) => s.id === id) || discovered.get(id);
}

export function addCreator(input: {
  name: string;
  handle?: string;
  price: number;
  priceMode?: "fixed" | "merit-gated";
  provider?: string;
  verifyWith?: string[];
  wallet?: string;
  content?: string;
}): Source {
  const list = ensureLoaded();
  // If the creator supplies their OWN wallet address, pay to it (receive-only,
  // so no key is held — non-custodial). Otherwise generate one for the demo.
  const provided =
    input.wallet && /^0x[0-9a-fA-F]{40}$/.test(input.wallet) && !/^0x0+$/i.test(input.wallet);
  const w = provided
    ? { wallet: input.wallet as `0x${string}` } // creator's own wallet — Merit never holds a key
    : newWallet();
  const initials =
    input.name
      .split(/\s+/)
      .map((x) => x[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "??";
  const palette = ["#0A0A0A", "#0EA5E9", "#8B5CF6", "#0891B2", "#0D9488", "#DB2777"];
  const src: Source = {
    id: "c_" + Date.now().toString(36),
    name: input.name,
    handle: input.handle || "@" + input.name.toLowerCase().replace(/\s+/g, ""),
    kind: "Creator",
    initials,
    avatarBg: palette[list.length % palette.length],
    merit: 50,
    price: input.price,
    priceMode: input.priceMode ?? "fixed",
    provider: input.provider,
    verifyWith: input.verifyWith,
    ...w,
    // The agent can only cite a source it can read — content is what makes a
    // registered creator actually payable (empty = registered but not yet earnable).
    content: (input.content || "").slice(0, 2000),
    verified: true, // has a registered wallet identity (self-attested at signup); the
    // ERC-8004 on-chain mint is best-effort/optional and not what this flag asserts.
    // The identity gate distinguishes registered creators (a payable wallet) from
    // anonymous, wallet-less sources (e.g. the "Anon" demo source, verified: false).
    balance: 0,
  };
  list.push(src);
  persist();
  return src;
}

export function applyOutcome(id: string, opts: { meritDelta: number; earned?: number }) {
  const s = getSource(id);
  if (!s) return;
  s.merit = Math.max(0, Math.min(100, s.merit + opts.meritDelta));
  if (opts.earned) s.balance = Math.round((s.balance + opts.earned) * 1e6) / 1e6;
  if (!discovered.has(id)) persist(); // ephemeral discovered sources aren't persisted
}

export function setAgentId(id: string, agentId: string) {
  const s = getSource(id);
  if (!s) return;
  s.agentId = agentId;
  if (!discovered.has(id)) persist();
}

/** Public-safe view (no private keys) for the API. */
export function publicView(s: Source) {
  return {
    id: s.id,
    name: s.name,
    handle: s.handle,
    kind: s.kind,
    initials: s.initials,
    avatarBg: s.avatarBg,
    merit: s.merit,
    price: s.price,
    priceMode: s.priceMode ?? "fixed",
    effectivePrice: effectivePrice(s.price, s.merit, s.priceMode), // #4: what this source is actually quoted/paid
    provider: s.provider, // #9: set if this source fetches its content live per call
    learnedTrust: learnedTrust(s.id), // #11: Beta posterior of its cross-run release rate (0.5 = unseen/neutral)
    wallet: s.wallet,
    verified: s.verified,
    balance: s.balance,
  };
}
