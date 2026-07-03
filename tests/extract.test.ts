import { describe, expect, it } from "vitest";
import { extractSourceFromUrl } from "../lib/extract";

// These targets are rejected by the up-front host check BEFORE any network call: a literal private/loopback/
// link-local IP (v4 or v6, incl. bracketed and IPv4-mapped forms) is caught synchronously via net.isIP, so the
// test needs no DNS/network. Locks in the SSRF-guard fixes (redirect/DNS/IPv6 bypasses the review found).
const BLOCKED = [
  "http://127.0.0.1/latest/meta-data",
  "http://127.1/x", // WHATWG normalizes to 127.0.0.1
  "http://10.0.0.5/internal",
  "http://172.16.0.1/",
  "http://192.168.1.1/",
  "http://169.254.169.254/latest/meta-data/iam", // cloud IMDS
  "http://100.64.0.1/", // CGNAT
  "http://0.0.0.0/",
  "http://localhost:9200/",
  "http://sub.localhost/",
  "http://[::1]:9200/", // IPv6 loopback (the bracket-bypass the review flagged)
  "http://[::ffff:127.0.0.1]/", // IPv4-mapped IPv6 loopback
  "http://[fc00::1]/", // unique-local
  "http://[fe80::1]/", // link-local
];

describe("extractSourceFromUrl SSRF guard", () => {
  it.each(BLOCKED)("rejects the internal target %s without fetching", async (url) => {
    const r = await extractSourceFromUrl(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("that host isn't allowed");
  });

  it("rejects non-http(s) schemes", async () => {
    for (const url of ["file:///etc/passwd", "gopher://127.0.0.1/", "ftp://internal/"]) {
      const r = await extractSourceFromUrl(url);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects a malformed URL", async () => {
    const r = await extractSourceFromUrl("not a url");
    expect(r.ok).toBe(false);
  });
});
