/**
 * Pay-per-call provider adapters (#9) — the PRD's beachhead. A provider-backed source fetches its content
 * LIVE at run time (a paid API call) instead of serving static text; proof-of-citation then runs on the
 * returned data and USDC settles per call. The built-in FIXTURE provider is the tested path (deterministic,
 * no key, no money). Real providers (Firecrawl, on-chain data) are optional env-keyed drop-ins that
 * gracefully skip when their key is absent — so the in-repo path always works and verifies for free.
 */
import type { Source } from "./registry";

export interface Provider {
  id: string;
  available(): boolean;
  fetch(query: string, source: Source): Promise<string | null>;
}

// Deterministic fixture — derives plausible content from the run question. No key, no network, always on.
const fixture: Provider = {
  id: "fixture",
  available: () => true,
  async fetch(query) {
    const topic = (query || "the market").replace(/[?.!]+/g, "").trim().slice(0, 80) || "the market";
    return `[Fixture Data API — fetched live per call] On "${topic}": cross-border B2B stablecoin settlement crossed $4.1T in annualized volume in 2026, now the dominant on-chain payment flow as enterprises route USDC to cut FX and wire costs.`;
  },
};

// Real provider scaffold — Firecrawl search. Available only with a key; otherwise the caller keeps static content.
const firecrawl: Provider = {
  id: "firecrawl",
  available: () => !!process.env.FIRECRAWL_API_KEY,
  async fetch(query, source) {
    const key = process.env.FIRECRAWL_API_KEY;
    if (!key) return null;
    try {
      const res = await fetch("https://api.firecrawl.dev/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query: `${source.name} ${query}`, limit: 1 }),
      });
      if (!res.ok) return null;
      const d = await res.json();
      const text = d?.data?.[0]?.markdown || d?.data?.[0]?.content || "";
      return text ? String(text).slice(0, 2000) : null;
    } catch {
      return null;
    }
  },
};

const PROVIDERS: Record<string, Provider> = { fixture, firecrawl };

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS[id];
}

/** Resolve a source's content for this run: LIVE from its provider when it has one and the provider is
 *  available, else its static content. Returns null only when a provider was named but produced nothing
 *  (the run keeps the static content in that case). */
export async function resolveSourceContent(source: Source, query: string): Promise<string | null> {
  if (!source.provider) return source.content;
  const p = getProvider(source.provider);
  if (!p || !p.available()) return null;
  return p.fetch(query, source);
}
