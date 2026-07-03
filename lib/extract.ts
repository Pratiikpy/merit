/**
 * Fetch a source URL and return clean readable text, so the public "Verify This Claim" tool can accept a link
 * instead of pasted text. Prefers Jina Reader (r.jina.ai — clean text, no key) and falls back to a direct
 * fetch + tag-strip. Size-capped, fails closed, never throws. The direct-fetch target is SSRF-guarded via the
 * shared, reviewed guard in lib/ssrf.ts (DNS-resolved + private/loopback/IPv6 rejected, redirects re-validated).
 */
import { assertPublicHost, guardedFetch } from "./ssrf";

const MAX_BYTES = 400 * 1024;
const MAX_CHARS = 12000;

export async function extractSourceFromUrl(
  url: string,
): Promise<{ ok: true; text: string; title?: string } | { ok: false; error: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: "that doesn't look like a valid URL" };
  }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: "the source URL must start with http(s)://" };

  // Reject internal targets up front (before we even try Jina), resolving the host to catch DNS names and
  // IPv6 literals — not just literal private-IP strings.
  try {
    await assertPublicHost(u.hostname);
  } catch {
    return { ok: false, error: "that host isn't allowed" };
  }

  // 1) Jina Reader — clean extraction, no key. Fetches r.jina.ai (a fixed public host) which reads the target
  // on ITS own infra, so this leg cannot reach Merit's internal network regardless of the target.
  try {
    const r = await fetch(`https://r.jina.ai/${u.toString()}`, {
      headers: { accept: "text/plain", "user-agent": "merit-verify/1" },
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) {
      const t = clip(await r.text());
      if (t.trim().length > 40) return { ok: true, text: t, title: firstLine(t) };
    }
  } catch {
    /* fall through to the guarded direct fetch */
  }

  // 2) Direct fetch + strip — SSRF-guarded (host re-validated at every redirect hop).
  try {
    const r = await guardedFetch(u.toString(), { headers: { accept: "text/html,text/plain", "user-agent": "merit-verify/1" } });
    if (!r.ok) return { ok: false, error: `the source URL returned ${r.status}` };
    const buf = await r.arrayBuffer();
    const html = new TextDecoder().decode(buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf);
    const text = clip(stripHtml(html));
    if (text.trim().length < 40) return { ok: false, error: "couldn't extract readable text from that URL" };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: `couldn't read the source URL (${(e as Error).message.slice(0, 60)})` };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
const clip = (s: string) => (s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) : s);
const firstLine = (s: string) => {
  const l = s.split("\n").map((x) => x.trim()).find((x) => x.length > 3);
  return (l || "").replace(/^#+\s*|^Title:\s*/i, "").slice(0, 120);
};
