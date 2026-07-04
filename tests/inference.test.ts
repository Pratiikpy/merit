import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

let inf: typeof import("../lib/inference");

beforeAll(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-infer-"));
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  delete process.env.LLM_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.OPENAI_API_KEY; // no model endpoint → attested/verified honestly refuse (503)
  inf = await import("../lib/inference");
});

describe("verified inference — config", () => {
  it("exposes the 0G model roster, a valid default, and per-tier prices", () => {
    expect(inf.INFERENCE_MODELS).toContain("deepseek-v4-flash");
    expect(inf.INFERENCE_MODELS).toContain("glm-5.2");
    expect(inf.INFERENCE_MODELS).toContain("kimi-k2.7-code");
    expect(inf.INFERENCE_MODELS).toContain(inf.DEFAULT_MODEL);
    expect(inf.PRICE.attested).toBeGreaterThan(0);
    expect(inf.PRICE.verified).toBeGreaterThan(inf.PRICE.attested); // verifying is the premium tier
  });
});

describe("attested inference — validation + honest keyless behavior", () => {
  it("400s without a prompt", async () => {
    const r = await inf.attestedInference({ prompt: "" });
    expect("error" in r && r.status).toBe(400);
  });
  it("with no model endpoint, REFUSES honestly (503) rather than fabricating an answer", async () => {
    const r = await inf.attestedInference({ prompt: "hello" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.status).toBe(503);
  });
});

describe("verified answer — validation + honest keyless behavior", () => {
  it("400s without question or source", async () => {
    const a = await inf.verifiedAnswer({ question: "", source: "s" });
    expect("error" in a && a.status).toBe(400);
    const b = await inf.verifiedAnswer({ question: "q", source: "" });
    expect("error" in b && b.status).toBe(400);
  });
  it("with no model endpoint, REFUSES honestly (503) — never a heuristic charge", async () => {
    const r = await inf.verifiedAnswer({ question: "What is the settlement figure?", source: "Settlement reached $4.1 trillion.", settle: true });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.status).toBe(503);
  });
});

describe("receipts board + stats", () => {
  it("starts empty and never counts a charge that did not happen", () => {
    expect(inf.listInference()).toEqual([]);
    const s = inf.inferenceStats();
    expect(s.calls).toBe(0);
    expect(s.chargedUsdc).toBe(0);
    expect(s.savedUsdc).toBe(0);
  });
});
