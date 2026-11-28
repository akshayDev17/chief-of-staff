// Connect OpenRouter: the one model provider (the owner, 2026-11-27: "so
// delete all the three: bedrock, gcp and foundry, and only have openrouter").
//
// Connect is OpenRouter's OAuth PKCE (https://openrouter.ai/docs/guides/overview/auth/oauth,
// read 2026-11-27, no page date). The user taps Connect OpenRouter and lands
// on OpenRouter's own page, signs in there and authorizes the app; OpenRouter
// sends them back with a code, and the app trades the code and its PKCE
// verifier for a key: "your app receives an API key tied to their account.
// Their requests are billed to their own OpenRouter credits, so you don't pay
// for their inference". So the user never gives the app a key: they authorize
// one at OpenRouter, which issues it to the app. The key goes straight into
// the user's vault (src/providers/secrets.ts); it is never shown, logged, put
// in an error, or sent to the browser. The connection record holds only how
// it was made and the key's SHA-256 hash, which names the key's own page on
// OpenRouter (the PKCE page builds `https://openrouter.ai/keys/<hash>` the
// same way).
//
// Revoking: OpenRouter's delete-a-key API needs a management key ("Delete an
// existing API key. Authenticate with a management key."; 403 "Only
// management keys can perform this operation",
// https://openrouter.ai/docs/api/api-reference/api-keys/delete-an-api-key.md;
// "All key management endpoints are under `/api/v1/keys` and require a
// Management API key", https://openrouter.ai/docs/guides/overview/auth/provisioning-api-keys;
// both read 2026-11-27), which is the account owner's own and never the
// app's. No page offers a key a way to delete itself: GET /api/v1/key, the
// one key route an ordinary key may call, reads it and returns no hash. So
// the app cannot revoke the key: Disconnect deletes it from the vault, and
// its confirmation links the key's own page, `https://openrouter.ai/keys/<hash>`,
// with the hash taken from the record (the SHA-256 of the key, made server
// side at Connect), where the signed-in owner deletes it.
//
// A new key each time: every Authorize trades a fresh code "for a
// user-controlled API key" (the PKCE page), and the flow has no parameter
// that names an existing key. The app cannot fetch an old one either: a key
// is returned only by the exchange that made it, and listing keys needs a
// management key. So each Connect mints a key, labelled with its date and
// time (`key_label`, "Prefills the label of the API key that will be
// created"; the page sets no length limit) so the user can tell them apart.
//
// Calls go to OpenRouter's Chat Completions endpoint, in OpenAI's format, on
// exactly the model chosen: OpenRouter's own model fallback (`models`,
// `route`) is taken out of the request, so the proxy's fallback rule alone
// decides. Usage and cost come from the reply ("Full usage details are always
// included automatically in every response",
// https://openrouter.ai/docs/use-cases/usage-accounting; "The token counts
// returned in the API response are calculated using the model's native
// tokenizer", https://openrouter.ai/docs/api-reference/overview; "the base
// currency is US dollars", https://openrouter.ai/docs/faq; all read
// 2026-11-27).

import { readAppOrigin } from "../app-config";
import type { OpenRouterCatalog, OpenRouterModel } from "../prices/openrouter";
import { BASE_PATH } from "../paths";
import { ConnectProblem, ProviderRefusal, type AccountInfo, type ConnectionFields, type Failure, type Link, type PlainReason, type ProviderPlugin, type Usage } from "../proxy/plugin";
import type { SecretStore } from "./secrets";

export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/auth/keys";
export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
// The models one account may use: "models filtered by user provider
// preferences, privacy settings, and guardrails", read with the user's key
// (OpenRouter's OpenAPI operation listModelsUser, security bearer, read
// 2026-11-27; data/cos-anthropic-owner-setup/report.md section 5). It lists
// text-output models by default.
export const OPENROUTER_USER_MODELS_URL = "https://openrouter.ai/api/v1/models/user?output_modalities=text";
// The current key's own figures, read with that key (no management key):
// `usage_monthly` "OpenRouter credit usage (in USD) for the current UTC
// month", `byok_usage_monthly` "External BYOK usage (in USD)" for the same
// month, `limit` "Spending limit for the API key in USD" (null: none),
// `limit_remaining` and `limit_reset`
// (https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key.md,
// read 2026-11-27). No OpenRouter page says how soon a call shows in these
// figures, so the budget bar never takes them as final (src/proxy/budget-bar.ts).
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
// Where a user sees their usage, filterable "by model, provider and api key"
// (https://openrouter.ai/docs/faq, read 2026-11-27).
export const OPENROUTER_ACTIVITY_URL = "https://openrouter.ai/activity";
export const KEY_LABEL = "Chief of staff";
// "Chief of staff · 2026-11-27 14:05:59 UTC": the key's label, from when Connect was tapped.
export const keyLabelAt = (now: Date): string => `${KEY_LABEL} · ${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 19)} UTC`;
export const APP_TITLE = "Chief of staff";

// The test call's request: the smallest that proves a model answers, its
// reply capped at 16 tokens. It runs only on the model the user chose.
export const TEST_PROMPT = "Reply with the single word OK.";
export const TEST_MAX_TOKENS = 16;

// One user message, the reply capped at `maxTokens`, in Chat Completions' format.
const promptRequest = (prompt: string, maxTokens: number) => ({ messages: [{ role: "user", content: prompt }], max_tokens: maxTokens });

const SETTINGS_KEYS = "https://openrouter.ai/settings/keys";
const SETTINGS_CREDITS = "https://openrouter.ai/settings/credits";
const SETTINGS_PRIVACY = "https://openrouter.ai/settings/privacy";

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// RFC 7636: a high-entropy verifier, and its S256 challenge.
export const makeVerifier = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));
export const challengeOf = async (verifier: string): Promise<string> =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

export const sha256Hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const usd = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

// Usage from a Chat Completions reply. `prompt_tokens` counts every input
// token, the cache reads (`cached_tokens`) and cache writes
// (`cache_write_tokens`) among them (OpenAI's convention, which the reply
// follows; the docs' own caching example has `cached_tokens` within
// `prompt_tokens`), so uncached input is what is left. OpenRouter does not
// split 5-minute from 1-hour cache writes, so they are counted as 1-hour
// writes, the dearer kind. `completion_tokens` includes reasoning. The cost
// is OpenRouter's own `cost`, plus `cost_details.upstream_inference_cost` when
// the user's account sent the call through their own provider key
// (`is_byok`), which that provider bills them for; so the ledger counts what
// the user pays for the call.
export function usageFromReply(body: unknown, longPromptFrom?: number): Usage | undefined {
  const u = (body as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u !== "object") return undefined;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const prompt = count(u.prompt_tokens);
  const cachedInput = count(details.cached_tokens);
  const writes = count(details.cache_write_tokens);
  const cost = usd(u.cost);
  const upstream = u.is_byok === true ? (usd((u.cost_details as Record<string, unknown> | undefined)?.upstream_inference_cost) ?? 0) : 0;
  return {
    input: Math.max(0, prompt - cachedInput - writes),
    cachedInput,
    cacheWrite: 0,
    cacheWrite1h: writes,
    output: count(u.completion_tokens),
    longPrompt: longPromptFrom !== undefined && prompt >= longPromptFrom,
    ...(cost !== undefined ? { reportedCostUsd: cost + upstream } : {}),
  };
}

// The text of a Chat Completions reply.
export function replyText(body: unknown): string | undefined {
  const content = (body as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("") : "";
  return text.trim() || undefined;
}

// OpenRouter's own error from a reply body, `{"error":{"code","message","metadata"}}`
// (https://openrouter.ai/docs/api_reference/errors-and-debugging.md, read 2026-11-27).
export function errorFromBody(status: number, body: unknown): { name: string; message: string } {
  const error = (body as { error?: unknown } | null)?.error;
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    const metadata = (e.metadata ?? {}) as Record<string, unknown>;
    const name = typeof metadata.error_type === "string" && metadata.error_type ? metadata.error_type : `HTTP ${typeof e.code === "number" ? e.code : status}`;
    return { name, message: typeof e.message === "string" ? e.message : "" };
  }
  return { name: `HTTP ${status}`, message: typeof body === "string" ? body.slice(0, 300) : "" };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// What the current key reports for this UTC month, in USD.
export interface KeyUsage {
  // `usage_monthly` plus `byok_usage_monthly`: what the user pays for the
  // key's calls this month, counted the way the ledger counts them
  // (usageFromReply adds the upstream cost of a call sent through the user's
  // own provider key).
  monthlyUsd: number;
  // The key's own credit limit on OpenRouter and what is left of it; absent
  // when the key has none.
  limitUsd?: number;
  limitRemainingUsd?: number;
  // How often OpenRouter resets the limit ("monthly", "weekly"…); absent when never.
  limitReset?: string;
}

// The key's figures from GET /api/v1/key's body; undefined when it holds no
// month's usage.
export function keyUsageFromBody(body: unknown): KeyUsage | undefined {
  const d = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!d || typeof d !== "object") return undefined;
  const monthly = usd(d.usage_monthly);
  if (monthly === undefined) return undefined;
  const limit = usd(d.limit);
  const remaining = usd(d.limit_remaining);
  return {
    monthlyUsd: monthly + (usd(d.byok_usage_monthly) ?? 0),
    ...(limit !== undefined ? { limitUsd: limit, ...(remaining !== undefined ? { limitRemainingUsd: remaining } : {}) } : {}),
    ...(limit !== undefined && typeof d.limit_reset === "string" && d.limit_reset ? { limitReset: d.limit_reset } : {}),
  };
}

// Reads the key's own figures from OpenRouter with the key itself, server
// side; the key never leaves the Worker. Throws ProviderRefusal when
// OpenRouter refuses or sends no figure.
export async function readKeyUsage(key: string, fetcher: typeof fetch = fetch): Promise<KeyUsage> {
  const response = await fetcher(OPENROUTER_KEY_URL, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  const body = await readBody(response);
  if (!response.ok) {
    const e = errorFromBody(response.status, body);
    throw new ProviderRefusal({ step: "key", status: response.status, errorName: e.name, message: e.message });
  }
  const usage = keyUsageFromBody(body);
  if (!usage) throw new ProviderRefusal({ step: "key", status: response.status, errorName: "no_usage", message: "the reply held no monthly usage" });
  return usage;
}

const link = (label: string, href: string): Link => ({ label, href });

// OpenRouter's free models ($0 in and out, the `:free` variants), in its own
// numbers: "Free usage limits" table, credits purchased "Less than 10": 20
// requests per minute and 50 per day; "At least 10": 20 per minute and 1000
// per day (https://openrouter.ai/docs/api-reference/limits, read 2026-11-27;
// the FAQ says the same, https://openrouter.ai/docs/faq). Free models are
// often served only by providers that log prompts: "Providers that do log,
// or where we have been unable to confirm their policy, will not be routed
// to" unless the privacy settings allow it, and "There are separate settings
// for paid and free models"; when "none of the providers match the level of
// privacy specified in your account settings, you will get an error"
// (https://openrouter.ai/docs/faq and
// https://openrouter.ai/docs/guides/privacy/provider-logging, read 2026-11-27).
export const FREE_LIMITS_TEXT =
  "OpenRouter allows free models 20 requests a minute, and 50 a day until your account has bought at least 10 credits ($10) in all, then 1,000 a day.";
export const FREE_PRIVACY_TEXT =
  "Free models are often served only by providers that may log or train on prompts, so OpenRouter refuses them (“No endpoints found matching your data policy”) until your privacy settings there allow such providers for free models.";
const FREE_TERMS_LINKS: Link[] = [
  link("OpenRouter's limits", "https://openrouter.ai/docs/api-reference/limits"),
  link("Privacy settings", SETTINGS_PRIVACY),
];

// The account behind a key, from GET /api/v1/key's body, read with that key
// (no management key; GET /api/v1/credits, the account's balance, needs one:
// "Get total credits purchased and used for the authenticated user.
// [Management key] required", https://openrouter.ai/docs/api-reference/get-credits,
// read 2026-11-27, so the app cannot read the balance). The key reports
// `is_free_tier`, "Whether the user has paid for credits before";
// `organization_id`, "The ID of the organization that owns this API key, or
// null when an individual account owns it"; `workspace_id`, "The ID of the
// workspace this API key spends in"; `limit`, `limit_remaining` and
// `limit_reset`, the key's own credit limit; `usage` and `usage_monthly`,
// "OpenRouter credit usage (in USD)" for the key, in all and this UTC month;
// and `free_model_daily_requests` (`used`, `limit`, `remaining`)
// (https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key.md
// and https://openrouter.ai/docs/api-reference/limits, read 2026-11-27).
// Undefined when the body holds no account.
export function accountOf(body: unknown): AccountInfo | undefined {
  const d = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!d || typeof d !== "object" || typeof d.is_free_tier !== "boolean") return undefined;
  const q = (d.free_model_daily_requests ?? {}) as Record<string, unknown>;
  const used = usd(q.used);
  const dailyLimit = usd(q.limit);
  const left = usd(q.remaining);
  const limit = usd(d.limit);
  const remaining = usd(d.limit_remaining);
  const monthly = usd(d.usage_monthly);
  const id = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    freeTier: d.is_free_tier,
    ...(id(d.organization_id) ? { organizationId: id(d.organization_id) } : {}),
    ...(id(d.workspace_id) ? { workspaceId: id(d.workspace_id) } : {}),
    ...(limit !== undefined ? { limitUsd: limit, ...(remaining !== undefined ? { limitRemainingUsd: remaining } : {}) } : {}),
    ...(limit !== undefined && id(d.limit_reset) ? { limitReset: id(d.limit_reset) } : {}),
    usageUsd: usd(d.usage) ?? 0,
    ...(monthly !== undefined ? { usageMonthlyUsd: monthly } : {}),
    ...(used !== undefined && dailyLimit !== undefined && left !== undefined ? { freeDaily: { used, limit: dailyLimit, remaining: left } } : {}),
  };
}

// Your keys on OpenRouter, and this key's own page when its hash is known.
export const keyLinks = (connection: ConnectionFields | undefined): Link[] => [
  link("Your keys on OpenRouter", SETTINGS_KEYS),
  ...(connection?.key_hash && /^[0-9a-f]{64}$/.test(connection.key_hash) ? [link("This key on OpenRouter", `https://openrouter.ai/keys/${connection.key_hash}`)] : []),
];

// The key's credit limit is OpenRouter's, not the app's monthly budget.
const KEY_LIMIT_FIX =
  "Raise this key's credit limit on OpenRouter, or give it a reset period (say monthly), on the key's page there. That limit is separate from the app's monthly budget.";

export function classify(failure: Failure, connection?: ConnectionFields): { reason: PlainReason; fix: string; links: Link[] } {
  const again = "Tap Connect OpenRouter again to authorize a new key.";
  if (failure.step === "credential") return { reason: "not_set_up", fix: `The app holds no OpenRouter key for you. ${again}`, links: [] };
  // OpenRouter's reply when the account's privacy settings leave no provider
  // that serves the model (it answers 404, so it would otherwise read as a
  // missing model).
  if (/data policy/i.test(failure.message)) {
    return {
      reason: "no_permission",
      fix: `Your OpenRouter privacy settings leave no provider that serves this model. ${FREE_PRIVACY_TEXT} Change them on OpenRouter, then test again.`,
      links: [link("Privacy settings", SETTINGS_PRIVACY)],
    };
  }
  // The free-model limits (OpenRouter's own words name them, as in
  // "free-models-per-day").
  if (failure.status === 429 && /free[- ]models?[- ]per[- ](day|min)/i.test(failure.message)) {
    return { reason: "busy", fix: `${FREE_LIMITS_TEXT} The daily count starts again at midnight UTC; buying credits raises it.`, links: [link("Credits", SETTINGS_CREDITS), FREE_TERMS_LINKS[0]!] };
  }
  switch (failure.status) {
    case 401:
      return { reason: "not_set_up", fix: `The key was deleted or disabled on OpenRouter. ${again}`, links: [link("Your keys on OpenRouter", SETTINGS_KEYS)] };
    case 402:
      return {
        reason: "no_credits",
        fix: "Add credits on OpenRouter, or raise this key's limit on its page there. The account line above says which.",
        links: [link("Add credits", SETTINGS_CREDITS), ...keyLinks(connection)],
      };
    case 403:
      if (/\bkey\b.*\blimit\b|\blimit\b.*\bkey\b/i.test(failure.message)) return { reason: "no_credits", fix: KEY_LIMIT_FIX, links: keyLinks(connection) };
      return { reason: "no_permission", fix: "OpenRouter's own words say why. A guardrail or your privacy settings on OpenRouter can block a model.", links: [link("Privacy settings", SETTINGS_PRIVACY)] };
    case 404:
      return { reason: "no_such_model", fix: "OpenRouter may no longer offer it: Refresh model list.", links: [] };
    case 408:
    case 429:
    case 502:
    case 503:
      return { reason: "busy", fix: "Try again later. A task's calls go to its fallback model meanwhile.", links: [] };
    case 0:
      return { reason: "no_reply", fix: "Try again later.", links: [] };
    default:
      return { reason: "refused", fix: "OpenRouter's own words say why.", links: [] };
  }
}

export interface OpenRouterEnv {
  APP_ORIGIN?: string;
}

export function openrouterPlugin(env: OpenRouterEnv, secrets: SecretStore, catalog: OpenRouterCatalog | undefined, fetcher: typeof fetch = fetch): ProviderPlugin {
  const byId = new Map<string, OpenRouterModel>((catalog?.models ?? []).map((m) => [m.id, m]));
  const callable = (model: string): boolean => {
    const m = byId.get(model);
    return m !== undefined && !m.blocked;
  };
  const origin = readAppOrigin(env);

  return {
    provider: "openrouter",
    version: "openrouter-2026-11-27",
    connectionFields: ["method", "key_hash"],
    priceSource: ["openrouter-models"],

    async mintCredential(_connection: ConnectionFields, { userId }) {
      const key = await secrets.read(userId, "openrouter", "key");
      if (!key) throw new ProviderRefusal({ step: "vault", status: 401, errorName: "no_key", message: "no OpenRouter key in the vault" });
      return key;
    },

    async call({ credential, model, request, maxPrice }) {
      const body: Record<string, unknown> = { ...(request as Record<string, unknown>), model };
      delete body.models;
      delete body.route;
      // A router's price cap: "The maximum pricing you want to pay for this
      // request. USD price per million tokens, for prompt and completion"
      // (ProviderPreferences.max_price in OpenRouter's live OpenAPI spec, read
      // 2026-11-28; strings, like its prices). Its other fields at "0" leave
      // out any model with a fee per request, per image or per audio unit.
      // It has no field for a search fee, so the auto-router plugin's
      // `excluded_models` ("model patterns to exclude from auto-router
      // selection", AutoRouterPlugin in the same spec) keeps out every listed
      // model whose pricing carries a per-search or per-request fee.
      if (maxPrice) {
        const provider = typeof body.provider === "object" && body.provider !== null ? (body.provider as Record<string, unknown>) : {};
        body.provider = {
          ...provider,
          max_price: { prompt: String(maxPrice.inputUsdPerMTok), completion: String(maxPrice.outputUsdPerMTok), request: "0", image: "0", audio: "0" },
        };
        const fees = catalog?.feeModels ?? [];
        if (fees.length) {
          const others = Array.isArray(body.plugins) ? (body.plugins as unknown[]).filter((p) => (p as { id?: unknown } | null)?.id !== "auto-router") : [];
          body.plugins = [...others, { id: "auto-router", excluded_models: fees }];
        }
      }
      const response = await fetcher(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential as string}`,
          "content-type": "application/json",
          ...(origin ? { "http-referer": `${origin}${BASE_PATH}` } : {}),
          "x-openrouter-title": APP_TITLE,
        },
        body: JSON.stringify(body),
      });
      const reply = await readBody(response);
      const callId = typeof (reply as { id?: unknown } | null)?.id === "string" ? ((reply as { id: string }).id) : undefined;
      // A generation that fails after it started answers 200 with an error in
      // the body ("Otherwise, the returned HTTP response status will be 200").
      const bodyError = (reply as { error?: { code?: unknown } } | null)?.error;
      if (response.ok && bodyError && !(reply as { choices?: unknown }).choices) {
        const status = typeof bodyError.code === "number" && bodyError.code >= 400 ? bodyError.code : 502;
        return { status, body: reply, callId, error: errorFromBody(status, reply) };
      }
      if (!response.ok) return { status: response.status, body: reply, callId, error: errorFromBody(response.status, reply) };
      return { status: response.status, body: reply, callId, usage: usageFromReply(reply, byId.get(model)?.longPromptFrom) };
    },

    connect: {
      guide: {
        name: "OpenRouter",
        short: "OpenRouter",
        steps: [
          "Tap <strong>Connect OpenRouter</strong>.",
          "Sign in on OpenRouter and tap <strong>Authorize</strong>.",
          "Tasks use the Ready models below. No test needed.",
        ],
        about: [
          "OpenRouter gives the app a key for your own account.",
          "The key goes straight into your vault. You never see it.",
          "You pay OpenRouter for your own calls. Nobody else does.",
          "No credit? OpenRouter’s free models still work.",
          "Authorize prefills the key’s limit with your monthly budget here, else $10.",
          "That limit is OpenRouter’s, separate from the app’s budget.",
          "Pick the account or workspace with your credits on OpenRouter’s page.",
        ],
        checkedOn: "2026-11-27",
        pages: [
          link("OpenRouter: OAuth PKCE", "https://openrouter.ai/docs/guides/overview/auth/oauth"),
          link("Models API", "https://openrouter.ai/docs/api-reference/list-available-models"),
          link("Usage accounting", "https://openrouter.ai/docs/use-cases/usage-accounting"),
        ],
        revoke: "only you can, on the key's own page. OpenRouter's delete-a-key API takes only your own management key.",
        revokeLinks: keyLinks,
        accountSettings: link("OpenRouter privacy settings", SETTINGS_PRIVACY),
        credits: link("Add credits", SETTINGS_CREDITS),
        newGrantEachTime:
          "Each Authorize makes a new key: OpenRouter's flow has no way to reuse one. Each is labelled with its date; delete old ones on OpenRouter.",
      },

      async start({ callbackUrl, consentState, creditLimitUsd, now }) {
        const verifier = makeVerifier();
        const url = new URL(OPENROUTER_AUTH_URL);
        url.searchParams.set("callback_url", callbackUrl);
        url.searchParams.set("code_challenge", await challengeOf(verifier));
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("key_label", keyLabelAt(now));
        // "a positive amount below 1,000,000 with at most two decimal places".
        url.searchParams.set("limit", (Math.min(999_999.99, Math.max(0.01, Math.round(creditLimitUsd * 100) / 100))).toFixed(2));
        url.searchParams.set("state", consentState);
        return { open: url.toString(), verifier };
      },

      async finish(verifier, returned) {
        const code = returned.get("code");
        if (!code) throw new ConnectProblem("OpenRouter sent you back without an authorization. Tap Connect OpenRouter again, and tap Authorize on OpenRouter's page.");
        let response: Response;
        try {
          response = await fetcher(OPENROUTER_KEYS_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
          });
        } catch {
          throw new ConnectProblem("OpenRouter did not answer while connecting. Tap Connect OpenRouter again.");
        }
        const body = (await readBody(response)) as { key?: unknown } | string;
        const key = typeof body === "object" && body && typeof body.key === "string" ? body.key.trim() : "";
        if (!response.ok || !key) {
          // Never the body itself: on success it would hold the key.
          const said = response.ok ? "it sent no key" : `${response.status} ${errorFromBody(response.status, body).message}`.trim();
          throw new ConnectProblem(`OpenRouter did not accept that authorization (${said}). Codes last 10 minutes: tap Connect OpenRouter again.`);
        }
        return { fields: { method: "oauth_pkce", key_hash: await sha256Hex(key) }, secret: key };
      },

      canCall: callable,
      notCallableReason: (model) => byId.get(model)?.blocked ?? "OpenRouter no longer lists it",
      isRouter: (model) => byId.get(model)?.router === true,
      searchFee: (model) => byId.get(model)?.searchFeeUsd,
      noToolUse: (model) => (callable(model) && !byId.get(model)!.tools ? "OpenRouter lists no tool support for it" : undefined),
      modelNotes: (model) => {
        const m = byId.get(model);
        if (!m) return [];
        return [
          ...(m.expires ? [`OpenRouter retires it on ${m.expires}`] : []),
          ...(m.longPromptFrom ? [`priced higher from ${m.longPromptFrom.toLocaleString("en-US")} prompt tokens`] : []),
        ];
      },
      async readAccountModels(credential) {
        const response = await fetcher(OPENROUTER_USER_MODELS_URL, { headers: { authorization: `Bearer ${credential as string}`, accept: "application/json" } });
        const body = await readBody(response);
        if (!response.ok) {
          const e = errorFromBody(response.status, body);
          throw new ProviderRefusal({ step: "models/user", status: response.status, errorName: e.name, message: e.message });
        }
        const data = (body as { data?: unknown } | null)?.data;
        if (!Array.isArray(data)) throw new ProviderRefusal({ step: "models/user", status: response.status, errorName: "no_list", message: "the reply held no model list" });
        return data.flatMap((m) => {
          const id = (m as { id?: unknown } | null)?.id;
          return typeof id === "string" && id ? [id] : [];
        });
      },
      async readAccount(credential) {
        try {
          const response = await fetcher(OPENROUTER_KEY_URL, { headers: { authorization: `Bearer ${credential as string}`, accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
          return response.ok ? accountOf(await readBody(response)) : undefined;
        } catch {
          return undefined;
        }
      },
      freeModelTerms: { text: `${FREE_LIMITS_TEXT} ${FREE_PRIVACY_TEXT}`, links: FREE_TERMS_LINKS },
      replyModel: (body) => {
        const model = (body as { model?: unknown } | null)?.model;
        return typeof model === "string" && model ? model : undefined;
      },
      locations: () => ["global"],
      testRequest: () => promptRequest(TEST_PROMPT, TEST_MAX_TOKENS),
      promptRequest,
      replyText,
      classify,
    },
  };
}
