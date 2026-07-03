import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

let dir: string;
let sellers: typeof import("../lib/sellers");
let procureMod: typeof import("../lib/procure");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merit-sellers-"));
  process.env.MERIT_DATA_DIR = dir;
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  sellers = await import("../lib/sellers");
  procureMod = await import("../lib/procure");
});

describe("external-seller reputation firewall (Wave C #9/#10)", () => {
  it("normalizes hosts", () => {
    expect(sellers.sellerHost("https://Data.API.com/x?y=1")).toBe("data.api.com");
    expect(sellers.sellerHost("data.api.com")).toBe("data.api.com");
  });

  it("starts neutral and moves the Beta score with evidence", () => {
    expect(sellers.sellerScore("fresh.com")).toBe(0.5); // unseen
    sellers.recordDelivery("good.com", true);
    sellers.recordDelivery("good.com", true);
    expect(sellers.sellerScore("good.com")).toBeGreaterThan(0.5);
  });

  it("does NOT firewall until there is enough evidence, then firewalls a junk seller", () => {
    // 3 refusals — below MIN_SAMPLES(4), so still given a chance
    for (let i = 0; i < 3; i++) sellers.recordDelivery("maybe.com", false);
    expect(sellers.sellerBlocked("maybe.com").blocked).toBe(false);
    // a 4th refusal tips it below the bar
    sellers.recordDelivery("maybe.com", false);
    expect(sellers.sellerBlocked("maybe.com").blocked).toBe(true);
    // a consistently-good seller is never blocked
    for (let i = 0; i < 6; i++) sellers.recordDelivery("solid.com", true);
    expect(sellers.sellerBlocked("solid.com").blocked).toBe(false);
  });

  it("supports an operator hard-block independent of score", () => {
    sellers.recordDelivery("vip.com", true);
    expect(sellers.sellerBlocked("vip.com").blocked).toBe(false);
    sellers.setSellerBlock("vip.com", true);
    expect(sellers.sellerBlocked("vip.com").blocked).toBe(true);
    expect(sellers.sellerBlocked("vip.com").reason).toMatch(/operator-blocked/);
    sellers.setSellerBlock("vip.com", false);
    expect(sellers.sellerBlocked("vip.com").blocked).toBe(false);
  });

  it("verifies PROVIDED content into an isolated bucket (can't poison a real host's reputation)", async () => {
    // a fabricated-figure delivery is caught by the numeric gate offline → verified:false
    const bad = await procureMod.procure({
      content: "The index shows settlement reached $4.1 trillion in 2026.",
      claim: "The index reported $40 trillion in settlement in 2026.",
      url: "https://legit-seller.example/data",
    });
    expect(bad.ok).toBe(true);
    if (bad.ok) {
      expect(bad.verified).toBe(false);
      expect(bad.host).toBe("provided:legit-seller.example"); // NOT the real host → no firewall-DoS
    }
    // the real host's reputation is untouched by provided content
    expect(sellers.sellerBlocked("legit-seller.example").blocked).toBe(false);
  });

  it("procure refuses a firewalled seller before any fetch (url-only path)", async () => {
    sellers.setSellerBlock("blocked.example", true);
    const refused = await procureMod.procure({ claim: "anything", url: "https://blocked.example/x" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.blocked).toBe(true); // blocked before fetching
  });
});
