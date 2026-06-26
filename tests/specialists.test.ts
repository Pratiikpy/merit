import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Throwaway data dir so the seeded specialists.json never touches the real .data.
let spec: typeof import("../lib/specialists");
beforeAll(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-spec-"));
  spec = await import("../lib/specialists");
});

describe("specialist agent registry (the labor supply side)", () => {
  it("seeds competing specialists per role with stable receive-only wallets (no private key held)", () => {
    const all = spec.getSpecialists();
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(spec.getSpecialists("search").length).toBeGreaterThanOrEqual(2);
    expect(spec.getSpecialists("write").length).toBeGreaterThanOrEqual(2);
    const v = spec.specialistView(all[0]) as Record<string, unknown>;
    expect(v).not.toHaveProperty("privateKey"); // the view never exposes a key
    expect(all[0].wallet).toMatch(/^0x[0-9a-fA-F]{40}$/); // a real payout address
    expect(all[0]).not.toHaveProperty("privateKey"); // Merit holds no key at all — receive-only
    // The view is an explicit allowlist, NOT a {...s} spread: a field added to a specialist (here a
    // forged sensitive one) is excluded by default and can't leak through hire events / the directory.
    const leaky = spec.specialistView({ ...all[0], secretKey: "0xLEAK" } as never) as Record<string, unknown>;
    expect(leaky).not.toHaveProperty("secretKey"); // excluded by the allowlist
    expect(leaky.id).toBe(all[0].id); // real public fields still pass through
    expect(leaky.wallet).toBe(all[0].wallet);
  });

  it("hires the highest-merit specialist for a role (price breaks ties)", () => {
    const pick = spec.pickSpecialist("write");
    const best = spec.getSpecialists("write").slice().sort((a, b) => b.merit - a.merit || a.price - b.price)[0];
    expect(pick?.id).toBe(best.id);
    expect(pick?.tier).toBe("pro"); // the pro out-merits the cheaper budget rival
  });

  it("pickSpecialist honors a tier preference (economy hires the cheaper budget crew)", () => {
    expect(spec.pickSpecialist("verify", "budget")?.id).toBe("tally"); // the budget verify agent
    expect(spec.pickSpecialist("verify", "pro")?.id).toBe("auditor"); // the pro
    expect(spec.pickSpecialist("verify")?.id).toBe("auditor"); // default = highest merit = the pro
  });

  it("specialistBid (#12): an underdog discounts its bid; quality² weights the value", () => {
    const base = {
      id: "x", role: "write" as const, name: "X", handle: "", initials: "X", avatarBg: "#000",
      wallet: "0x0000000000000000000000000000000000000001" as `0x${string}`,
      price: 0.01, merit: 80, balance: 0, hires: 0, fails: 0, tier: "pro" as const, capability: "",
    };
    expect(spec.specialistBid({ ...base, hires: 0 }).bidPrice).toBeCloseTo(0.0085, 6); // 15% underdog discount
    expect(spec.specialistBid({ ...base, hires: 5 }).bidPrice).toBe(0.01); // full price once established
    expect(spec.specialistBid({ ...base, hires: 5, merit: 90 }).bidScore).toBeGreaterThan(
      spec.specialistBid({ ...base, hires: 5, merit: 50 }).bidScore,
    );
  });
  it("pickSpecialist runs a value auction but still hires the proven pro by default (#12)", () => {
    expect(spec.pickSpecialist("write")?.tier).toBe("pro");
    expect(spec.pickSpecialist("verify")?.id).toBe("auditor");
  });

  it("recordJob: paid → merit up + earnings + hire count; refused → merit down + fail count", () => {
    // snapshot as numbers — getSpecialist returns the live object
    const m0 = spec.getSpecialist("scribe")!.merit;
    const b0 = spec.getSpecialist("scribe")!.balance;
    const h0 = spec.getSpecialist("scribe")!.hires;
    spec.recordJob("scribe", { ok: true, earned: 0.012, meritDelta: 2 });
    const m1 = spec.getSpecialist("scribe")!.merit;
    expect(m1).toBe(Math.min(100, m0 + 2));
    expect(spec.getSpecialist("scribe")!.balance).toBeCloseTo(b0 + 0.012);
    expect(spec.getSpecialist("scribe")!.hires).toBe(h0 + 1);
    const b1 = spec.getSpecialist("scribe")!.balance;
    spec.recordJob("scribe", { ok: false, meritDelta: -4 });
    expect(spec.getSpecialist("scribe")!.merit).toBe(Math.max(0, m1 - 4));
    expect(spec.getSpecialist("scribe")!.fails).toBe(1);
    expect(spec.getSpecialist("scribe")!.balance).toBeCloseTo(b1); // a refusal pays nothing
  });

  it("clamps merit to 0..100 and persists across a fresh load", () => {
    spec.recordJob("ferret", { ok: false, meritDelta: -1000 });
    expect(spec.getSpecialist("ferret")!.merit).toBe(0);
    spec.recordJob("scout", { ok: true, earned: 0, meritDelta: 1000 });
    expect(spec.getSpecialist("scout")!.merit).toBe(100);
    // written to its own file, not the source registry
    const file = path.join(process.env.MERIT_DATA_DIR!, "specialists.json");
    expect(fs.existsSync(file)).toBe(true);
    const raw = fs.readFileSync(file, "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.find((s: { id: string }) => s.id === "scout").merit).toBe(100);
    expect(raw).not.toContain("privateKey"); // keys are stripped from disk (receive-only, unused)
    expect(raw).toContain("0x"); // the wallet ADDRESS is kept (it's the payTo)
  });

  it("recordJob on an unknown specialist id is a safe no-op (never throws mid-settlement)", () => {
    expect(() => spec.recordJob("ghost-agent", { ok: true, earned: 1, meritDelta: 1 })).not.toThrow();
    expect(spec.getSpecialist("ghost-agent")).toBeUndefined(); // and creates nothing
  });

  it("recordJob ok with earned:0 counts the hire but leaves balance untouched", () => {
    const s0 = spec.getSpecialist("auditor")!;
    const hiresBefore = s0.hires;
    const balBefore = s0.balance;
    spec.recordJob("auditor", { ok: true, earned: 0, meritDelta: 1 });
    const s1 = spec.getSpecialist("auditor")!;
    expect(s1.hires).toBe(hiresBefore + 1); // the hire is counted
    expect(s1.balance).toBe(balBefore); // earned:0 → balance unchanged
  });
});
