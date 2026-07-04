import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

let media: typeof import("../lib/media");

beforeAll(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-media-"));
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  delete process.env.LLM_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.OPENAI_API_KEY;
  media = await import("../lib/media");
});

describe("provenance-verified media licensing", () => {
  it("validates registration", () => {
    expect("error" in media.registerMedia({ title: "", description: "d", owner: "o", priceUsdc: 1 })).toBe(true);
    expect("error" in media.registerMedia({ title: "t", description: "", owner: "o", priceUsdc: 1 })).toBe(true);
    expect("error" in media.registerMedia({ title: "t", description: "d", owner: "o", priceUsdc: 0 })).toBe(true);
    expect("error" in media.registerMedia({ title: "t", description: "d", owner: "o", priceUsdc: 999 })).toBe(true);
  });

  it("registers a media item with a capped price and normalized type", () => {
    const res = media.registerMedia({ title: "Drone shot of Golden Gate at sunset", description: "A 4K aerial clip of the Golden Gate Bridge at sunset over the bay.", mediaType: "video", owner: "creator", priceUsdc: 0.5 });
    expect("media" in res).toBe(true);
    if ("media" in res) {
      expect(res.media.mediaType).toBe("video");
      expect(res.media.priceUsdc).toBe(0.5);
      expect(media.getMedia(res.media.id)?.title).toContain("Golden Gate");
    }
  });

  it("404s a license for unknown media, 400s a missing request", async () => {
    const a = await media.licenseMedia({ mediaId: "nope", request: "x", buyer: "b" });
    expect("error" in a && a.status).toBe(404);
    const reg = media.registerMedia({ title: "t", description: "d about a topic", owner: "o", priceUsdc: 0.1 });
    if (!("media" in reg)) throw new Error("register failed");
    const b = await media.licenseMedia({ mediaId: reg.media.id, request: "", buyer: "b" });
    expect("error" in b && b.status).toBe(400);
  });

  it("REFUSES a license when the provenance contradicts the request — no payment (deterministic, no LLM)", async () => {
    const reg = media.registerMedia({ title: "Quarterly revenue chart", description: "A chart showing quarterly revenue of $4.1 million for the period.", owner: "seller", ownerAddress: "0x1111111111111111111111111111111111111111", priceUsdc: 0.2 });
    if (!("media" in reg)) throw new Error("register failed");
    // Buyer requests media asserting a figure the provenance contradicts → numeric REFUSE, no license fee.
    const res = await media.licenseMedia({ mediaId: reg.media.id, request: "A chart showing quarterly revenue of $40 million.", buyer: "buyer", settle: true });
    expect("license" in res).toBe(true);
    if ("license" in res) {
      expect(res.license.verified).toBe(false);
      expect(res.license.verdict).toBe("REFUSED");
      expect(res.license.settlement).toBeNull(); // a non-match pays nothing
    }
  });

  it("stats never count a blocked/absent settlement as released", () => {
    const s = media.mediaStats();
    expect(s.media).toBeGreaterThan(0);
    expect(s.releasedUsdc).toBe(0); // nothing actually released in these keyless tests
  });
});
