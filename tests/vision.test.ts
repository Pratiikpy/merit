import { describe, it, expect } from "vitest";
import { parseExtraction, verifiedVisionExtract } from "../lib/vision";

describe("verified vision extraction", () => {
  it("parses the {answer, quote} JSON the vision model returns, even with surrounding prose/fences", () => {
    expect(parseExtraction('{"answer":"61B","quote":"total supply 61 billion"}')).toEqual({ answer: "61B", quote: "total supply 61 billion" });
    expect(parseExtraction('Here you go:\n```json\n{"answer":"Acme Inc","quote":"Acme Inc invoice"}\n```')).toEqual({ answer: "Acme Inc", quote: "Acme Inc invoice" });
  });

  it("falls back to raw content when there is no JSON", () => {
    expect(parseExtraction("no json here")).toEqual({ answer: "no json here", quote: "" });
  });

  it("400s on a missing or non-image url", async () => {
    expect("error" in (await verifiedVisionExtract({ imageUrl: "", question: "what number?" }))).toBe(true);
    expect("error" in (await verifiedVisionExtract({ imageUrl: "not-a-url", question: "what number?" }))).toBe(true);
  });

  it("400s without a question", async () => {
    expect("error" in (await verifiedVisionExtract({ imageUrl: "https://example.com/x.png", question: "" }))).toBe(true);
  });
});
