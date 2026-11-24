// The test-only provider plug-in: it exercises the proxy core with no
// network. It stands in for any provider id, mints a credential that looks
// like a secret (so tests can check it is never stored or logged), and
// answers each call from a queue of scripted replies.
import { env } from "cloudflare:test";
import { ProviderRefusal, type ConnectionFields, type ProviderPlugin, type ProviderReply, type Usage } from "../src/proxy/plugin";
import { writeSnapshot } from "../src/prices/store";
import type { PriceRow, Provider } from "../src/prices/types";
import { userFromAccess } from "../src/users";

export interface TestPlugin extends ProviderPlugin {
  replies: Array<ProviderReply | Error>;
  calls: Array<{ credential: unknown; model: string; location: string; deployment?: string; request: unknown }>;
  minted: string[];
}

export const testPlugin = (provider: Provider, opts: { failMint?: boolean; refuseMint?: boolean } = {}): TestPlugin => {
  const plugin: TestPlugin = {
    provider,
    version: `test-${provider}-1`,
    connectionFields: ["account", "region"],
    priceSource: ["maintainer-read"],
    connect: {
      guide: {
        name: `Test ${provider}`, short: provider, vendor: provider, recommendedForFriends: false, steps: [], checkedOn: "2026-11-25",
        pages: [], revoke: "remove the test grant.", regionChoice: true,
      },
      fields: [{ name: "account", label: "Account", placeholder: "123456789012", pattern: "\\d{12}", problem: "12 digits." }],
      start: (typed) => ({ kind: "connection", fields: { account: typed.account!, region: "global" } }),
      testModel: provider === "vertex" ? "test-gemini" : "test-sonnet",
      knownModels: [],
      canCall: () => true,
      replyModel: (body) => {
        const model = (body as { model?: unknown } | null)?.model;
        return typeof model === "string" ? model : undefined;
      },
      locations: () => ["global"],
      locationLabel: (l) => l,
      modelId: (m) => m,
      testRequest: () => ({ prompt: "test" }),
      replyText: () => "OK",
      classify: (f) => ({ reason: f.step === "credential" || f.status === 403 ? "not_set_up" : f.status === 429 ? "busy" : "refused", fix: "", links: [] }),
    },
    replies: [],
    calls: [],
    minted: [],
    async mintCredential(connection: ConnectionFields) {
      if (opts.failMint) throw new Error(`grant revoked for ${connection.account}`);
      if (opts.refuseMint) throw new ProviderRefusal({ step: "AssumeRole", status: 403, errorName: "AccessDenied", message: `not authorized for ${connection.account}` });
      const credential = `minted-secret-${provider}-${crypto.randomUUID()}`;
      plugin.minted.push(credential);
      return credential;
    },
    async call(input) {
      plugin.calls.push({ credential: input.credential, model: input.model, location: input.location, deployment: input.deployment, request: input.request });
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
export const refused = (status: number, body: unknown = { error: "ThrottlingException" }): ProviderReply => ({ status, body });

export const userFor = async (sub: string) => {
  const user = await userFromAccess(env.DB, { sub, email: `${sub}@example.com`, iss: "", aud: "", exp: 0 }, new Date());
  return user!;
};

const row = (provider: Provider, model: string, tokenKind: PriceRow["tokenKind"], usdPerMTok: number, longPrompt = false): PriceRow => ({
  provider, model, deployment: "global", region: "global", tokenKind, longPrompt, batch: false, usdPerMTok,
  source: "maintainer-read", dateRead: "2026-11-24", stale: false, disagreement: false,
});

// Two priced models, one per provider, and one model with no price at all.
// test-sonnet lists every kind at short- and long-prompt rates but has no
// long-prompt 1-hour cache write; test-gemini lists only input and output.
export const seedPrices = () =>
  writeSnapshot(env.DB, {
    takenAt: "2026-11-24T06:00:00Z",
    status: "good",
    results: [],
    rows: [
      row("bedrock", "test-sonnet", "input", 3),
      row("bedrock", "test-sonnet", "cached_input", 0.3),
      row("bedrock", "test-sonnet", "cache_write", 3.75),
      row("bedrock", "test-sonnet", "cache_write_1h", 6),
      row("bedrock", "test-sonnet", "output", 15),
      row("bedrock", "test-sonnet", "input", 6, true),
      row("bedrock", "test-sonnet", "cached_input", 0.6, true),
      row("bedrock", "test-sonnet", "cache_write", 7.5, true),
      row("bedrock", "test-sonnet", "output", 22.5, true),
      row("vertex", "test-gemini", "input", 0.25),
      row("vertex", "test-gemini", "output", 1),
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
