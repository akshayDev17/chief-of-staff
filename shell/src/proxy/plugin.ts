// The provider plug-in interface (design-v3 1.4). The proxy core knows no
// provider: each provider is one plug-in, and the core only calls these two
// functions and reads these fields. T16 writes the three real plug-ins
// (Foundry, Bedrock, Vertex AI) and the app's OpenID Connect issuer they mint
// from; test/test-plugin.ts is the test-only one that exercises the core.

import type { Provider } from "../prices/types";

// A connection's fields, exactly as the plug-in's Connect method stored them.
// For the three v1 providers none of them is secret.
export type ConnectionFields = Record<string, string>;

// The provider's own usage figures from its reply. The five counts are
// disjoint: `input` is uncached input only, as Claude's API reports it; a
// plug-in whose provider reports total input subtracts the cached part.
// `cacheWrite` is written to the 5-minute cache, `cacheWrite1h` to the
// 1-hour one. `longPrompt` is true when the provider billed the call at its
// long-prompt (long-context) rates, so every token is costed at those rows.
export interface Usage {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  longPrompt: boolean;
}

// What one call to the provider returned. `body` is handed back to the
// caller untouched and never logged or stored.
export interface ProviderReply {
  status: number;
  body: unknown;
  // Present when the provider answered and reported its usage (status 2xx).
  usage?: Usage;
}

// The model request as the agent sent it, in the provider's own format.
// The core never reads it.
export type ModelRequest = unknown;

export interface ProviderPlugin {
  provider: Provider;
  // Recorded on every ledger row: each plug-in tracks a different vendor API.
  version: string;
  // The only fields a connection to this provider may hold. Anything else
  // offered to writeConnection is refused, so no secret can be stored there.
  connectionFields: readonly string[];
  // A short-lived credential minted from the user's connection (about an
  // hour). It lives only in memory for one call: never stored, never logged.
  mintCredential(connection: ConnectionFields): Promise<unknown>;
  // The provider's own request, sent straight to the user's own provider.
  call(input: { credential: unknown; connection: ConnectionFields; model: string; location: string; request: ModelRequest }): Promise<ProviderReply>;
}

export type PluginRegistry = Partial<Record<Provider, ProviderPlugin>>;

// A provider refusal the task's fallback answers: rate limited or overloaded
// (429 and the like), or the provider failing (5xx). Any other status is the
// request's own fault and another provider would refuse it too.
export const fallbackAnswers = (status: number): boolean => status === 408 || status === 429 || status >= 500;
