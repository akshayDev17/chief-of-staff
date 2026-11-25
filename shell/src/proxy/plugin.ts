// The provider plug-in interface (design-v3 1.4). The proxy core knows no
// provider: each provider is one plug-in, and the core only calls these two
// functions and reads these fields. A plug-in has three parts: its Connect
// method (`connect`: the non-secret fields, the setup link, the test call and
// the plain reasons for its refusals), its caller (`mintCredential` and
// `call`) and its price source (`priceSource`). The three real plug-ins are
// in src/providers/ (T16), minting from the app's own OpenID Connect issuer
// (src/issuer.ts); test/test-plugin.ts is the test-only one. Adding a
// provider is one plug-in: Models › Setup › Providers shows a "Connect
// <Provider>" button for every registered plug-in.

import type { Provider, SourceId } from "../prices/types";

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
  // On a refusal: the provider's own error name and message, read from its
  // reply, for the test call's second line. Never logged or stored by the core.
  error?: { name: string; message: string };
}

// The provider refused to give a credential (an AWS role that cannot be
// assumed, a Microsoft tenant without consent, a Google grant removed), in
// its own words. `step` names the exchange, such as "AssumeRole".
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
// (a consent page refused, a field the provider would not accept).
export class ConnectProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectProblem";
  }
}

// What the user sees, each a plain sentence; the mapping from each vendor's
// own errors to these stays in the plug-in (`connect.classify`) and is never
// shown as a table (design-v3 1.5).
export type PlainReason =
  | "not_set_up" // the connection isn't set up yet, or was removed
  | "not_allowed_yet" // your account isn't allowed to use this model yet
  | "switching_on" // the provider is still switching the model on: retried every 15 minutes
  | "no_such_model" // that deployment name or model ID doesn't exist here
  | "region_unavailable" // this region doesn't offer that model
  | "no_permission" // your provider account lacks permission
  | "data_retention" // your subscription blocks data retention this model needs
  | "busy" // busy or out of quota, not a setup fault
  | "app_not_configured" // the app's own side is not set up yet (the owner's one-time steps)
  | "no_reply" // the provider did not answer
  | "refused"; // any other refusal: the provider's own words say why

// One failed step of a test call, in the provider's own words.
export interface Failure {
  // `credential`: minting the credential; `call`: the test call itself.
  step: "credential" | "call";
  // The credential exchange that refused, such as "AssumeRole".
  exchange?: string;
  status: number;
  errorName: string;
  message: string;
}

export interface Link {
  label: string;
  href: string;
}

export interface ConnectField {
  name: string;
  label: string;
  placeholder: string;
  // The whole value must match (anchored), else `problem` is shown.
  pattern: string;
  problem: string;
}

// What tapping "Connect <Provider>" leads to: the connection record at once
// (and, for Bedrock, the AWS page to open), or a provider page that comes
// back under /models/setup/providers/<id>/ (Foundry: Microsoft's sign-in, at
// `signed-in`, which proves the user's tenant, then its admin consent in that
// tenant, at `consented`). `pending` is what the plug-in keeps until then, on
// the user's own check row; it is not secret, and it alone says which page
// the answer is from.
export type ConnectStart =
  | { kind: "connection"; fields: ConnectionFields; open?: string }
  | { kind: "consent"; pending: Record<string, string>; open: string };

export interface Guide {
  // "Amazon Bedrock": the button reads "Connect Amazon Bedrock".
  name: string;
  // "Bedrock", in "Bedrock replied:".
  short: string;
  // "AWS", in "AWS is still switching this on".
  vendor: string;
  recommendedForFriends: boolean;
  // Each step, as trusted HTML written in the plug-in.
  steps: string[];
  // The vendor pages the guide was checked against, and the date.
  checkedOn: string;
  pages: Link[];
  // How to remove the grant on the provider's side.
  revoke: string;
  // The Region line and its Change control; false where the region is set
  // when the user deploys the model on the provider's side (Foundry).
  regionChoice: boolean;
}

export interface ConnectMethod {
  guide: Guide;
  // The non-secret fields the user types. None is ever a key.
  fields: readonly ConnectField[];
  // From the typed fields to the record (or the first provider page).
  // `consentState` is the value that page must return.
  // `existing` is the record already stored, if any, so a second tap keeps
  // what the provider side was set up with (Bedrock's external ID).
  start(
    typed: Record<string, string>,
    context: { userId: string; appOrigin: string; consentState: string; existing?: ConnectionFields },
  ): ConnectStart;
  // Back from a provider page, with the pending fields it was sent with: the
  // record, or the next provider page (with a fresh `consentState`, the old
  // one being spent). Throws a ConnectProblem, with a plain message, when the
  // page refused or its answer cannot be trusted.
  finish?(pending: Record<string, string>, returned: URLSearchParams, context: { appOrigin: string; consentState: string }): Promise<ConnectStart>;
  // What the user needs to make the grant, as trusted HTML, shown beside the
  // fields and, once connected, until the test call passes (Vertex AI: the
  // user's own Google identity and the role command for the stored project).
  grantHelp?(context: { userId: string; connection?: ConnectionFields }): string;
  // The setup link again, for a record already stored (Bedrock's stack).
  setupLink?(connection: ConnectionFields): string | undefined;
  // The test call's model when the user has picked none at this provider,
  // as the price table names it.
  testModel: string;
  // The models the plug-in knows by the price table's names, offered on Add
  // a model (T17) even while the table has no price for them ("no price yet").
  knownModels: readonly string[];
  // Whether the plug-in can call the model: it knows the provider's own ID
  // for it and speaks its format. Add a model offers no other.
  canCall(model: string): boolean;
  // Foundry only: the deployment name the guide asks the user to keep, the
  // model's ID, filled in on Add a model and changed by a user who named the
  // deployment differently; undefined for a model it cannot call. Absent
  // where the provider names the model itself.
  deploymentName?(model: string): string | undefined;
  // The model a reply says answered, in the provider's own words, where the
  // reply names one (Messages `model`, Chat Completions `model`, Gemini
  // `modelVersion`); undefined where it does not (Bedrock's Converse).
  replyModel(body: unknown): string | undefined;
  // The locations the plug-in can call `model` at, the app's default first.
  locations(model: string): string[];
  locationLabel(location: string): string;
  // The provider's own name for the model at that location, as its reply shows it.
  modelId(model: string, location: string): string;
  // The test call: the smallest request that proves the connection.
  testRequest(model: string, location: string): ModelRequest;
  // The text of a passed test call's reply ("OK").
  replyText(body: unknown): string | undefined;
  // The plain reason for a failure, and its fix with the pages to open.
  classify(failure: Failure, connection: ConnectionFields | undefined): { reason: PlainReason; fix: string; links: Link[] };
  // The version of the provider-side assets the user's grant was made with
  // (Bedrock: the template version in the user's own stack), when it can be read.
  readSetupVersion?(credential: unknown, connection: ConnectionFields): Promise<string | undefined>;
}

export interface ProviderPlugin {
  provider: Provider;
  // Recorded on every ledger row: each plug-in tracks a different vendor API.
  version: string;
  // The only fields a connection to this provider may hold. Anything else
  // offered to writeConnection is refused, so no secret can be stored there.
  connectionFields: readonly string[];
  // A short-lived credential minted from the user's connection (about an
  // hour), for that user alone: `userId` is the signed-in user whose record
  // it is (Vertex AI mints that user's own Google identity). It lives only in
  // memory for one call: never stored, never logged.
  mintCredential(connection: ConnectionFields, context: { userId: string }): Promise<unknown>;
  // The provider's own request, sent straight to the user's own provider.
  // `deployment` is Foundry's deployment name for the model, when the user set one.
  call(input: { credential: unknown; connection: ConnectionFields; model: string; location: string; deployment?: string; request: ModelRequest }): Promise<ProviderReply>;
  // The price source the proxy prices this provider's calls from (T11).
  priceSource: readonly SourceId[];
  connect: ConnectMethod;
}

export type PluginRegistry = Partial<Record<Provider, ProviderPlugin>>;

// A provider refusal the task's fallback answers: rate limited or overloaded
// (429 and the like), or the provider failing (5xx). Any other status is the
// request's own fault and another provider would refuse it too.
export const fallbackAnswers = (status: number): boolean => status === 408 || status === 429 || status >= 500;
