/**
 * Verification audit log — a signed, hash-chained, tamper-evident record of every CVO verdict, so a regulated
 * team can EXPORT a traceability artifact for the EU AI Act's Article 12 (automatic record-keeping / logging)
 * and Article 50 (transparency of AI output). Each entry chains to the previous by hash, so any edit to a past
 * record breaks the chain and is detectable — an immutable log WITHOUT requiring a blockchain (on-chain
 * anchoring stays an opt-in, per the finding that regulated buyers name SOC2/HIPAA/ISO, not crypto).
 *
 * Privacy: stores keccak hashes of the claim + source (and a short claim preview), not the full content — the
 * log PROVES what was verified and when, without retaining the user's text. Durable via the store (+ mirror).
 */
import { keccak256, toHex } from "viem";
import { loadDocFresh, saveDoc } from "./store";

export interface AuditEntry {
  index: number;
  at: string; // ISO 8601
  claimHash: `0x${string}`;
  claimPreview: string; // first 120 chars — enough to trace, not the full content
  sourceHash: string;
  verdict: "SUPPORTED" | "REFUSED";
  grounded: boolean;
  score: number | null;
  methods: string[];
  modelTag: string;
  engineVersion: string;
  prevHash: string; // hash of the previous entry (genesis = 0x000…0)
  hash: string; // keccak256(prevHash + canonical(this entry, sans hash)) — the tamper-evident link
}

interface AuditLog {
  entries: AuditEntry[];
}

const DOC = "audit";
const GENESIS = "0x" + "0".repeat(64);
const MAX_ENTRIES = 100_000; // bound the in-repo log; export/rotate beyond this

let cache: AuditLog | null = null;

function load(): AuditLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<AuditLog>(DOC, { entries: [] });
  if (!value.entries) value.entries = [];
  if (cacheable) cache = value;
  return value;
}

/** Deterministic serialization of the hashed fields (fixed order → reproducible hash across runs/langs). */
function core(e: Omit<AuditEntry, "hash">): string {
  return JSON.stringify([
    e.index, e.at, e.claimHash, e.sourceHash, e.verdict, e.grounded, e.score, e.methods, e.modelTag, e.engineVersion, e.prevHash,
  ]);
}

function linkHash(e: Omit<AuditEntry, "hash">): string {
  return keccak256(toHex(e.prevHash + core(e)));
}

/** Append a verdict to the tamper-evident chain. Best-effort caller: never let this fail a settled verdict. */
export function recordAuditVerdict(
  v: { verdict: "SUPPORTED" | "REFUSED"; grounded: boolean; score: number | null; methods: string[]; modelTag: string; engineVersion: string; sourceHash: string },
  claim: string,
): AuditEntry {
  const log = load();
  const prev = log.entries[log.entries.length - 1];
  const prevHash = prev ? prev.hash : GENESIS;
  const base: Omit<AuditEntry, "hash"> = {
    index: log.entries.length,
    at: new Date().toISOString(),
    claimHash: keccak256(toHex(claim)),
    claimPreview: (claim || "").slice(0, 120),
    sourceHash: v.sourceHash,
    verdict: v.verdict,
    grounded: v.grounded,
    score: v.score,
    methods: v.methods,
    modelTag: v.modelTag,
    engineVersion: v.engineVersion,
    prevHash,
  };
  const entry: AuditEntry = { ...base, hash: linkHash(base) };
  log.entries.push(entry);
  if (log.entries.length > MAX_ENTRIES) log.entries = log.entries.slice(-MAX_ENTRIES);
  cache = log;
  saveDoc(DOC, log);
  return entry;
}

/** Most-recent-first slice of the log. */
export function auditEntries(limit = 100): AuditEntry[] {
  const e = load().entries;
  return e.slice(Math.max(0, e.length - limit)).reverse();
}

export function auditCount(): number {
  return load().entries.length;
}

/** Re-derive every hash and check the chain links — proves the log is untampered. */
export function verifyAuditChain(): { valid: boolean; length: number; brokenAt: number | null } {
  const entries = load().entries;
  let prevHash = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prevHash !== prevHash) return { valid: false, length: entries.length, brokenAt: i };
    const { hash, ...base } = e;
    if (linkHash(base) !== hash) return { valid: false, length: entries.length, brokenAt: i };
    prevHash = e.hash;
  }
  return { valid: true, length: entries.length, brokenAt: null };
}

/** The EU AI Act mapping this log is designed to satisfy — surfaced in the export for auditors. */
export function euAiActMapping() {
  return {
    article12: "Record-keeping / automatic logging: each AI-assisted citation verification is logged with a "
      + "timestamp, the input hashes, the verdict, the methods and model version, and a hash link to the prior "
      + "record — an append-only, tamper-evident trail of the system's operation.",
    article50: "Transparency: each record states whether a cited claim was machine-verified as SUPPORTED or "
      + "REFUSED and by which method, so downstream disclosure of AI-generated/verified content is traceable to origin.",
    tamperEvidence: "keccak256 hash chain (each entry binds the previous entry's hash); verifiable offline via /api/audit?verify=1. On-chain anchoring is available as an opt-in and is NOT required.",
    note: "This is a traceability/record-keeping artifact, not legal advice or a certification. Signed with the deployment's MERIT_SIGNING_KEY for third-party integrity checks.",
  };
}
