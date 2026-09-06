/**
 * The origin Merit should put in a link it hands back to a caller.
 *
 * `new URL(req.url).origin` is the obvious answer and the wrong one behind a proxy. On Vercel that resolves to
 * the internal deployment host, so a paying agent received a receipt at `https://merit-ecru.vercel.app/v/…`
 * instead of the product's own domain — a link that works today, points at infrastructure rather than the
 * product, and breaks the moment that deployment is superseded. It was found by paying the live oracle from an
 * independent wallet and reading the receipt URL that came back.
 *
 * The fix is to use the host the CLIENT actually asked for, which the proxy forwards. Order of preference:
 *
 *   1. `MERIT_ORIGIN` — an explicit operator override always wins.
 *   2. `x-forwarded-host` (+ `x-forwarded-proto`) — what the client typed, as recorded by the proxy.
 *   3. `host` — the same thing when there is no proxy.
 *   4. `new URL(req.url).origin` — last resort, correct when Merit is reached directly.
 *
 * The forwarded headers are attacker-controllable in principle, so the value is only ever used to build a
 * link back to Merit — never to make a trust, auth or payment decision.
 */

/** Take the first entry of a possibly comma-joined forwarded header, and reject anything not host-shaped. */
function firstHost(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  if (!first) return null;
  // host[:port] — letters, digits, dots, hyphens, optional port. Anything else (a path, a scheme, whitespace,
  // a header-injection attempt) is discarded rather than interpolated into a URL.
  return /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(first) ? first : null;
}

export function publicOrigin(req: Request): string {
  const override = (process.env.MERIT_ORIGIN || "").trim();
  if (override) return override.replace(/\/+$/, "");

  const host = firstHost(req.headers.get("x-forwarded-host")) || firstHost(req.headers.get("host"));
  if (host) {
    const proto = firstHost(req.headers.get("x-forwarded-proto")) || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${proto}://${host}`;
  }

  try {
    return new URL(req.url).origin;
  } catch {
    return "";
  }
}
