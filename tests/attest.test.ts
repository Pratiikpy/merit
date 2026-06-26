import { describe, it, expect } from "vitest";
import { buildAttestation, signAttestationWith, verifyAttestation, sha256Hex } from "../lib/attest";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil account #0

describe("attested verification (#19)", () => {
  it("builds a reproducible attestation that re-derives from its inputs", () => {
    const a = buildAttestation("claims $4T", "the source says $4.1T", 0.6, 0.45, 123);
    expect(a.numeric.ok).toBe(true); // $4T within tolerance of $4.1T
    expect(a.similarity.pass).toBe(true); // 0.6 >= 0.45
    expect(a.supported).toBe(true);
    expect(a.sourceHash).toBe(sha256Hex("the source says $4.1T"));
    // a fabricated figure flips numeric.ok → supported false
    expect(buildAttestation("claims $40T", "the source says $4.1T", 0.6, 0.45, 1).supported).toBe(false);
  });

  it("signs + verifies offline; a tampered verdict or swapped content is caught", async () => {
    const content = "the source says $4.1T";
    const a = await signAttestationWith(KEY, buildAttestation("claims $4T", content, 0.6, 0.45, 1));
    const v = await verifyAttestation(a, content);
    expect(v.signatureOk).toBe(true);
    expect(v.deterministicOk).toBe(true);

    // tamper the verdict → the signature no longer recovers the signer
    const tampered = { ...a, supported: false };
    expect((await verifyAttestation(tampered, content)).signatureOk).toBe(false);

    // a swapped source → the deterministic re-derivation fails (different hash)
    expect((await verifyAttestation(a, "a totally different source")).deterministicOk).toBe(false);
  });
});
