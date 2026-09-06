import { describe, it, expect, afterEach } from "vitest";
import { publicOrigin } from "../lib/origin";

/**
 * Regression, found by paying the live oracle from an independent wallet: the receipt handed back to a paying
 * agent pointed at `https://merit-ecru.vercel.app/v/…` — the internal deployment host — instead of the
 * product's own domain. Every route built its links from `new URL(req.url).origin`, which behind a proxy is the
 * internal URL, not the one the client asked for.
 */

const ORIGINAL = process.env.MERIT_ORIGIN;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MERIT_ORIGIN;
  else process.env.MERIT_ORIGIN = ORIGINAL;
});

function req(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers });
}

describe("publicOrigin", () => {
  it("uses the host the client actually asked for, not the internal one", () => {
    delete process.env.MERIT_ORIGIN;
    const r = req("https://merit-ecru.vercel.app/api/verify/paid", {
      "x-forwarded-host": "www.onmerit.xyz",
      "x-forwarded-proto": "https",
    });
    expect(publicOrigin(r)).toBe("https://www.onmerit.xyz");
  });

  it("lets an explicit operator override win over everything", () => {
    process.env.MERIT_ORIGIN = "https://onmerit.xyz";
    const r = req("https://merit-ecru.vercel.app/api/x", { "x-forwarded-host": "something-else.test" });
    expect(publicOrigin(r)).toBe("https://onmerit.xyz");
  });

  it("strips a trailing slash from the override, so links never double up", () => {
    process.env.MERIT_ORIGIN = "https://onmerit.xyz/";
    expect(publicOrigin(req("https://x.test/api"))).toBe("https://onmerit.xyz");
  });

  it("falls back to the plain host header when there is no proxy", () => {
    delete process.env.MERIT_ORIGIN;
    expect(publicOrigin(req("https://internal.test/api", { host: "www.onmerit.xyz" }))).toBe("https://www.onmerit.xyz");
  });

  it("keeps http for local development rather than emitting an unreachable https link", () => {
    delete process.env.MERIT_ORIGIN;
    expect(publicOrigin(req("http://localhost:3011/api", { host: "localhost:3011" }))).toBe("http://localhost:3011");
    expect(publicOrigin(req("http://127.0.0.1:3011/api", { host: "127.0.0.1:3011" }))).toBe("http://127.0.0.1:3011");
  });

  it("takes the first entry when a proxy chain joins several hosts", () => {
    delete process.env.MERIT_ORIGIN;
    const r = req("https://internal.test/api", { "x-forwarded-host": "www.onmerit.xyz, inner.vercel.app", "x-forwarded-proto": "https, http" });
    expect(publicOrigin(r)).toBe("https://www.onmerit.xyz");
  });

  it("discards a header that is not host-shaped instead of interpolating it into a URL", () => {
    delete process.env.MERIT_ORIGIN;
    // These are only ever used to build a link back to Merit, never for a trust decision — but a value that
    // is not a bare host must still never reach a URL.
    // A newline is not in this list because the runtime refuses to construct a Request with one — header
    // injection is blocked a layer below us. These are the shapes that CAN reach the helper.
    for (const evil of ["evil.test/path", "https://evil.test", "  ", "evil test", "evil.test:notaport"]) {
      const r = req("https://fallback.test/api", { "x-forwarded-host": evil, host: "fallback.test" });
      expect(publicOrigin(r)).toBe("https://fallback.test");
    }
  });

  it("falls back to the request URL when no host header is present at all", () => {
    delete process.env.MERIT_ORIGIN;
    expect(publicOrigin(req("https://direct.test/api/x"))).toBe("https://direct.test");
  });
});
