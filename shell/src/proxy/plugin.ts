// The provider plug-in interface (design-v3 1.4). The proxy core knows no
// provider: each provider is one plug-in, and the core only calls these two
// functions and reads these fields. A plug-in has three parts: its Connect
// method (`connect`: the provider's own consent page, the test call and the
// plain reasons for its refusals), its caller (`mintCredential` and `call`)
// and its price source (`priceSource`). The one real plug-in is OpenRouter's
// (src/providers/openrouter.ts); test/test-plugin.ts is the test-only one.
// Adding a provider is one plug-in: Models › Setup › Providers shows a
// "Connect <Provider>" button for every registered plug-in.
//
// No user ever gives (pastes) a key. Connect sends the user to the
// provider's own page, where they sign in and authorize the app; the provider
// then issues the app a key for that user's own account (OpenRouter's OAuth
// PKCE). That key is the connection's one secret: it goes into the user's
// vault (src/providers/secrets.ts), never into the connection record, and is
// never shown, logged or sent to the browser.

import type { Provider, SourceId } from "../prices/types";

// A connection's fields, exactly as the plug-in's Connect method returned
// them. None of them is secret.
export type ConnectionFields = Record<string, string>;

// The provider's own usage figures from its reply. The five counts are
// disjoint: `input` is uncached input only; a plug-in whose provider reports
// total input subtracts the cached part and the cache writes. `cacheWrite` is
// written to the 5-minute cache, `cacheWrite1h` to the 1-hour one.
// `longPrompt` is true when the call is priced at the model's long-prompt
// rates. `reportedCostUsd` is the cost the provider's reply itself reports,
// what the user is billed for the call, when it reports one.
export interface Usage {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  longPrompt: boolean;
  reportedCostUsd?: number;
}

// What one call to the provider returned. `body` is handed back to the
// caller untouched and never logged or stored.
export interface ProviderReply {
  status: number;
  body: unknown;
  // Present when the provider answered and reported its usage (status 2xx).
  usage?: Usage;
  // The provider's own ID for the call (OpenRouter's generation ID), kept on
  // the ledger row so the call can be found in the provider's own records.
  callId?: string;
  // On a refusal: the provider's own error name and message, read from its
  // reply, for the test call's second line. Never logged or stored by the core.
  error?: { name: string; message: string };
}

// The provider refused to give a credential (no key in the vault, a key the
// provider no longer accepts), in its own words. `step` names the exchange.
export class ProviderRefusal extends Error {
  constructor(readonly refusal: { step: string; status: number; errorName: string; message: string }) {
    super(`${refusal.step}: ${refusal.status} ${refusal.errorName}`);
    this.name = "ProviderRefusal";
  }
}

// The model request as the agent sent it, in the provider's own format.
// The core never reads it.
export type ModelRequest = unknown;

// A Connect step that cannot go on, with the plain sentence the screen shows
// (the consent page refused, an answer that cannot be trusted).
export class ConnectProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectProblem";
  }
}

// What the user sees, each a plain sentence; the mapping from the provider's
// own errors to these stays in the plug-in (`connect.classify`) and is never
// shown as a table (design-v3 1.5).
export type PlainReason =
  | "not_set_up" // the connection isn't set up yet, or was removed
  | "no_credits" // the provider account or this key is out of credits
  | "no_such_model" // that model ID doesn't exist here
  | "no_permission" // the provider refused this request (moderation, a guardrail, a data policy)
  | "busy" // busy or out of quota, not a setup fault
  | "app_not_configured" // the app's own side is not set up yet (the owner's one-time steps)
  | "no_reply" // the provider did not answer
  | "refused"; // any other refusal: the provider's own words say why

// One failed step of a test call, in the provider's own words.
export interface Failure {
  // `credential`: getting the credential; `call`: the test call itself.
  step: "credential" | "call";
  // The credential exchange that refused.
  exchange?: string;
  status: number;
  errorName: string;
  message: string;
}

// The account behind the user's key, as the provider reports it, read live
// with that key (OpenRouter's GET /api/v1/key). Shown as the Connect panel's
// account line, so the user sees why paid calls are refused.
export interface AccountInfo {
  // The account has never bought credit (OpenRouter's `is_free_tier`).
  freeTier: boolean;
  // The key's label on the provider, as saved there.
  label?: string;
  // Who owns the key: the user's own account, or an organization (its ID).
  organizationId?: string;
  // The workspace the key spends in, when the provider names one.
  workspaceId?: string;
  // The key's own credit limit and what is left of it; absent: no limit.
  limitUsd?: number;
  limitRemainingUsd?: number;
  limitReset?: string;
  // What the key has spent, in all and this UTC month.
  usageUsd: number;
  usageMonthlyUsd?: number;
  // The account's free-model requests today, when the provider reports them.
  freeDaily?: { used: number; limit: number; remaining: number };
}

export interface Link {
  label: string;
  href: string;
}

export interface Guide {
  // "OpenRouter": the button reads "Connect OpenRouter".
  name: string;
  // "OpenRouter", in "OpenRouter replied:".
  short: string;
  // The action lines, each a short sentence of trusted HTML written in the
  // plug-in; the rest goes in `about`, shown collapsed under "What this does".
  steps: string[];
  about: string[];
  // The provider pages the guide was checked against, and the date.
  checkedOn: string;
  pages: Link[];
  // How to remove the grant on the provider's side, as a plain sentence.
  revoke: string;
  // The provider's own pages for that, for a stored connection, the
  // general page first and the connection's own last.
  revokeLinks(connection: ConnectionFields | undefined): Link[];
  // Why Connect again makes a new grant rather than reusing the last one, as
  // a plain sentence; shown collapsed under Connect.
  newGrantEachTime?: string;
}

// Where "Connect <Provider>" sends the user, and the one secret the app keeps
// until the provider sends them back (the PKCE verifier, kept in the vault).
export interface ConnectStart {
  open: string;
  verifier: string;
}

export interface ConnectMethod {
  guide: Guide;
  // The provider's consent page to open. `consentState` is the value it must
  // return; `callbackUrl` is where it returns to; `creditLimitUsd` is the
  // limit to prefill on the key the provider issues, which the user can
  // change there; `now` is when the user tapped Connect.
  start(context: { callbackUrl: string; consentState: string; creditLimitUsd: number; now: Date }): Promise<ConnectStart>;
  // Back from the consent page, with the verifier `start` made: the
  // connection's non-secret fields and the key the provider issued. Throws a
  // ConnectProblem, with a plain message, when the page refused or its answer
  // cannot be trusted.
  finish(verifier: string, returned: URLSearchParams): Promise<{ fields: ConnectionFields; secret: string }>;
  // Whether the plug-in can call the model: the provider still lists it.
  // A model the user added that the provider has dropped is shown as "not
  // offered yet" with `notCallableReason`, never picked.
  canCall(model: string): boolean;
  // Why `model`, which the plug-in cannot call, is not offered, in plain
  // words after "not offered yet: ".
  notCallableReason(model: string): string;
  // For a model the provider lists no tool support for, why ("OpenRouter
  // lists no tool support for it"), shown in the model list; the per-task
  // picker marks the model too. Undefined: no such fault is known.
  noToolUse?(model: string): string | undefined;
  // Plain notes for the model list's entry ("OpenRouter retires it on …").
  modelNotes?(model: string): string[];
  // The IDs of the models the user's own provider account offers, live,
  // read with the user's credential (OpenRouter's /models/user honours the
  // account's provider preferences, privacy settings and guardrails). Throws
  // a ProviderRefusal when the provider refuses or sends no list.
  readAccountModels(credential: unknown): Promise<string[]>;
  // The account behind the credential, read live; undefined when it cannot be read.
  readAccount?(credential: unknown): Promise<AccountInfo | undefined>;
  // The provider's own conditions on its free models, in plain words with the
  // pages that state them, shown wherever free models are offered.
  freeModelTerms?: { text: string; links: Link[] };
  // The model a reply says answered, in the provider's own words, where the
  // reply names one.
  replyModel(body: unknown): string | undefined;
  // The locations the plug-in can call `model` at, the app's default first
  // (`global` for OpenRouter, which routes each call itself).
  locations(model: string): string[];
  // The test call: the smallest request that proves the connection.
  testRequest(model: string): ModelRequest;
  // The text of a passed test call's reply ("OK").
  replyText(body: unknown): string | undefined;
  // The plain reason for a failure, and its fix with the pages to open.
  classify(failure: Failure, connection: ConnectionFields | undefined): { reason: PlainReason; fix: string; links: Link[] };
}

export interface ProviderPlugin {
  provider: Provider;
  // Recorded on every ledger row: each plug-in tracks a different vendor API.
  version: string;
  // The only fields a connection to this provider may hold. Anything else
  // offered to writeConnection is refused, so no secret can be stored there.
  connectionFields: readonly string[];
  // The credential for one call, from the user's connection and vault, for
  // that user alone (`userId` is the signed-in user whose record it is). It
  // lives only in memory for one call: never stored again, never logged.
  mintCredential(connection: ConnectionFields, context: { userId: string }): Promise<unknown>;
  // The provider's own request, sent straight to the provider for the user.
  call(input: { credential: unknown; connection: ConnectionFields; model: string; location: string; request: ModelRequest }): Promise<ProviderReply>;
  // The price source the proxy prices this provider's calls from (T11).
  priceSource: readonly SourceId[];
  connect: ConnectMethod;
}

export type PluginRegistry = Partial<Record<Provider, ProviderPlugin>>;

// A provider refusal the task's fallback answers: rate limited or overloaded
// (429 and the like), or the provider failing (5xx). Any other status is the
// request's own fault, or the account's (no credits, a removed key), and
// another model would be refused too.
export const fallbackAnswers = (status: number): boolean => status === 408 || status === 429 || status >= 500;
