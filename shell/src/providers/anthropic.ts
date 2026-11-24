// What the Claude callers share: Foundry and Vertex AI both answer in
// Anthropic's Messages format, and Bedrock's Converse reports the same
// counts under its own names.
//
// Usage, from Anthropic's prompt-caching page (read 2026-11-25, no page date;
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
// `input_tokens` is input "not read from or used to create a cache",
// `cache_read_input_tokens` was read from it, and `cache_creation_input_tokens`
// was written, split by lifetime in `cache_creation` as
// `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`. The four
// counts are disjoint, as the proxy's Usage wants them.
//
// Long prompts, from Anthropic's pricing page (read 2026-11-25, no page date;
// https://platform.claude.com/docs/en/about-claude/pricing): "Claude Haiku 5.5
// is priced by prompt length: a request whose prompt is over 100,000 tokens
// pays higher prices", and "A request's prompt length counts all of its
// input tokens, including cache reads and cache writes"; "Claude 4.6 and
// later models (except Claude Haiku 5.5)... include the full 1M token context
// window at standard pricing". Bedrock's Claude Haiku 5.5 model card gives
// the same rule (read 2026-11-25).

import type { Usage } from "../proxy/plugin";

// Each model priced by prompt length, by the provider's own model ID (which
// contains it), and the prompt length above which every token is billed at
// the long-prompt rates.
const LONG_PROMPT_OVER: ReadonlyArray<readonly [string, number]> = [["claude-haiku-5-5", 100_000]];

export function isLongPrompt(modelId: string, promptTokens: number): boolean {
  const rule = LONG_PROMPT_OVER.find(([id]) => modelId.includes(id));
  return rule !== undefined && promptTokens > rule[1];
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

// Splits the cache writes by lifetime. Writes the reply does not split are
// counted as 1-hour writes, the dearer kind, so the ledger never counts less
// than the vendor charges.
export function splitCacheWrites(total: number, fiveMinute: number, oneHour: number): { cacheWrite: number; cacheWrite1h: number } {
  const unsplit = Math.max(0, total - fiveMinute - oneHour);
  return { cacheWrite: fiveMinute, cacheWrite1h: oneHour + unsplit };
}

// Usage from a Messages reply's `usage` object.
export function usageFromMessages(body: unknown, modelId: string): Usage | undefined {
  const u = (body as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u !== "object") return undefined;
  const creation = (u.cache_creation ?? {}) as Record<string, unknown>;
  const input = count(u.input_tokens);
  const cachedInput = count(u.cache_read_input_tokens);
  const writes = splitCacheWrites(count(u.cache_creation_input_tokens), count(creation.ephemeral_5m_input_tokens), count(creation.ephemeral_1h_input_tokens));
  const prompt = input + cachedInput + writes.cacheWrite + writes.cacheWrite1h;
  return { input, cachedInput, ...writes, output: count(u.output_tokens), longPrompt: isLongPrompt(modelId, prompt) };
}

// The text of a Messages reply.
export function messagesText(body: unknown): string | undefined {
  const content = (body as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  const text = Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("") : "";
  return text.trim() || undefined;
}

// The provider's own error name and message from a refusal's body: Anthropic's
// `{"type":"error","error":{"type","message"}}`, Azure's and Google's
// `{"error":{"code","message","status"}}` (Google may wrap it in an array).
export function errorFromBody(status: number, body: unknown): { name: string; message: string } {
  const root = Array.isArray(body) ? body[0] : body;
  const error = (root as { error?: unknown } | null)?.error;
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    const name = [e.status, e.code, e.type].find((v) => typeof v === "string" && v) as string | undefined;
    return { name: name ?? `HTTP ${status}`, message: typeof e.message === "string" ? e.message : "" };
  }
  if (typeof error === "string") return { name: error, message: String((root as { error_description?: unknown }).error_description ?? "") };
  const message = (root as { message?: unknown } | null)?.message;
  return { name: `HTTP ${status}`, message: typeof message === "string" ? message : typeof body === "string" ? body : "" };
}

// The test call's request: the smallest that proves a model answers.
export const TEST_PROMPT = "Reply with the single word OK.";
export const TEST_MAX_TOKENS = 5;

// Reads a reply body as JSON when it is JSON, else as text.
export async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
