/**
 * Shared SSRF guard — the single, reviewed place that decides whether a server-side fetch target is safe. Any
 * feature that fetches a user-supplied URL (source extraction, webhook delivery, …) MUST route through here so
 * the rules stay in one audited spot. The host is resolved (DNS) and every resolved address is rejected if it
 * falls in a private / loopback / link-local / CGNAT / IPv4-mapped range (IPv4 AND IPv6, including bracketed
 * `[::1]` literals). Redirects are followed MANUALLY so a 302 to an internal address is re-validated, not blindly
 * followed. Residual: a DNS name could rebind between our resolve and fetch's own resolve — an accepted,
 * hard-to-close limit of global fetch; the checks here cover the realistic vectors (literal IPs, redirects,
 * names that statically resolve to private space).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as uFetch } from "undici";

export const MAX_REDIRECTS = 4;

/** True if `ip` (a literal IPv4/IPv6 address) is in a private, loopback, link-local, CGNAT, or unspecified range. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → reject
    const [a, b] = p;
    return (
      a === 0 || // 0.0.0.0/8 (this host)
      a === 10 || // private
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
      (a === 169 && b === 254) || // link-local 169.254/16
      (a === 172 && b >= 16 && b <= 31) || // private 172.16/12
      (a === 192 && b === 168) || // private
      (a === 192 && b === 0 && p[2] === 0) || // 192.0.0/24 (IETF)
      (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
      a >= 224 // multicast/reserved 224.0.0.0+
    );
  }
  if (v === 6) {
    const h = ip.toLowerCase().replace(/^\[|\]$/g, "");
    // IPv4-mapped/-compatible with a DOTTED tail (::ffff:a.b.c.d or ::a.b.c.d) — validate the embedded IPv4.
    const dotted = h.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) return isPrivateIp(dotted[1]);
    // IPv4-mapped in HEX: WHATWG normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1, so decode the last 32 bits to an
    // IPv4 and check that (else a mapped-loopback literal silently slips past a dotted-only check).
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h)) {
      const g = h.split(":");
      const hi = parseInt(g[g.length - 2], 16), lo = parseInt(g[g.length - 1], 16);
      return isPrivateIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
    if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1" || h === "0:0:0:0:0:0:0:0") return true; // loopback / unspecified
    if (/^f[cd]/.test(h)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
    if (/^ff/.test(h)) return true; // ff00::/8 multicast
    return false;
  }
  return true; // not a parseable IP literal → reject (fail closed)
}

/**
 * Resolve a hostname to a SINGLE validated public IP (throws if the host is internal or unresolvable). This is
 * the IP the connection is PINNED to, which eliminates the resolve-then-connect DNS-rebind window: we validate
 * the IP AND connect to that exact IP, so a TTL-0 domain can't flip to 169.254.169.254 / 127.0.0.1 between the
 * check and the connect. Every resolved address is validated (a name is rejected if ANY of its addresses is
 * private), then the first is pinned.
 */
export async function resolveValidatedIp(hostname: string): Promise<string> {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("host not allowed");
  const bare = host.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isIP(bare)) {
    if (isPrivateIp(bare)) throw new Error("host not allowed");
    return bare;
  }
  const addrs = await lookup(bare, { all: true });
  if (!addrs.length) throw new Error("host did not resolve");
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error("host resolves to a private address");
  return addrs[0].address; // all validated public → pin to the first
}

/** Reject a host that isn't safely public (resolves + checks every address). */
export async function assertPublicHost(hostname: string): Promise<void> {
  await resolveValidatedIp(hostname);
}

/** Validate a full URL is a public http(s) target (throws otherwise). Use before registering/persisting a URL. */
export async function assertPublicUrl(url: string): Promise<URL> {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) is allowed");
  await assertPublicHost(u.hostname);
  return u;
}

/** A minimal fetch-like response — body buffered so the pinned connection is closed before we return. */
export interface GuardedResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/**
 * SSRF-safe fetch: follows redirects MANUALLY, and at EVERY hop resolves+validates the host and PINS the
 * connection to that validated IP (via an undici dispatcher `lookup`), so global DNS re-resolution can't rebind
 * to an internal address between check and connect. TLS SNI + the Host header stay the original hostname, so
 * certificates still validate. The body is buffered and the dispatcher closed before returning (no leak).
 */
export async function guardedFetch(
  startUrl: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<GuardedResponse> {
  const { timeoutMs = 15000, method, headers, body } = init;
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) is allowed");
    const ip = await resolveValidatedIp(u.hostname);
    const family = isIP(ip);
    const agent = new Agent({
      connect: {
        // Force the connection to the pre-validated IP regardless of what the hostname would resolve to now.
        lookup: (
          _hostname: string,
          options: { all?: boolean },
          cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void,
        ) => {
          if (options && options.all) cb(null, [{ address: ip, family }]);
          else cb(null, ip, family);
        },
      },
    });
    try {
      const r = await uFetch(current, { method, headers, body, redirect: "manual", dispatcher: agent, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        await r.body?.cancel().catch(() => {});
        await agent.close().catch(() => {});
        current = new URL(r.headers.get("location")!, current).toString();
        continue;
      }
      const ab = await r.arrayBuffer(); // buffer fully so we can close the pinned connection
      const status = r.status;
      const ok = r.ok;
      const hdrs = r.headers as unknown as Headers;
      await agent.close().catch(() => {});
      return { ok, status, headers: hdrs, arrayBuffer: async () => ab, text: async () => Buffer.from(ab).toString("utf8") };
    } catch (e) {
      await agent.close().catch(() => {});
      throw e;
    }
  }
  throw new Error("too many redirects");
}
