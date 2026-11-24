// The test-only provider plug-in: it exercises the proxy core with no
// network. It stands in for any provider id, mints a credential that looks
// like a secret (so tests can check it is never stored or logged), and
// answers each call from a queue of scripted replies.
import { env } from "cloudflare:test";
import type { ConnectionFields, ProviderPlugin, ProviderReply } from "../src/proxy/plugin";
import { writeSnapshot } from "../src/prices/store";
import type { PriceRow, Provider } from "../src/prices/types";
import { userFromAccess } from "../src/users";

export interface TestPlugin extends ProviderPlugin {
  replies: Array<ProviderReply | Error>;
  calls: Array<{ credential: unknown; model: string; location: string; request: unknown }>;
  minted: string[];
}

export const testPlugin = (provider: Provider, opts: { failMint?: boolean } = {}): TestPlugin => {
  const plugin: TestPlugin = {
    provider,
    version: `test-${provider}-1`,
    connectionFields: ["account", "region"],
    replies: [],
    calls: [],
    minted: [],
    async mintCredential(connection: ConnectionFields) {
      if (opts.failMint) throw new Error(`grant revoked for ${connection.account}`);
      const credential = `minted-secret-${provider}-${crypto.randomUUID()}`;
      plugin.minted.push(credential);
      return credential;
    },
    async call(input) {
      plugin.calls.push({ credential: input.credential, model: input.model, location: input.location, request: input.request });
      const next = plugin.replies.shift() ?? ok({ input: 1000, cachedInput: 0, cacheWrite: 0, output: 100 });
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return plugin;
};

export const ok = (usage: ProviderReply["usage"], body: unknown = { reply: "a test reply" }): ProviderReply => ({ status: 200, body, usage });
export const refused = (status: number, body: unknown = { error: "ThrottlingException" }): ProviderReply => ({ status, body });

export const userFor = async (sub: string) => {
  const user = await userFromAccess(env.DB, { sub, email: `${sub}@example.com`, iss: "", aud: "", exp: 0 }, new Date());
  return user!;
};

const row = (provider: Provider, model: string, tokenKind: PriceRow["tokenKind"], usdPerMTok: number): PriceRow => ({
  provider, model, deployment: "global", region: "global", tokenKind, longPrompt: false, batch: false, usdPerMTok,
  source: "maintainer-read", dateRead: "2026-11-24", stale: false, disagreement: false,
});

// Two priced models, one per provider, and one model with no price at all.
export const seedPrices = () =>
  writeSnapshot(env.DB, {
    takenAt: "2026-11-24T06:00:00Z",
    status: "good",
    results: [],
    rows: [
      row("bedrock", "test-sonnet", "input", 3),
      row("bedrock", "test-sonnet", "cached_input", 0.3),
      row("bedrock", "test-sonnet", "cache_write", 3.75),
      row("bedrock", "test-sonnet", "output", 15),
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
