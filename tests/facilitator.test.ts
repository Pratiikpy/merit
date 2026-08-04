import { describe, it, expect } from "vitest";
import { facilitate } from "../lib/facilitator";

describe("verify-gated x402 facilitator", () => {
  it("400s without a seller url", async () => {
    const r = await facilitate({ url: "", claim: "x" });
    expect("error" in r && r.status).toBe(400);
  });

  it("400s without a claim to verify the delivered work against", async () => {
    const r = await facilitate({ url: "https://seller.example/x402", claim: "" });
    expect("error" in r && r.status).toBe(400);
  });

  it("rejects a non-http url before touching the network", async () => {
    const r = await facilitate({ url: "ftp://nope", claim: "the content supports this" });
    expect("error" in r && r.status).toBe(400);
  });
});

describe("facilitator SSRF guard", () => {
  it("refuses an internal/metadata target before any probe", async () => {
    for (const url of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1/x", "http://10.0.0.5/", "http://[::1]:9200/"]) {
      const r = await facilitate({ url, claim: "the content supports this" });
      expect("error" in r && r.status).toBe(400);
    }
  });
});
