// Choosing a model (design-v3 1.5, T17): on each provider's Connect screen
// (providers/models-panel.ts), the user picks a model from the app's list of
// every chat model a connected provider sells at a listed price, and the
// model's test call runs once. The model is added only when that
// call passes.
//
//   listOffer(db, plugins, userId, provider) -> OfferRow[]
//   addModel(db, plugins, { userId, provider, model, deployment?, now }) -> AddOutcome
//   readUserModels(db, userId) -> UserModel[]     what T18's picker offers
//
// Each row of the list carries the model's list price at the location the
// app calls it (the region the user chose on Providers where the model is
// offered there, else the app's default for it), the source and date read,
// and its tier from that price (lookupTier, T11). A model the plug-in knows
// but the table has no input and output price for shows "no price yet" and
// cannot be added, because the budget stop needs a real price; the proxy
// refuses a call to it too.
//
// The test call goes through the proxy's one pipeline (`sendTestCall`), which
// prices it and writes its ledger row. Where the reply names its model, a
// reply naming another model than the one picked is refused with a plain
// reason, and nothing is added.

import { lookupTier } from "../prices/lookup";
import type { Tier } from "../prices/tiers";
import { currentSnapshot } from "../prices/store";
import type { Provider, SourceId } from "../prices/types";
import { readCheck, refreshSetupVersion } from "../providers/check";
import { readConnection } from "../proxy/connections";
import type { Link, PlainReason, PluginRegistry, ProviderPlugin, Usage } from "../proxy/plugin";
import { listPrices, sendTestCall } from "../proxy/proxy";

export interface OfferRow {
  model: string;
  location: string;
  // Who chose the location: the app, from what the model supports, or the
  // user, on Providers.
  locationSetBy: "app" | "user";
  price?: { input: number; output: number; source: SourceId; dateRead: string; stale: boolean };
  tier?: Tier;
  // The plug-in can call it: it knows the provider's own ID for the model.
  callable: boolean;
  // Where the model is known to make no tool call, the check that found it
  // (connect.noToolUse).
  noToolUse?: string;
  // Foundry only: the deployment name filled in (the user's own, once added).
  deployment?: string;
  added?: UserModel;
}

// The passed test call, as shown to the user who made it.
export interface TestResult {
  at: string;
  modelId: string;
  location: string;
  status: number;
  // The model the reply named, in the provider's words, where it names one.
  repliedModel?: string;
  text?: string;
  usage?: Usage;
  costUsd: number;
}

export interface UserModel {
  provider: Provider;
  model: string;
  location: string;
  deployment?: string;
  addedAt: string;
  test?: TestResult;
}

// Why a model was not added, each a plain sentence on the page.
export type AddRefusal =
  | PlainReason
  | "not_connected"
  | "not_offered"
  | "no_price"
  | "cannot_call"
  | "bad_deployment"
  | "wrong_model"
  | "budget_spent";

export type AddOutcome =
  | { kind: "added"; model: UserModel }
  | {
      kind: "refused";
      model: string;
      reason: AddRefusal;
      // The provider's own reply, verbatim: status, error name and message,
      // or the model a reply named. Absent when nothing reached the provider.
      reply?: { status: number; errorName?: string; message?: string; repliedModel?: string };
      note?: string;
      fix?: string;
      links?: Link[];
      modelId?: string;
      location?: string;
    };

interface UserModelRecord {
  provider: Provider;
  model: string;
  location: string;
  deployment: string | null;
  added_at: string;
  test_result: string | null;
}

const toUserModel = (r: UserModelRecord): UserModel => ({
  provider: r.provider,
  model: r.model,
  location: r.location,
  deployment: r.deployment ?? undefined,
  addedAt: r.added_at,
  test: r.test_result ? (JSON.parse(r.test_result) as TestResult) : undefined,
});

// The signed-in user's added models, every provider: what the per-task
// picker (T18) offers. Scoped to the user.
export async function readUserModels(db: D1Database, userId: string): Promise<UserModel[]> {
  const { results } = await db
    .prepare("SELECT provider, model, location, deployment, added_at, test_result FROM user_models WHERE user_id = ? ORDER BY provider, model")
    .bind(userId)
    .all<UserModelRecord>();
  return results.map(toUserModel);
}

async function saveUserModel(db: D1Database, userId: string, m: UserModel): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_models (user_id, provider, model, location, deployment, added_at, test_result) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (user_id, provider, model) DO UPDATE SET location = excluded.location, deployment = excluded.deployment,
         test_result = excluded.test_result`,
    )
    .bind(userId, m.provider, m.model, m.location, m.deployment ?? null, m.addedAt, m.test ? JSON.stringify(m.test) : null)
    .run();
}

// The location the app calls a model at: the region the user chose on
// Providers where the model is offered there, else the app's default for it.
async function locationFor(db: D1Database, userId: string, plugin: ProviderPlugin, model: string): Promise<{ location: string; setBy: "app" | "user" }> {
  const locations = plugin.connect.locations(model);
  const check = await readCheck(db, userId, plugin.provider);
  if (check?.regionSetBy === "user" && check.region && locations.includes(check.region)) return { location: check.region, setBy: "user" };
  return { location: locations[0]!, setBy: "app" };
}

// The models the current price table lists at the provider, by name.
async function tableModels(db: D1Database, provider: Provider): Promise<string[]> {
  const snapshot = await currentSnapshot(db);
  if (!snapshot) return [];
  const { results } = await db
    .prepare("SELECT DISTINCT model FROM price_rows WHERE snapshot_id = ? AND provider = ? AND batch = 0")
    .bind(snapshot.id, provider)
    .all<{ model: string }>();
  return results.map((r) => r.model);
}

async function offerRow(db: D1Database, userId: string, plugin: ProviderPlugin, model: string, added: UserModel | undefined): Promise<OfferRow> {
  const { location, setBy } = await locationFor(db, userId, plugin, model);
  const prices = await listPrices(db, { provider: plugin.provider, model, location, request: undefined }, false);
  const { input, output } = prices;
  return {
    model,
    location,
    locationSetBy: setBy,
    price:
      input && output
        ? {
            input: input.usdPerMTok,
            output: output.usdPerMTok,
            source: input.source,
            // The older of the two dates: neither price was read before it.
            dateRead: input.dateRead < output.dateRead ? input.dateRead : output.dateRead,
            stale: input.stale || output.stale,
          }
        : undefined,
    tier: input && output ? await lookupTier(db, { provider: plugin.provider, model }) : undefined,
    callable: plugin.connect.canCall(model),
    noToolUse: plugin.connect.noToolUse?.(model),
    deployment: added?.deployment ?? plugin.connect.deploymentName?.(model),
    added,
  };
}

// Every chat model the provider sells at a listed price, and every model the
// plug-in knows that the table has no price for yet, by name. A model the
// provider no longer offers (`connect.listed`) is left out, unless the user
// added it, so they still see why it cannot be picked again.
export async function listOffer(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider): Promise<OfferRow[]> {
  const plugin = plugins[provider];
  if (!plugin) return [];
  const added = new Map((await readUserModels(db, userId)).filter((m) => m.provider === provider).map((m) => [m.model, m]));
  const names = [...new Set([...(await tableModels(db, provider)), ...plugin.connect.knownModels])]
    .filter((model) => added.has(model) || (plugin.connect.listed?.(model) ?? true))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return Promise.all(names.map((model) => offerRow(db, userId, plugin, model, added.get(model))));
}

// A provider's model ID in one comparable form: lower case, with the
// publisher prefix and the separators the vendors vary ("anthropic.",
// "publishers/google/models/", dots, spaces, underscores) taken out.
const comparable = (id: string): string =>
  id
    .trim()
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/^(?:global|us|eu|apac|au|jp|ca)\.(?=anthropic\.)/, "")
    .replace(/^anthropic\./, "")
    .replace(/[\s._]+/g, "-");

// A date or version stamp a provider puts after a model's ID: "20261001",
// "2026-10-01", "0709" or "2501", "001", "v1:0", one or more of them.
const STAMP_PART = String.raw`(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{4}|\d{3}|v\d+(?::\d+)?)`;
const STAMP = new RegExp(`^${STAMP_PART}(?:-${STAMP_PART})*$`);

// Whether the model a reply names is the one picked: its ID, or that ID with
// a date or version stamp after it ("claude-haiku-5-5-20261001",
// "gemini-3.5-flash-001"), but never a longer name ("gemini-3.5-flash-lite"
// is not "gemini-3.5-flash", "claude-opus-5-5-20261101" is not
// "claude-opus-5") and never another listed model's ID (`otherIds`) that
// extends it. A reply that only echoes the user's own deployment name names
// no model, unless that name is another listed model's ID.
export function namesPickedModel(replied: string, modelId: string, deployment?: string, otherIds: readonly string[] = []): boolean {
  const said = comparable(replied);
  const id = comparable(modelId);
  const isModel = (candidate: string): boolean => said === candidate || (said.startsWith(`${candidate}-`) && STAMP.test(said.slice(candidate.length + 1)));
  const others = otherIds.map(comparable).filter((o) => o !== id);
  if (isModel(id)) return !others.some((o) => o.length > id.length && isModel(o));
  return Boolean(deployment && said === comparable(deployment) && !others.some(isModel));
}

// A Foundry deployment name: letters, digits, hyphens, dots and underscores,
// as Foundry allows them, at most 64.
const DEPLOYMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function addModel(
  db: D1Database,
  plugins: PluginRegistry,
  input: { userId: string; provider: Provider; model: string; deployment?: string; now: Date },
): Promise<AddOutcome> {
  const { userId, provider, model, now } = input;
  const plugin = plugins[provider];
  const refuse = (reason: AddRefusal, extra: Omit<Extract<AddOutcome, { kind: "refused" }>, "kind" | "model" | "reason"> = {}): AddOutcome => ({
    kind: "refused",
    model,
    reason,
    ...extra,
  });
  if (!plugin || !(await readConnection(db, userId, provider))) return refuse("not_connected");
  const offers = await listOffer(db, plugins, userId, provider);
  const offer = offers.find((r) => r.model === model);
  if (!offer) return refuse("not_offered");
  if (!offer.price) return refuse("no_price", { location: offer.location });
  const modelId = plugin.connect.modelId(model, offer.location);
  if (!offer.callable || !modelId) return refuse("cannot_call", { location: offer.location });

  let deployment: string | undefined;
  if (plugin.connect.deploymentName) {
    deployment = (input.deployment ?? "").trim() || (plugin.connect.deploymentName(model) ?? "");
    if (!DEPLOYMENT.test(deployment)) return refuse("bad_deployment", { location: offer.location });
  }
  const { location } = offer;
  const outcome = await sendTestCall(
    db,
    plugins,
    userId,
    { provider, model, location, deployment, request: plugin.connect.testRequest(model, location) },
    () => now,
  );
  const at = { modelId, location };

  if (outcome.kind === "answered") {
    const repliedModel = plugin.connect.replyModel(outcome.body);
    const otherIds = offers.filter((r) => r.model !== model).flatMap((r) => plugin.connect.modelId(r.model, r.location) ?? []);
    if (repliedModel && !namesPickedModel(repliedModel, modelId, deployment, otherIds)) {
      return refuse("wrong_model", { ...at, reply: { status: outcome.status, repliedModel } });
    }
    const added: UserModel = {
      provider,
      model,
      location,
      deployment,
      addedAt: now.toISOString(),
      test: {
        at: now.toISOString(),
        modelId: deployment ?? modelId,
        location,
        status: outcome.status,
        repliedModel,
        text: plugin.connect.replyText(outcome.body),
        usage: outcome.usage,
        costUsd: outcome.costUsd,
      },
    };
    await saveUserModel(db, userId, added);
    return { kind: "added", model: added };
  }
  if (outcome.kind === "provider_error" && outcome.failure) {
    const { failure } = outcome;
    // The stack's template version read now, so a stack just updated is
    // known as updated (Bedrock).
    const connection = await readConnection(db, userId, provider);
    const setupVersion = connection ? await refreshSetupVersion(db, plugin, userId, connection, await readCheck(db, userId, provider)) : undefined;
    const plain = plugin.connect.classify(failure, connection, setupVersion);
    return refuse(plain.reason, {
      ...at,
      reply: { status: failure.status, errorName: failure.errorName, message: failure.message },
      fix: plain.fix,
      links: plain.links,
    });
  }
  if (outcome.kind === "provider_error") return refuse("no_reply", { ...at, note: `${plugin.connect.guide.short} did not answer the test call.` });
  switch (outcome.reason) {
    case "not_callable":
      return refuse("cannot_call", at);
    case "no_price":
      return refuse("no_price", at);
    case "budget_spent":
      return refuse("budget_spent", { ...at, note: `Resumes ${outcome.resumesOn}.` });
    case "credential_failed":
      if (outcome.missing) return refuse("app_not_configured", { ...at, note: `Admin's one-time setup is missing ${outcome.missing.join(", ")}.` });
      if (outcome.failure) {
        const plain = plugin.connect.classify(outcome.failure, await readConnection(db, userId, provider), (await readCheck(db, userId, provider))?.templateVersion);
        return refuse(plain.reason, {
          ...at,
          reply: { status: outcome.failure.status, errorName: outcome.failure.errorName, message: outcome.failure.message },
          fix: plain.fix,
          links: plain.links,
        });
      }
      return refuse("no_reply", { ...at, note: `No answer from ${plugin.connect.guide.short} while connecting.` });
    default:
      return refuse("not_connected", at);
  }
}

// The plain sentence for a refusal: the first of the result's lines.
export function refusalText(o: Extract<AddOutcome, { kind: "refused" }>, plugin: ProviderPlugin | undefined, viewer: "owner" | "friend"): string {
  const name = plugin?.connect.guide.name ?? "That provider";
  const short = plugin?.connect.guide.short ?? "The provider";
  switch (o.reason) {
    case "not_connected":
      return `${name} is not connected: connect it on Providers first.`;
    case "not_offered":
      return `${o.model} is not on ${name}'s list.`;
    case "no_price":
      return `${o.model} has no price yet, so it cannot be added: the budget stop needs a real price.`;
    case "cannot_call":
      return `${o.model} is not offered at ${name} yet: ${plugin?.connect.notCallableReason(o.model) ?? "the app cannot call it"}.`;
    case "bad_deployment":
      return viewer === "friend"
        ? "Foundry's name for a model is letters, digits, hyphens, dots or underscores, at most 64."
        : "A deployment name is letters, digits, hyphens, dots or underscores, at most 64.";
    case "wrong_model":
      return `${short}'s reply names another model${o.reply?.repliedModel ? ` (${o.reply.repliedModel})` : ""}, not ${o.model}, so ${o.model} was not added.`;
    case "budget_spent":
      return `This month's budget for ${name} is spent, so the test call waits until the 1st.`;
    case "switching_on":
      return `${plugin?.connect.guide.vendor ?? short} is still switching this on: try again in 15 minutes.`;
    case "not_set_up":
      return "The connection isn't set up yet, or was removed.";
    case "not_allowed_yet":
      return "Your account isn't allowed to use this model yet.";
    case "no_such_model":
      // Friend screens never say "deployment name" (design-v3 1.6).
      return viewer === "friend" ? "That name or model ID doesn't exist here." : "That deployment name or model ID doesn't exist here.";
    case "region_unavailable":
      return "This region doesn't offer that model.";
    case "no_permission":
      return "Your provider account lacks permission.";
    case "data_retention":
      return "Your subscription blocks data retention this model needs.";
    case "busy":
      return "Busy or out of quota, not a setup fault.";
    case "app_not_configured":
      return `The app's own side of ${name} isn't set up yet.`;
    case "no_reply":
      return `No reply from ${short}.`;
    default:
      return `${short} refused the test call.`;
  }
}

// The fix line, where the plug-in gave none.
export function refusalFix(o: Extract<AddOutcome, { kind: "refused" }>, plugin: ProviderPlugin | undefined): string {
  if (o.fix) return o.fix;
  switch (o.reason) {
    case "wrong_model":
      return plugin?.connect.deploymentName
        ? `That name calls a deployment of another model: type the name of the one that runs ${o.model}, or deploy ${o.model} and keep its suggested name.`
        : `Pick ${o.model} again; if the reply still names another model, ${plugin?.connect.guide.name ?? "the provider"} is answering with it.`;
    case "budget_spent":
      return `Raise the budget on Budgets, then pick ${o.model} again.`;
    case "not_connected":
      return "Open Providers and connect it.";
    default:
      return "";
  }
}
