// A fetch that answers OpenRouter's addresses with no network: its public
// model list from the saved 2026-11-27 entries in fixtures/, the per-account
// list, the PKCE code exchange, the current key's figures and Chat
// Completions, each overridable. Every request it saw is kept, so a test can
// check what was sent.
import models from "./fixtures/openrouter-models.json";

export interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Overrides = Partial<Record<"models" | "userModels" | "keys" | "chat" | "currentKey", (sent: Sent) => Response | Promise<Response>>>;

// GET /api/v1/key's reply for the issued key: its figures this month, on an
// account that has bought credits.
export const keyReply = (data: Record<string, unknown> = {}) =>
  json({ data: { label: "Chief of staff", is_free_tier: false, organization_id: null, usage: 0, usage_daily: 0, usage_weekly: 0, usage_monthly: 0, byok_usage_monthly: 0, limit: null, limit_remaining: null, limit_reset: null, ...data } });

export const MODELS = models;
export const ISSUED_KEY = "test-issued-openrouter-key-not-real";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const chatReply = (extra: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) =>
  json({
    id: "gen-test-0001",
    model: "openai/gpt-6-luna",
    choices: [{ message: { role: "assistant", content: "OK" } }],
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14, prompt_tokens_details: { cached_tokens: 0 }, cost: 0.0000022, ...usage },
    ...extra,
  });

export function fakeFetch(overrides: Overrides = {}): typeof fetch & { sent: Sent[] } {
  const sent: Sent[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON
    }
    const s: Sent = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body };
    sent.push(s);
    const url = new URL(request.url);
    if (url.href === "https://openrouter.ai/api/v1/models") return overrides.models ? overrides.models(s) : json(models);
    if (url.pathname === "/api/v1/models/user") {
      if (overrides.userModels) return overrides.userModels(s);
      if (s.headers.authorization !== `Bearer ${ISSUED_KEY}`) return json({ error: { code: 401, message: "User not found." } }, 401);
      return json({ data: models.data.filter((m) => m.id !== "anthropic/claude-sonnet-5.5") });
    }
    if (url.href === "https://openrouter.ai/api/v1/auth/keys") return overrides.keys ? overrides.keys(s) : json({ key: ISSUED_KEY, user_id: "user_test" });
    if (url.href === "https://openrouter.ai/api/v1/key") {
      if (overrides.currentKey) return overrides.currentKey(s);
      if (s.headers.authorization !== `Bearer ${ISSUED_KEY}`) return json({ error: { code: 401, message: "User not found." } }, 401);
      return keyReply();
    }
    if (url.href === "https://openrouter.ai/api/v1/chat/completions") return overrides.chat ? overrides.chat(s) : chatReply({ model: (body as { model?: string }).model });
    return new Response("not found", { status: 404 });
  }) as typeof fetch & { sent: Sent[] };
  f.sent = sent;
  return f;
}
