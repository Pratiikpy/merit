import { describe, expect, it } from "vitest";

import { leafHash, hashPair, merkleRoot, merkleProof, verifyProof, type Hex } from "../lib/merkle";

const L = (s: string): Hex => leafHash(s);

describe("merkle", () => {
  it("empty tree commits to the zero word", () => {
    expect(merkleRoot([])).toBe(`0x${"0".repeat(64)}`);
  });

  it("a single leaf IS the root", () => {
    const leaf = L("only");
    expect(merkleRoot([leaf])).toBe(leaf);
  });

  it("a two-leaf root is the hash of the ordered pair", () => {
    const a = L("a"), b = L("b");
    expect(merkleRoot([a, b])).toBe(hashPair(a, b));
  });

  it("odd levels duplicate the last node (3 leaves)", () => {
    const a = L("a"), b = L("b"), c = L("c");
    const expected = hashPair(hashPair(a, b), hashPair(c, c));
    expect(merkleRoot([a, b, c])).toBe(expected);
  });

  it("order matters — swapping two leaves changes the root", () => {
    const a = L("a"), b = L("b"), c = L("c");
    expect(merkleRoot([a, b, c])).not.toBe(merkleRoot([b, a, c]));
  });

  it("proof verifies every leaf against the root", () => {
    const leaves = ["w", "x", "y", "z", "q"].map(L);
    const root = merkleRoot(leaves);
    leaves.forEach((leaf, i) => {
      const proof = merkleProof(leaves, i);
      expect(verifyProof(leaf, proof, root)).toBe(true);
    });
  });

  it("a tampered leaf fails its own proof", () => {
    const leaves = ["w", "x", "y", "z"].map(L);
    const root = merkleRoot(leaves);
    const proof = merkleProof(leaves, 1);
    expect(verifyProof(L("TAMPERED"), proof, root)).toBe(false);
  });

  it("a proof from one leaf does not verify a different leaf", () => {
    const leaves = ["w", "x", "y", "z"].map(L);
    const root = merkleRoot(leaves);
    const proof = merkleProof(leaves, 0);
    expect(verifyProof(leaves[2], proof, root)).toBe(false);
  });

  it("out-of-range index throws", () => {
    const leaves = ["a", "b"].map(L);
    expect(() => merkleProof(leaves, 5)).toThrow();
  });
});
