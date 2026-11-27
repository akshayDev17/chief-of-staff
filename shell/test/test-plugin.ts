// The test-only provider plug-in: it exercises the proxy core with no
// network. It stands in for OpenRouter's provider id, mints a credential that
// looks like a secret (so tests can check it is never stored or logged), and
// answers each call from a queue of scripted replies.
import { env } from "cloudflare:test";
import { ConnectProblem, ProviderRefusal, type ConnectionFields, type ProviderPlugin, type ProviderReply, type Usage } from "../src/proxy/plugin";
import { vaultSecrets, type SecretStore } from "../src/providers/secrets";
import { writeSnapshot } from "../src/prices/store";
import { CATALOG_VERSION, type OpenRouterCatalog } from "../src/prices/openrouter";
import type { PriceRow, Provider } from "../src/prices/types";
import { userFromAccess } from "../src/users";

export interface TestPlugin extends ProviderPlugin {
  replies: Array<ProviderReply | Error>;
  calls: Array<{ credential: unknown; model: string; location: string; request: unknown }>;
  minted: string[];
}

// Made per run; no real key is ever in the repository.
export const VAULT_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
export const testSecrets = (): SecretStore => vaultSecrets(env.DB, { VAULT_KEY });

export const testPlugin = (provider: Provider = "openrouter", opts: { failMint?: boolean; refuseMint?: boolean; cannotCall?: string[] } = {}): TestPlugin => {
  const plugin: TestPlugin = {
    provider,
    version: `test-${provider}-1`,
    connectionFields: ["method", "key_hash"],
    priceSource: ["openrouter-models"],
    connect: {
      guide: {
        name: `Test ${provider}`, short: provider, steps: [], about: [], checkedOn: "2026-11-27", pages: [],
        revoke: "delete the test key.", revokeLinks: () => [{ label: "Your keys", href: "https://example.com/keys" }],
      },
      start: async ({ callbackUrl, consentState, creditLimitUsd }) => ({
        open: `https://consent.example.com/auth?callback_url=${encodeURIComponent(callbackUrl)}&state=${consentState}&limit=${creditLimitUsd}`,
        verifier: `verifier-${consentState}`,
      }),
      finish: async (verifier, returned) => {
        if (returned.get("code") !== `code-for-${verifier}`) throw new ConnectProblem("That authorization was refused.");
        return { fields: { method: "oauth_pkce", key_hash: "a".repeat(64) }, secret: `issued-key-${verifier}` };
      },
      // The account's live list: the seeded models.
      readAccountModels: async () => ["test-luna", "test-mini", "test-sonnet"],
      canCall: (m) => !opts.cannotCall?.includes(m),
      notCallableReason: () => "the test plug-in cannot call it",
      replyModel: (body) => {
        const model = (body as { model?: unknown } | null)?.model;
        return typeof model === "string" ? model : undefined;
      },
      locations: () => ["global"],
      testRequest: () => ({ prompt: "test" }),
      replyText: () => "OK",
      classify: (f) => ({ reason: f.step === "credential" || f.status === 401 ? "not_set_up" : f.status === 429 ? "busy" : f.status === 402 ? "no_credits" : "refused", fix: "", links: [] }),
    },
    replies: [],
    calls: [],
    minted: [],
    async mintCredential(connection: ConnectionFields) {
      if (opts.failMint) throw new Error(`grant revoked for ${connection.key_hash}`);
      if (opts.refuseMint) throw new ProviderRefusal({ step: "vault", status: 401, errorName: "no_key", message: "no key" });
      const credential = `minted-secret-${provider}-${crypto.randomUUID()}`;
      plugin.minted.push(credential);
      return credential;
    },
    async call(input) {
      plugin.calls.push({ credential: input.credential, model: input.model, location: input.location, request: input.request });
      const next = plugin.replies.shift() ?? ok({ input: 1000, output: 100 });
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return plugin;
};

export const ok = (usage: Partial<Usage>, body: unknown = { reply: "a test reply" }): ProviderReply => ({
  status: 200,
  body,
  usage: { input: 0, cachedInput: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, longPrompt: false, ...usage },
});
export const refused = (status: number, body: unknown = { error: { code: status, message: "Rate limited" } }): ProviderReply => ({ status, body, error: { name: `HTTP ${status}`, message: "Rate limited" } });

export const userFor = async (sub: string) => {
  const user = await userFromAccess(env.DB, { sub, email: `${sub}@example.com`, iss: "", aud: "", exp: 0 }, new Date());
  return user!;
};

export const row = (model: string, tokenKind: PriceRow["tokenKind"], usdPerMTok: number, longPrompt = false): PriceRow => ({
  provider: "openrouter", model, deployment: "global", region: "global", tokenKind, longPrompt, batch: false, usdPerMTok,
  source: "openrouter-models", dateRead: "2026-11-27", stale: false, disagreement: false,
});

// Three priced models and a catalog naming them and one the app cannot call.
// test-sonnet lists every kind at short- and long-prompt rates but has no
// long-prompt 1-hour cache write; test-luna and test-mini list only input and
// output.
export const TEST_CATALOG: OpenRouterCatalog = {
  version: CATALOG_VERSION,
  readAt: "2026-11-27T06:00:00.000Z",
  models: [
    { id: "openrouter/auto", name: "Auto router", blocked: "OpenRouter prices it by the model it picks for each call, so the budget stop has no price", tools: false },
    { id: "test-luna", name: "Test Luna", tools: true },
    { id: "test-mini", name: "Test Mini", tools: false },
    { id: "test-sonnet", name: "Test Sonnet", tools: true, longPromptFrom: 200_000 },
  ],
};

export const seedPrices = () =>
  writeSnapshot(env.DB, {
    takenAt: "2026-11-27T06:00:00Z",
    status: "good",
    results: [],
    catalog: TEST_CATALOG,
    rows: [
      row("test-sonnet", "input", 3),
      row("test-sonnet", "cached_input", 0.3),
      row("test-sonnet", "cache_write", 3.75),
      row("test-sonnet", "cache_write_1h", 6),
      row("test-sonnet", "output", 15),
      row("test-sonnet", "input", 6, true),
      row("test-sonnet", "cached_input", 0.6, true),
      row("test-sonnet", "cache_write", 7.5, true),
      row("test-sonnet", "output", 22.5, true),
      row("test-luna", "input", 0.1),
      row("test-luna", "output", 0.5),
      row("test-mini", "input", 0.25),
      row("test-mini", "output", 1),
    ],
  });

// Every row of every table, for checks that something is stored nowhere.
export async function dumpEveryTable(): Promise<Record<string, unknown[]>> {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  const dump: Record<string, unknown[]> = {};
  for (const { name } of tables) dump[name] = (await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results;
  return dump;
}
