import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Source } from "../lib/registry";

// Point the registry at a throwaway data dir BEFORE importing it, so these
// tests never touch the real .data/registry.json.
let reg: typeof import("../lib/registry");
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merit-reg-"));
  process.env.MERIT_DATA_DIR = dir;
  reg = await import("../lib/registry");
});

const file = () => path.join(dir, "registry.json");

describe("registry persistence", () => {
  it("seeds eight sources on first load and writes them atomically", () => {
    expect(reg.getSources().length).toBe(8); // 6 demo + the cited-but-unsupported trap (Northbridge) + the live-web source (USDC Reference)
    expect(fs.existsSync(file())).toBe(true);
    // a valid, fully-formed JSON file (atomic write never leaves it truncated)
    expect(() => JSON.parse(fs.readFileSync(file(), "utf-8"))).not.toThrow();
  });

  it("publicView strips secrets, and the on-disk registry never persists private keys", () => {
    const s = reg.getSource("stabledata")!;
    const v = reg.publicView(s);
    expect(v).not.toHaveProperty("privateKey");
    expect(v).not.toHaveProperty("content");
    const onDisk = fs.readFileSync(file(), "utf-8");
    expect(onDisk).not.toContain("privateKey"); // keys are stripped from disk (receive-only, unused)
    expect(onDisk).toContain("stabledata"); // but the public registry data (addresses, content) persists
    expect(onDisk).toContain("0x"); // the wallet ADDRESS is kept (it's the payTo)
  });

  it("addCreator generates a real EOA and persists it", () => {
    const c = reg.addCreator({ name: "Test Creator", price: 0.02 });
    expect(c.wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c.merit).toBe(50);
    const onDisk = JSON.parse(fs.readFileSync(file(), "utf-8")) as Source[];
    expect(onDisk.find((x) => x.id === c.id)).toBeTruthy();
  });

  it("uses a creator's own wallet, but rejects the zero address", () => {
    const own = reg.addCreator({ name: "Owned", price: 0.01, wallet: "0x" + "a".repeat(40) });
    expect(own.wallet.toLowerCase()).toBe("0x" + "a".repeat(40));
    // the zero address would burn funds → must fall back to a generated wallet
    const zero = reg.addCreator({ name: "Zero", price: 0.01, wallet: "0x" + "0".repeat(40) });
    expect(zero.wallet).not.toBe("0x" + "0".repeat(40));
    expect(/^0x[0-9a-fA-F]{40}$/.test(zero.wallet)).toBe(true);
  });

  it("stores creator content (what makes them earnable) and caps its length", () => {
    const withContent = reg.addCreator({ name: "Has Content", price: 0.01, content: "x".repeat(3000) });
    expect(withContent.content.length).toBe(2000); // capped, so it can be cited
    const without = reg.addCreator({ name: "No Content", price: 0.01 });
    expect(without.content).toBe(""); // registered, but not yet earnable
  });

  it("persists per-publisher identities to a separate file (survives restarts)", () => {
    expect(reg.getPublisherAgentId("coindesk.com")).toBeUndefined();
    reg.setPublisherAgentId("coindesk.com", "833683");
    expect(reg.getPublisherAgentId("coindesk.com")).toBe("833683");
    // written to its own file, never the seed registry
    const pubFile = path.join(dir, "publishers.json");
    expect(fs.existsSync(pubFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(pubFile, "utf-8"))["coindesk.com"]).toBe("833683");
    expect(fs.readFileSync(file(), "utf-8")).not.toContain("833683");
  });

  it("applyOutcome clamps merit to 0..100 and accrues balance", () => {
    reg.applyOutcome("cryptobuzz", { meritDelta: -1000 });
    expect(reg.getSource("cryptobuzz")!.merit).toBe(0);
    const before = reg.getSource("stabledata")!.balance;
    reg.applyOutcome("stabledata", { meritDelta: 1000, earned: 1.5 });
    const s = reg.getSource("stabledata")!;
    expect(s.merit).toBe(100);
    expect(s.balance).toBeCloseTo(before + 1.5);
  });

  it("registers discovered sources and keeps them resolvable (no premature eviction)", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      id: "d_test_" + i, name: "n", handle: "h", kind: "Publisher", initials: "NN",
      avatarBg: "#000", merit: 70, price: 0.01,
      wallet: ("0x" + "1".repeat(40)) as `0x${string}`,
      content: "c", verified: true, balance: 0,
    } satisfies Source));
    reg.registerDiscovered(many);
    // cap is 2000, so a normal working set is never evicted mid-run
    expect(reg.getSource("d_test_249")).toBeTruthy();
    expect(reg.getSource("d_test_0")).toBeTruthy();
    // discovered sources are not persisted to the seed file
    const onDisk = JSON.parse(fs.readFileSync(file(), "utf-8")) as Source[];
    expect(onDisk.find((x) => x.id === "d_test_0")).toBeFalsy();
  });

  it("applyOutcome on a DISCOVERED source updates merit/balance in memory but never persists it to the seed file", () => {
    reg.registerDiscovered([{
      id: "d_outcome", name: "Disc", handle: "h", kind: "Publisher", initials: "DD",
      avatarBg: "#000", merit: 60, price: 0.01,
      wallet: ("0x" + "3".repeat(40)) as `0x${string}`,
      content: "c", verified: true, balance: 0,
    } satisfies Source]);
    reg.applyOutcome("d_outcome", { meritDelta: 10, earned: 0.02 });
    const d = reg.getSource("d_outcome")!;
    expect(d.merit).toBe(70); // in-memory merit updated (the live receipt needs it)
    expect(d.balance).toBeCloseTo(0.02); // in-memory balance updated
    // ...but the ephemeral source must NOT leak into the persisted seed registry (would corrupt it)
    expect(fs.readFileSync(file(), "utf-8")).not.toContain("d_outcome");
  });

  it("applyOutcome on an unknown id is a safe no-op (never throws mid-settlement)", () => {
    expect(() => reg.applyOutcome("does-not-exist", { meritDelta: 5, earned: 1 })).not.toThrow();
    expect(reg.getSource("does-not-exist")).toBeUndefined(); // and creates nothing
  });

  it("applyOutcome with earned:0 moves merit but leaves balance untouched", () => {
    const before = reg.getSource("ledgerlens")!.balance;
    reg.applyOutcome("ledgerlens", { meritDelta: 1, earned: 0 });
    expect(reg.getSource("ledgerlens")!.balance).toBe(before); // earned:0 → no balance change
  });
});
