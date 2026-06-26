import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDoc, saveDoc, docPath, hydrateDoc, dataDir } from "../lib/store";

const TMP = path.join(os.tmpdir(), "merit-store-test-" + process.pid);

describe("lib/store (durable document store)", () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    process.env.MERIT_DATA_DIR = TMP;
    delete process.env.MERIT_STORE;
  });
  afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    delete process.env.MERIT_DATA_DIR;
  });

  it("round-trips a document via the file backend", () => {
    expect(loadDoc("k", { n: 0 })).toEqual({ n: 0 }); // fallback when absent
    saveDoc("k", { n: 42, items: ["a"] });
    expect(loadDoc("k", { n: 0 })).toEqual({ n: 42, items: ["a"] });
    expect(fs.existsSync(docPath("k"))).toBe(true);
  });

  it("docPath honors MERIT_DATA_DIR", () => {
    expect(docPath("history")).toBe(path.join(TMP, "history.json"));
  });

  it("writes atomically — no leftover .tmp file", () => {
    saveDoc("k2", { ok: true });
    const files = fs.readdirSync(TMP);
    expect(files).toContain("k2.json");
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
  });

  it("returns the fallback on a corrupt file (never throws)", () => {
    fs.writeFileSync(docPath("bad"), "{not valid json");
    expect(loadDoc("bad", { safe: 1 })).toEqual({ safe: 1 });
  });

  it("hydrateDoc is a graceful no-op without the supabase mirror enabled", async () => {
    expect(await hydrateDoc("k")).toBe(false);
  });

  it("falls back to /tmp/merit-data on serverless (Vercel) when MERIT_DATA_DIR is unset", () => {
    delete process.env.MERIT_DATA_DIR;
    process.env.VERCEL = "1";
    expect(dataDir()).toBe(path.join("/tmp", "merit-data"));
    delete process.env.VERCEL;
    process.env.MERIT_DATA_DIR = TMP; // restore
  });
});
