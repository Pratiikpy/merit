import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type { Source } from "../lib/registry";

let mod: typeof import("../lib/buyer");

beforeAll(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-buyer-"));
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  mod = await import("../lib/buyer");
});

function src(id: string, over: Partial<Source> = {}): Source {
  return {
    id,
    name: id,
    handle: id,
    initials: id.slice(0, 2).toUpperCase(),
    avatarBg: "#000",
    merit: 80,
    price: 0.01,
    balance: 0,
    verified: true,
    content: "some source content that a claim can be checked against",
    ...over,
  } as Source;
}

describe("buyer ranking — verified-quality-per-dollar", () => {
  it("ranks a cheaper, higher-reputation source above a pricier, weaker one", () => {
    const ranked = mod.rankCandidates([
      src("pricey", { price: 0.05, merit: 60 }),
      src("cheap-strong", { price: 0.005, merit: 95 }),
    ]);
    expect(ranked[0].id).toBe("cheap-strong");
    expect(ranked[0].valuePerDollar).toBeGreaterThan(ranked[1].valuePerDollar);
  });

  it("verifiedQuality rises with reputation and stays within [0,1]", () => {
    const lo = mod.verifiedQuality("no-history-lo", 0);
    const hi = mod.verifiedQuality("no-history-hi", 100);
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it("drops sources with no content and never divides by zero price", () => {
    const ranked = mod.rankCandidates([
      src("empty", { content: "" }),
      src("zero-price", { price: 0, merit: 90 }),
    ]);
    expect(ranked.find((c) => c.id === "empty")).toBeUndefined();
    const zp = ranked.find((c) => c.id === "zero-price");
    expect(zp).toBeDefined();
    expect(Number.isFinite(zp!.valuePerDollar)).toBe(true);
  });
});
