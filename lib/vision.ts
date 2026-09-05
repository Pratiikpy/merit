/**
 * Verified vision extraction (max-0G modality, cat 5 + cat 6). The strongest-demand non-chat modality per the
 * PMF data: enterprises already pay for confidence-scored / grounded document extraction (Mistral OCR, Reducto,
 * Extend) because a wrong field extraction carries direct legal / insurance / healthcare cost. Merit resells 0G's
 * TEE-attested vision model (qwen3-vl-30b) and GROUNDS the extraction: the model returns both the answer AND the
 * exact text it read from the image, then Merit's verifier checks the answer is supported by that transcription —
 * a fabricated figure is caught by the same deterministic numeric gate every other door uses. Attested + verified.
 */
import { llmConfig, hasLLM } from "./arc";
import { llmAcquire, providerFailureMessage } from "./llm";
import { modelTee, type Attestation } from "./jury";
import { verifyCitation, isVerifyError } from "./verify/engine";
import { DEFAULT_VISION_MODEL, getModel } from "./models";

const CALL_TIMEOUT_MS = 60000;

export interface VisionExtraction {
  model: string;
  answer: string;
  quote: string; // the text the model says it read from the image (the grounding)
  attestation: Attestation | null;
  verdict: "SUPPORTED" | "REFUSED" | null; // did the answer verify against the model's own transcription?
  verified: boolean | null;
  verificationId?: string;
}

async function chatVision(model: string, imageUrl: string, question: string): Promise<{ content: string; attestation: Attestation | null } | { error: string; status: number }> {
  if (!hasLLM()) return { error: "no model endpoint configured (keyless demo) — set the 0G router key to serve vision", status: 503 };
  const c = llmConfig();
  const release = await llmAcquire();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.key}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `${question}\n\nReturn ONLY compact JSON: {"answer": <the answer>, "quote": <the exact text you read from the image that supports the answer>}.` },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        max_tokens: 700,
        temperature: 0.1,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: providerFailureMessage(res.status, "The vision model"), status: res.status === 404 ? 400 : 502 };
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    const content = (msg.content || msg.reasoning_content || "").trim();
    const trace = (data?.x_0g_trace || {}) as { provider?: string; request_id?: string };
    const resKey = res.headers.get("zg-res-key");
    const is0G = !!(resKey || trace.provider || trace.request_id);
    let attestation: Attestation | null = null;
    if (is0G) {
      const tee = await modelTee(model, Date.now());
      attestation = {
        provider: res.headers.get("x-provider") || trace.provider || null,
        requestId: res.headers.get("x-request-id") || trace.request_id || null,
        resKey: resKey || null,
        teeType: tee.teeType,
        verifiability: tee.verifiability,
      };
    }
    return { content, attestation };
  } catch (e) {
    return { error: `vision failed: ${(e as Error).message.slice(0, 80)}`, status: 502 };
  } finally {
    clearTimeout(timer);
    release();
  }
}

/** Parse the {answer, quote} the vision model returned; tolerant of surrounding prose / code fences. */
export function parseExtraction(content: string): { answer: string; quote: string } {
  const m = content.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j && (j.answer != null || j.quote != null)) return { answer: String(j.answer ?? content), quote: String(j.quote ?? "") };
    } catch {
      /* fall through to raw */
    }
  }
  return { answer: content, quote: "" };
}

export async function verifiedVisionExtract(input: { imageUrl: string; question: string; model?: string }): Promise<{ extraction: VisionExtraction } | { error: string; status: number }> {
  const imageUrl = (input.imageUrl || "").trim();
  const question = (input.question || "").trim();
  if (!imageUrl || !/^https?:\/\/|^data:image\//.test(imageUrl)) return { error: "provide an { imageUrl } (http(s) or data:image URI)", status: 400 };
  if (!question) return { error: "provide a { question } — what to extract from the image", status: 400 };
  const model = getModel(input.model || "")?.vision ? (input.model as string) : DEFAULT_VISION_MODEL;

  const out = await chatVision(model, imageUrl, question);
  if ("error" in out) return out;

  const { answer, quote } = parseExtraction(out.content);
  // Ground the extraction: the answer must be supported by the text the model says it read — a fabricated figure
  // is caught by the same deterministic numeric gate as a citation. No quote → we can't ground it (verdict null).
  let verdict: "SUPPORTED" | "REFUSED" | null = null;
  let verified: boolean | null = null;
  let verificationId: string | undefined;
  if (quote && quote.length > 3) {
    const o = await verifyCitation(answer, quote, {});
    if (!isVerifyError(o)) {
      verdict = o.verdict.verdict;
      verified = verdict === "SUPPORTED";
      verificationId = o.verdict.verificationId;
    }
  }
  return { extraction: { model, answer, quote, attestation: out.attestation, verdict, verified, verificationId } };
}
