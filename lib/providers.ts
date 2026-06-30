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

// Real web read — Jina Reader (https://r.jina.ai). Free, no key: returns the LIVE, clean text of any page, so
// a source backed by a real URL is verified against its ACTUAL current content. This is the web channel
// Agent-Reach routes to (the social channels — Reddit/Twitter via the local Agent-Reach CLI — are a separate
// local-only drop-in). Pure HTTP, so it works in production; graceful on any failure (the static content stands).
const jina: Provider = {
  id: "jina",
  available: () => process.env.MERIT_LIVE_WEB !== "0", // on by default; set MERIT_LIVE_WEB=0 to force static content
  async fetch(_query, source) {
    const target = (source.url || source.handle || "").trim();
    if (!target) return null;
    const url = /^https?:\/\//i.test(target) ? target : `https://${target}`;
    try {
      const res = await fetch(`https://r.jina.ai/${url}`, {
        headers: { Accept: "text/plain", "X-Return-Format": "text" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return null;
      const text = (await res.text()).trim();
      return text ? text.slice(0, 4000) : null;
    } catch {
      return null;
    }
  },
};

const PROVIDERS: Record<string, Provider> = { fixture, firecrawl, jina };

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
