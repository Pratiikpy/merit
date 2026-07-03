import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

let dir: string;
let wh: typeof import("../lib/webhooks");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merit-webhooks-"));
  process.env.MERIT_DATA_DIR = dir;
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  process.env.MERIT_WEBHOOK_SIGNING_KEY = "test-signing-key";
  wh = await import("../lib/webhooks");
});

const INTERNAL = [
  "http://127.0.0.1/hook",
  "http://127.1/hook",
  "http://10.0.0.5/hook",
  "http://192.168.1.1/hook",
  "http://169.254.169.254/hook", // cloud IMDS
  "http://[::1]/hook", // IPv6 loopback
  "http://[::ffff:127.0.0.1]/hook", // IPv4-mapped loopback
  "http://localhost:9000/hook",
];

describe("payment webhooks", () => {
  it("rejects internal / SSRF delivery targets at registration", async () => {
    for (const url of INTERNAL) {
      await expect(wh.registerWebhook(url)).rejects.toThrow();
    }
  });

  it("rejects non-http(s) schemes and garbage", async () => {
    await expect(wh.registerWebhook("ftp://example.com/hook")).rejects.toThrow();
    await expect(wh.registerWebhook("not a url")).rejects.toThrow();
  });

  it("registers a public target and returns a derived secret (never stored)", async () => {
    // a public IP LITERAL avoids a DNS lookup in the unit test while exercising the real guard
    const r = await wh.registerWebhook("http://93.184.216.34/webhook", { principalId: "prin_a", events: ["citation.settled"] });
    expect(r.id).toMatch(/^wh_[0-9a-f]+$/);
    expect(r.secret).toBe(wh.webhookSecret(r.id)); // secret is derived, recomputable
    // the persisted store must NOT contain the secret
    const onDisk = fs.readFileSync(path.join(dir, "webhooks.json"), "utf8");
    expect(onDisk).not.toContain(r.secret);
    expect(onDisk).toContain(r.id);
  });

  it("signs a payload so a receiver can verify it with the shown secret (Stripe-style)", async () => {
    const r = await wh.registerWebhook("http://8.8.8.8/hook");
    const body = JSON.stringify({ type: "citation.settled", amount: 0.01 });
    const t = 1_700_000_000;
    const sig = wh.signPayload(r.id, t, body);
    // an independent recomputation with the returned secret must match — this is what the receiver does
    const independent = createHmac("sha256", r.secret).update(`${t}.${body}`).digest("hex");
    expect(sig).toBe(independent);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists (scoped by principal) and removes", async () => {
    const a = await wh.registerWebhook("http://8.8.4.4/a", { principalId: "prin_x" });
    await wh.registerWebhook("http://1.1.1.1/b", { principalId: "prin_y" });
    const mine = wh.listWebhooks("prin_x");
    expect(mine.some((h) => h.id === a.id)).toBe(true);
    expect(mine.every((h) => h.id !== "wh_none")).toBe(true);
    // can't delete another principal's hook
    expect(wh.removeWebhook(a.id, "prin_y")).toBe(false);
    expect(wh.removeWebhook(a.id, "prin_x")).toBe(true);
    expect(wh.listWebhooks("prin_x").some((h) => h.id === a.id)).toBe(false);
  });
});
