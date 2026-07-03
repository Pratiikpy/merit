/**
 * A minimal, deterministic keccak256 Merkle tree — the commitment structure over a consensus jury's ballots
 * (lib/jury.ts). The certificate publishes only the ROOT; any single juror ballot can then be proven to have
 * been part of the exact panel that decided a settlement, without re-publishing every ballot, and any tampering
 * with a ballot (or with the tally derived from it) changes the root. Index-ordered (position is meaningful:
 * ballot i is juror i), duplicate-last on an odd level — the conventional, widely-reimplementable scheme, so a
 * third party can recompute the root from the ballots in any language.
 *
 * Pure (no I/O, no keys) → fully unit-testable. Leaves are pre-hashed by the caller (keccak256 of the canonical
 * ballot bytes) so the tree is agnostic to what it commits to.
 */
import { keccak256, concatHex, toHex } from "viem";

export type Hex = `0x${string}`;

/** Hash one leaf value: keccak256 over its canonical bytes. The caller passes the canonical string. */
export function leafHash(canonical: string): Hex {
  return keccak256(toHex(canonical));
}

/** Combine two child hashes into their parent: keccak256(left ‖ right) over the raw 32-byte words. */
export function hashPair(left: Hex, right: Hex): Hex {
  return keccak256(concatHex([left, right]));
}

/**
 * The Merkle root over ordered, already-hashed leaves. Empty → the zero word (an empty panel commits to nothing,
 * distinguishable from any real root). A single leaf IS the root. Odd levels duplicate the last node (Bitcoin/
 * standard convention) so the tree is always full.
 */
export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return `0x${"0".repeat(64)}`;
  let level = leaves.slice();
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i]; // duplicate last on an odd count
      next.push(hashPair(left, right));
    }
    level = next;
  }
  return level[0];
}

/**
 * The audit path proving leaf `index` is in the tree: the sibling hash at each level, bottom-up, with the side
 * it sits on. `verifyProof(leaf, proof, root)` recomputes the root from these — so a certificate can carry one
 * ballot + its proof and a verifier confirms it belonged to the committed panel without the whole ballot set.
 */
export function merkleProof(leaves: Hex[], index: number): Array<{ hash: Hex; right: boolean }> {
  if (index < 0 || index >= leaves.length) throw new Error("leaf index out of range");
  const proof: Array<{ hash: Hex; right: boolean }> = [];
  let idx = index;
  let level = leaves.slice();
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const pairIdx = isRight ? idx - 1 : idx + 1;
    const sibling = pairIdx < level.length ? level[pairIdx] : level[idx]; // duplicated-last sibling
    proof.push({ hash: sibling, right: !isRight }); // the sibling sits on the opposite side to `idx`
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(hashPair(left, right));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Recompute the root from a leaf + its audit path; equal to the published root ⇒ the leaf is committed. */
export function verifyProof(leaf: Hex, proof: Array<{ hash: Hex; right: boolean }>, root: Hex): boolean {
  let acc = leaf;
  for (const step of proof) acc = step.right ? hashPair(acc, step.hash) : hashPair(step.hash, acc);
  return acc.toLowerCase() === root.toLowerCase();
}
