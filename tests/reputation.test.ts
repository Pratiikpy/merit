import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Stub mode: registerIdentity returns a fake id without touching the chain, so we
// can verify the per-domain single-flight caching purely. A throwaway data dir
// keeps the persisted publishers.json out of the real .data.
let rep: typeof import("../lib/reputation");
beforeAll(async () => {
  process.env.STUB = "1";
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-rep-"));
  rep = await import("../lib/reputation");
}, 60000); // first import pulls in viem + chain libs; allow cold-start beyond the 10s default

describe("ensurePublisherIdentity (per-domain, single-flight)", () => {
  it("returns one shared identity per domain across repeated calls", async () => {
    const a = await rep.ensurePublisherIdentity("coindesk.com");
    const b = await rep.ensurePublisherIdentity("coindesk.com");
    expect(a).toBeTruthy();
    expect(b).toBe(a); // cached — same publisher, same on-chain identity
  });

  it("gives different domains different identities", async () => {
    const cd = await rep.ensurePublisherIdentity("coindesk.com");
    const dc = await rep.ensurePublisherIdentity("decrypt.co");
    expect(dc).toBeTruthy();
    expect(dc).not.toBe(cd);
  });

  it("concurrent calls for a new domain resolve to one identity (no double mint)", async () => {
    const [x, y] = await Promise.all([
      rep.ensurePublisherIdentity("theblock.co"),
      rep.ensurePublisherIdentity("theblock.co"),
    ]);
    expect(x).toBeTruthy();
    expect(y).toBe(x);
  });

  it("reuses a persisted identity instead of minting (restart survival)", async () => {
    // simulate a prior session having persisted this publisher's identity
    const { setPublisherAgentId } = await import("../lib/registry");
    setPublisherAgentId("pymnts.com", "999999");
    const id = await rep.ensurePublisherIdentity("pymnts.com");
    expect(id).toBe("999999"); // read from persistence, not a fresh mint
  });
});
