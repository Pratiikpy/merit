import { describe, it, expect } from "vitest";
import { leafOf, merkleRoot, dedupeEntries, concentrationEntropy, buildCreditFile } from "../lib/creditfile";
import type { LedgerEntry } from "../lib/ledger";

const E = (runId: string, sourceId: string, amount: number, at: number, tx?: string): LedgerEntry => ({ runId, sourceId, amount, at, tx });

describe("credit-file Merkle module", () => {
  it("is deterministic and order-independent (sorted leaves)", () => {
    const a = [E("r1", "s1", 0.01, 1), E("r2", "s2", 0.02, 2), E("r3", "s3", 0.03, 3)].map(leafOf);
    const shuffled = [a[2], a[0], a[1]];
    expect(merkleRoot(a)).toBe(merkleRoot(shuffled));
  });

  it("any changed entry changes the root", () => {
    const base = [E("r1", "s1", 0.01, 1), E("r2", "s2", 0.02, 2)];
    const tampered = [E("r1", "s1", 0.01, 1), E("r2", "s2", 0.99, 2)]; // amount altered
    expect(merkleRoot(base.map(leafOf))).not.toBe(merkleRoot(tampered.map(leafOf)));
  });

  it("handles empty and odd-sized sets", () => {
    expect(merkleRoot([])).toBe(`0x${"0".repeat(64)}`);
    const one = [leafOf(E("r", "s", 1, 1))];
    expect(merkleRoot(one)).toBe(one[0]); // single leaf is its own root
    expect(merkleRoot([...one, leafOf(E("r2", "s2", 2, 2)), leafOf(E("r3", "s3", 3, 3))])).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("idempotency (dedupe by leaf)", () => {
  it("a replayed settlement can never double-count", () => {
    const e = E("r1", "s1", 0.01, 1000, "0xabc");
    const { entries, leaves } = dedupeEntries([e, { ...e }, { ...e }]); // webhook replayed 3x
    expect(entries).toHaveLength(1);
    expect(leaves).toHaveLength(1);
  });

  it("distinct settlements stay distinct", () => {
    const { entries } = dedupeEntries([E("r1", "s1", 0.01, 1000), E("r1", "s1", 0.01, 2000)]); // same run+payee, different time
    expect(entries).toHaveLength(2);
  });
});

describe("concentration entropy (anti-wash signal)", () => {
  it("one counterparty → 0 (maximum concentration)", () => {
    expect(concentrationEntropy(new Map([["a", 10]]))).toBe(0);
  });
  it("evenly spread → 1", () => {
    expect(concentrationEntropy(new Map([["a", 5], ["b", 5], ["c", 5], ["d", 5]]))).toBe(1);
  });
  it("a wash loop concentrated on one payee scores lower than a diverse history", () => {
    const wash = concentrationEntropy(new Map([["a", 97], ["b", 2], ["c", 1]]));
    const diverse = concentrationEntropy(new Map([["a", 30], ["b", 40], ["c", 30]]));
    expect(wash).toBeLessThan(diverse);
  });
});

describe("the file itself", () => {
  it("builds with watermark, merkle, honesty label, and a stable fileId", async () => {
    const f = await buildCreditFile({ sign: false });
    expect(f.schema).toBe("merit.credit-file/v1");
    expect(f.asOf).toBeTruthy();
    expect(f.merkle.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(f.honesty).toMatch(/Sybil/);
    expect(f.replay.export).toContain("export=1");
    expect(f.fileId).toMatch(/^0x/);
    expect(f.verification.commitToSettleRatio).toBeGreaterThanOrEqual(0);
    expect(f.verification.commitToSettleRatio).toBeLessThanOrEqual(1);
  });
});
