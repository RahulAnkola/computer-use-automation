import { GoogleGenAI } from "@google/genai";
import type { Content, FunctionDeclaration } from "@google/genai";

function extractRetryDelaySeconds(err: any): number | undefined {
  const message: string | undefined = err?.message ?? err?.error?.message;
  const match = message?.match(/retry in ([\d.]+)s/i);
  if (match) return Math.ceil(Number(match[1])) + 1;
  const details = err?.error?.details ?? err?.details;
  const retryInfo = Array.isArray(details) ? details.find((d: any) => d["@type"]?.includes("RetryInfo")) : undefined;
  const retryDelay: string | undefined = retryInfo?.retryDelay;
  if (retryDelay) {
    const seconds = Number(retryDelay.replace("s", ""));
    if (!Number.isNaN(seconds)) return Math.ceil(seconds) + 1;
  }
  return undefined;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ModelTurn {
  text?: string;
  toolCalls: ToolCall[];
  raw: unknown;
}

/** Thin wrapper around Gemini's function-calling API. We drive the loop
 *  ourselves (manual function calling, not AFC) because tool execution has
 *  real side effects on a live browser session that we need full control
 *  and logging over. */
export class LlmClient {
  private ai: GoogleGenAI;
  private model: string;
  private lastCallAt = 0;
  /** Free-tier Gemini quotas are roughly 5 req/min; spacing calls out avoids
   *  spending the whole retry budget reacting to 429s after the fact. */
  private minIntervalMs = 13_000;

  constructor(apiKey: string, model: string) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async step(systemInstruction: string, history: Content[], tools: FunctionDeclaration[]): Promise<ModelTurn> {
    const wait = this.minIntervalMs - (Date.now() - this.lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();

    const response = await this.withRetry(() =>
      this.ai.models.generateContent({
        model: this.model,
        contents: history,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations: tools }],
          temperature: 0.2,
        },
      })
    );

    const calls = response.functionCalls ?? [];
    const text = response.text;
    return {
      text,
      toolCalls: calls.map((c) => ({ name: c.name ?? "", args: (c.args ?? {}) as Record<string, unknown> })),
      raw: response,
    };
  }

  /** Free-tier Gemini quotas are tight (a handful of requests/minute); an
   *  agent loop that makes one call per observed step hits them routinely.
   *  Retry on 429s using the server's suggested retryDelay when present. */
  private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 15): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err: any) {
        attempt++;
        const status = err?.status ?? err?.error?.code;
        if (status !== 429 || attempt >= maxAttempts) throw err;
        const delaySec = extractRetryDelaySeconds(err) ?? Math.min(60, 2 ** attempt);
        console.log(`[llm] Rate limited (attempt ${attempt}/${maxAttempts}); waiting ${delaySec}s before retrying...`);
        await new Promise((r) => setTimeout(r, delaySec * 1000));
      }
    }
  }
}
