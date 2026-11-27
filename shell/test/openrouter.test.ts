import { describe, expect, it } from "vitest";
import { parseModels } from "../src/prices/openrouter";
import { challengeOf, classify, openrouterPlugin, sha256Hex, TEST_MAX_TOKENS, usageFromReply } from "../src/providers/openrouter";
import type { SecretStore } from "../src/providers/secrets";
import { ConnectProblem, ProviderRefusal } from "../src/proxy/plugin";
import { chatReply, fakeFetch, ISSUED_KEY, MODELS } from "./fake-sources";

const NOW = new Date("2026-11-27T06:00:00Z");
const CATALOG = parseModels(MODELS, NOW).catalog;
const ENV = { APP_ORIGIN: "https://cos.example.com" };

const memorySecrets = (key?: string): SecretStore => {
  const items = new Map<string, string>(key ? [["u1|openrouter|key", key]] : []);
  return {
    put: async (u, p, k, v) => void items.set(`${u}|${p}|${k}`, v),
    read: async (u, p, k) => items.get(`${u}|${p}|${k}`),
    remove: async (u, p, k) => void items.delete(`${u}|${p}|${k}`),
  };
};

describe("Connect OpenRouter: OAuth PKCE", () => {
  it("sends the user to OpenRouter's own page with an S256 challenge, the state, the label and the credit limit", async () => {
    const plugin = openrouterPlugin(ENV, memorySecrets(), CATALOG, fakeFetch());
    const { open, verifier } = await plugin.connect.start({ callbackUrl: "https://cos.example.com/chief-of-staff/models/setup/providers/openrouter/consented", consentState: "s1", creditLimitUsd: 31 });
    const url = new URL(open);
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(url.searchParams.get("callback_url")).toBe("https://cos.example.com/chief-of-staff/models/setup/providers/openrouter/consented");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(await challengeOf(verifier));
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("key_label")).toBe("Chief of staff");
    expect(url.searchParams.get("limit")).toBe("31.00");
    // RFC 7636: 43 to 128 characters of the unreserved set; never sent to the browser.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(open).not.toContain(verifier);
  });

  it("trades the code and verifier for the key, and keeps only its hash on the record", async () => {
    const fetcher = fakeFetch();
    const plugin = openrouterPlugin(ENV, memorySecrets(), CATALOG, fetcher);
    const issued = await plugin.connect.finish("the-verifier", new URLSearchParams({ code: "c1", state: "s1" }));
    expect(fetcher.sent[0]).toMatchObject({ url: "https://openrouter.ai/api/v1/auth/keys", method: "POST", body: { code: "c1", code_verifier: "the-verifier", code_challenge_method: "S256" } });
    expect(issued.secret).toBe(ISSUED_KEY);
    expect(issued.fields).toEqual({ method: "oauth_pkce", key_hash: await sha256Hex(ISSUED_KEY) });
    expect(JSON.stringify(issued.fields)).not.toContain(ISSUED_KEY);
    expect(plugin.connect.guide.revokeLinks(issued.fields).map((l) => l.href)).toEqual(["https://openrouter.ai/settings/keys", `https://openrouter.ai/keys/${issued.fields.key_hash}`]);
  });

  it("refuses a return with no code, and an exchange OpenRouter refuses, in plain words", async () => {
    const plugin = openrouterPlugin(ENV, memorySecrets(), CATALOG, fakeFetch({ keys: () => Response.json({ error: { code: 403, message: "Invalid code or code_verifier" } }, { status: 403 }) }));
    await expect(plugin.connect.finish("v", new URLSearchParams({ state: "s" }))).rejects.toThrow(ConnectProblem);
    await expect(plugin.connect.finish("v", new URLSearchParams({ code: "c" }))).rejects.toThrow(/403 Invalid code or code_verifier.*10 minutes/);
  });
});

describe("the caller", () => {
  it("sends the chosen model alone, with the user's key and the app's attribution, and OpenRouter's own fallback taken out", async () => {
    const fetcher = fakeFetch();
    const plugin = openrouterPlugin(ENV, memorySecrets(ISSUED_KEY), CATALOG, fetcher);
    const credential = await plugin.mintCredential({}, { userId: "u1" });
    const reply = await plugin.call({ credential, connection: {}, model: "openai/gpt-6-luna", location: "global", request: { messages: [], models: ["x/y"], route: "fallback", model: "other" } });
    const sent = fetcher.sent[0]!;
    expect(sent.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent.headers.authorization).toBe(`Bearer ${ISSUED_KEY}`);
    expect(sent.headers["http-referer"]).toBe("https://cos.example.com/chief-of-staff");
    expect(sent.headers["x-openrouter-title"]).toBe("Chief of staff");
    expect(sent.body).toEqual({ messages: [], model: "openai/gpt-6-luna" });
    expect(reply).toMatchObject({ status: 200, callId: "gen-test-0001", usage: { input: 12, output: 2, reportedCostUsd: 0.0000022 } });
  });

  it("refuses to mint without a key in the vault", async () => {
    const plugin = openrouterPlugin(ENV, memorySecrets(), CATALOG, fakeFetch());
    await expect(plugin.mintCredential({}, { userId: "u1" })).rejects.toThrow(ProviderRefusal);
  });

  it("reads a refusal's own words, and an error inside a 200 as a failure", async () => {
    const refusing = openrouterPlugin(ENV, memorySecrets(), CATALOG, fakeFetch({ chat: () => Response.json({ error: { code: 402, message: "Insufficient credits" } }, { status: 402 }) }));
    expect(await refusing.call({ credential: "k", connection: {}, model: "openai/gpt-6-luna", location: "global", request: {} })).toMatchObject({ status: 402, error: { name: "HTTP 402", message: "Insufficient credits" } });
    const midway = openrouterPlugin(ENV, memorySecrets(), CATALOG, fakeFetch({ chat: () => Response.json({ id: "gen-2", error: { code: 502, message: "Provider returned error" } }) }));
    const reply = await midway.call({ credential: "k", connection: {}, model: "openai/gpt-6-luna", location: "global", request: {} });
    expect(reply).toMatchObject({ status: 502, callId: "gen-2", error: { message: "Provider returned error" } });
    expect(reply.usage).toBeUndefined();
  });

  it("reads the account's own model list with the user's key", async () => {
    const fetcher = fakeFetch();
    const plugin = openrouterPlugin(ENV, memorySecrets(), CATALOG, fetcher);
    const ids = await plugin.connect.readAccountModels!(ISSUED_KEY);
    expect(fetcher.sent[0]!.url).toBe("https://openrouter.ai/api/v1/models/user?output_modalities=text");
    expect(ids).not.toContain("anthropic/claude-sonnet-5.5");
    expect(ids).toContain("openai/gpt-6-luna");
    await expect(plugin.connect.readAccountModels!("revoked")).rejects.toThrow(ProviderRefusal);
  });
});

describe("usage and cost from the reply", () => {
  it("splits prompt tokens into uncached input, cache reads and cache writes, and takes OpenRouter's own cost", () => {
    const u = usageFromReply({ usage: { prompt_tokens: 10339, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 10318, cache_write_tokens: 0 }, cost: 0.0012 } });
    expect(u).toEqual({ input: 21, cachedInput: 10318, cacheWrite: 0, cacheWrite1h: 0, output: 60, longPrompt: false, reportedCostUsd: 0.0012 });
    const writes = usageFromReply({ usage: { prompt_tokens: 194, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100 }, cost: 0.95 } });
    // Writes OpenRouter does not split are counted as 1-hour writes, the dearer kind.
    expect(writes).toMatchObject({ input: 94, cacheWrite: 0, cacheWrite1h: 100 });
  });

  it("adds the upstream cost when the user's account used its own provider key", () => {
    expect(usageFromReply({ usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.02 } } })?.reportedCostUsd).toBeCloseTo(0.021);
    expect(usageFromReply({ usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.001, is_byok: false, cost_details: { upstream_inference_cost: 0.02 } } })?.reportedCostUsd).toBe(0.001);
  });

  it("has no reported cost when the reply gives none, and marks a long prompt from the model's threshold", () => {
    const u = usageFromReply({ usage: { prompt_tokens: 150_000, completion_tokens: 1 } }, 100_000);
    expect(u?.reportedCostUsd).toBeUndefined();
    expect(u?.longPrompt).toBe(true);
  });
});

describe("the model list and plain reasons", () => {
  const plugin = openrouterPlugin(ENV, memorySecrets(), CATALOG, fakeFetch());

  it("tests Connect on a cheap model OpenRouter sells, capped at a few reply tokens", () => {
    expect(plugin.connect.testModel).toBe("openai/gpt-6-luna");
    expect(plugin.connect.testRequest("openai/gpt-6-luna")).toMatchObject({ max_tokens: TEST_MAX_TOKENS });
    expect(TEST_MAX_TOKENS).toBe(16);
  });

  it("calls only what OpenRouter lists and the app can price, with notes", () => {
    expect(plugin.connect.canCall("openai/gpt-6-luna")).toBe(true);
    expect(plugin.connect.canCall("openrouter/auto")).toBe(false);
    expect(plugin.connect.notCallableReason("gone/model")).toBe("OpenRouter no longer lists it");
    expect(plugin.connect.noToolUse!("mistralai/pixtral-large-2502")).toBe("OpenRouter lists no tool support for it");
    expect(plugin.connect.modelNotes!("anthropic/claude-haiku-5.5")).toEqual(["priced higher from 100,000 prompt tokens"]);
    expect(plugin.connect.modelNotes!("nvidia/nemotron-3.5-content-safety")).toEqual(["OpenRouter retires it on 2026-11-30"]);
  });

  it("maps OpenRouter's statuses to the plain reasons", () => {
    const at = (status: number) => classify({ step: "call", status, errorName: "", message: "" }).reason;
    expect([401, 402, 403, 404, 408, 429, 502, 503, 400, 0].map(at)).toEqual(["not_set_up", "no_credits", "no_permission", "no_such_model", "busy", "busy", "busy", "busy", "refused", "no_reply"]);
    expect(classify({ step: "credential", status: 401, errorName: "no_key", message: "" }).reason).toBe("not_set_up");
  });

  it("reads the reply's text, or none from a reasoning model that spent its tokens thinking", async () => {
    expect(plugin.connect.replyText(await chatReply().json())).toBe("OK");
    expect(plugin.connect.replyText({ choices: [{ message: { content: "", reasoning: "…" } }] })).toBeUndefined();
  });
});
