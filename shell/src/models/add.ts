// Choosing a model (design-v3 1.5, T17): on the provider's Connect screen
// (providers/models-panel.ts), the user picks a model from the app's list of
// every model the connected provider lists, and the model's test call runs
// once. The model is added only when that call passes.
//
//   listOffer(db, plugins, userId, provider) -> OfferRow[]
//   addModel(db, plugins, { userId, provider, model, now }) -> AddOutcome
//   readUserModels(db, userId) -> UserModel[]     what T18's picker offers
//   saveUserModel(db, userId, model)               also written by Add on Test all models' results
//
// The list is every model OpenRouter's own model list names (the owner,
// 2026-11-27: "i would like to list all models and then choose"), read with
// the price table (src/prices/openrouter.ts), and every model the user added
// that it no longer names. Each row carries the model's list price, the
// source and date read, and its tier from that price (tiers.ts). A model the
// plug-in cannot call shows why and cannot be chosen; one with no input and
// output price shows "no price yet" and cannot be added, because the budget
// stop needs a real price; the proxy refuses a call to either. A free model
// (prices/openrouter.ts isTrulyFreeTextModel: it gives only text and every
// price OpenRouter lists for it is 0) carries FREE_NOTE; it is never proposed
// for a task (models/tasks.ts). A model at $0 a token that is not free that
// way says so.
//
// The test call goes through the proxy's one pipeline (`sendTestCall`), which
// prices it and writes its ledger row. Where the reply names its model, a
// reply naming another model than the one picked is refused with a plain
// reason, and nothing is added.

import { readCurrentCatalog, currentSnapshot, readSnapshotRows } from "../prices/store";
import { modelTier, type Tier } from "../prices/tiers";
import { isProvider, type PriceRow, type Provider, type SourceId } from "../prices/types";
import { reasonText } from "../providers/check";
import { readConnection } from "../proxy/connections";
import type { Link, PlainReason, PluginRegistry, ProviderPlugin, Usage } from "../proxy/plugin";
import { sendTestCall } from "../proxy/proxy";
import { readAccountList } from "./account-list";

export interface OfferRow {
  model: string;
  // The provider's own name for it ("OpenAI: GPT-6 Luna"), where it gives one.
  name?: string;
  location: string;
  // `request`: the provider's fee per call, in USD per million calls, when it lists one.
  price?: { input: number; output: number; request?: number; source: SourceId; dateRead: string; stale: boolean };
  tier?: Tier;
  // Free by the one rule (prices/openrouter.ts isTrulyFreeTextModel), from
  // the provider's model list.
  free: boolean;
  // The plug-in can call it; otherwise `notCallableReason` says why.
  callable: boolean;
  // The user's own account leaves it out (models/account-list.ts).
  accountLeftOut: boolean;
  // Where the provider lists no tool support for it, the plug-in's words.
  noToolUse?: string;
  // The plug-in's plain notes for the entry (a retirement date, a price
  // that rises with the prompt's length).
  notes: string[];
  added?: UserModel;
}

// The passed test call, as shown to the user who made it.
export interface TestResult {
  at: string;
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
  addedAt: string;
  test?: TestResult;
}

// Why a model was not added, each a plain sentence on the page.
export type AddRefusal = PlainReason | "not_connected" | "not_offered" | "no_price" | "cannot_call" | "wrong_model" | "budget_spent" | "not_passed";

export const FREE_NOTE = "free: rate-limited, and the provider may log prompts";
export const NOT_FREE_NOTE = "not free: OpenRouter lists other fees for it";

// The free models of the current model list, by ID.
export async function readFreeModels(db: D1Database): Promise<Set<string>> {
  return new Set(((await readCurrentCatalog(db))?.models ?? []).filter((m) => m.free).map((m) => m.id));
}

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
      location?: string;
      // The model is free, so a 402 on it is not a paid model's.
      free?: boolean;
    };

interface UserModelRecord {
  provider: string;
  model: string;
  location: string;
  added_at: string;
  test_result: string | null;
}

// The signed-in user's added models at every provider a plug-in can serve:
// what the per-task picker (T18) offers. Models added at a removed provider
// (Bedrock, Vertex AI, Foundry) stay in D1 and are left out. Scoped to the user.
export async function readUserModels(db: D1Database, userId: string): Promise<UserModel[]> {
  const { results } = await db
    .prepare("SELECT provider, model, location, added_at, test_result FROM user_models WHERE user_id = ? ORDER BY provider, model")
    .bind(userId)
    .all<UserModelRecord>();
  return results.flatMap((r) =>
    isProvider(r.provider)
      ? [{ provider: r.provider, model: r.model, location: r.location, addedAt: r.added_at, test: r.test_result ? (JSON.parse(r.test_result) as TestResult) : undefined }]
      : [],
  );
}

export async function saveUserModel(db: D1Database, userId: string, m: UserModel): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_models (user_id, provider, model, location, added_at, test_result) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (user_id, provider, model) DO UPDATE SET location = excluded.location, test_result = excluded.test_result`,
    )
    .bind(userId, m.provider, m.model, m.location, m.addedAt, m.test ? JSON.stringify(m.test) : null)
    .run();
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The price and tier of each model at its location, from one read of the
// current snapshot: the dearest standard row of each kind there, so the
// shown price is never below what the provider can charge.
function priceOf(rows: PriceRow[], location: string): Pick<OfferRow, "price" | "tier"> {
  const at = rows.filter((r) => !r.longPrompt && !r.batch && (r.region === location || r.deployment === location));
  const dearest = (kind: PriceRow["tokenKind"]) => at.filter((r) => r.tokenKind === kind).sort((a, b) => b.usdPerMTok - a.usdPerMTok)[0];
  const input = dearest("input");
  const output = dearest("output");
  const request = dearest("request");
  if (!input || !output) return {};
  return {
    price: {
      input: input.usdPerMTok,
      output: output.usdPerMTok,
      ...(request ? { request: request.usdPerMTok } : {}),
      source: input.source,
      // The older of the two dates: neither price was read before it.
      dateRead: input.dateRead < output.dateRead ? input.dateRead : output.dateRead,
      stale: input.stale || output.stale,
    },
    tier: modelTier(input.provider, rows),
  };
}

// Every model the provider's own list names, every model the price table
// prices there, and every model the user added there, by ID.
export async function listOffer(db: D1Database, plugins: PluginRegistry, userId: string, provider: Provider): Promise<OfferRow[]> {
  const plugin = plugins[provider];
  if (!plugin) return [];
  const snapshot = await currentSnapshot(db);
  const rows = snapshot ? (await readSnapshotRows(db, snapshot.id)).filter((r) => r.provider === provider) : [];
  const rowsByModel = new Map<string, PriceRow[]>();
  for (const r of rows) rowsByModel.set(r.model, [...(rowsByModel.get(r.model) ?? []), r]);
  const catalog = await readCurrentCatalog(db);
  const names = new Map((catalog?.models ?? []).map((m) => [m.id, m.name]));
  const free = new Set((catalog?.models ?? []).filter((m) => m.free).map((m) => m.id));
  const added = new Map((await readUserModels(db, userId)).filter((m) => m.provider === provider).map((m) => [m.model, m]));
  const account = await readAccountList(db, userId, provider);
  const ids = [...new Set([...names.keys(), ...rowsByModel.keys(), ...added.keys()])].sort(byText);
  return ids.map((model) => {
    const location = added.get(model)?.location ?? plugin.connect.locations(model)[0] ?? "global";
    const name = names.get(model);
    const priced = priceOf(rowsByModel.get(model) ?? [], location);
    const isFree = free.has(model);
    const zeroTokens = priced.price?.input === 0 && priced.price.output === 0;
    return {
      model,
      ...(name && name !== model ? { name } : {}),
      location,
      ...priced,
      free: isFree,
      callable: plugin.connect.canCall(model),
      accountLeftOut: account !== undefined && !account.models.has(model),
      noToolUse: plugin.connect.noToolUse?.(model),
      notes: [...(isFree ? [FREE_NOTE] : zeroTokens ? [NOT_FREE_NOTE] : []), ...(plugin.connect.modelNotes?.(model) ?? [])],
      added: added.get(model),
    };
  });
}

// A provider's model ID in one comparable form: lower case, with the
// publisher prefix ("openai/"), a variant suffix (":batch", ":nitro") and
// the separators the vendors vary (dots, spaces, underscores) taken out.
const comparable = (id: string): string =>
  id
    .trim()
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/:[a-z0-9-]+$/, "")
    .replace(/[\s._]+/g, "-");

// A date or version stamp a provider puts after a model's ID: "20261001",
// "2026-10-01", "0709" or "2501", "001", "v1:0", one or more of them.
const STAMP_PART = String.raw`(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{4}|\d{3}|v\d+(?::\d+)?)`;
const STAMP = new RegExp(`^${STAMP_PART}(?:-${STAMP_PART})*$`);

// Whether the model a reply names is the one picked: its ID, or that ID with
// a date or version stamp after it ("<model>-20261001"), but never a
// longer name ("<model>-pro" is not "<model>") and never another listed
// model's ID (`otherIds`) that extends it.
export function namesPickedModel(replied: string, modelId: string, otherIds: readonly string[] = []): boolean {
  const said = comparable(replied);
  const id = comparable(modelId);
  const isModel = (candidate: string): boolean => said === candidate || (said.startsWith(`${candidate}-`) && STAMP.test(said.slice(candidate.length + 1)));
  const others = otherIds.map(comparable).filter((o) => o !== id);
  return isModel(id) && !others.some((o) => o.length > id.length && isModel(o));
}

// Why an entry cannot be chosen, or undefined when it can.
export function blockedReason(row: OfferRow, plugin: ProviderPlugin): string | undefined {
  if (!row.callable) return `not offered: ${plugin.connect.notCallableReason(row.model)}`;
  if (row.accountLeftOut) return `not offered for your account: your ${plugin.connect.guide.short} settings (provider preferences, privacy or guardrails) leave it out`;
  if (!row.price) return `no price yet: not in ${plugin.connect.guide.short}'s price list yet`;
  return undefined;
}

// One test call on `model` through the proxy, and what it proved: the model
// to add, or the plain refusal. Used by Choose and by Test all models.
export async function testModel(
  db: D1Database,
  plugin: ProviderPlugin,
  plugins: PluginRegistry,
  input: { userId: string; model: string; location: string; otherIds: readonly string[]; now: Date; task?: string; free?: boolean },
): Promise<AddOutcome> {
  const { userId, model, location, now } = input;
  const provider = plugin.provider;
  const refuse = (reason: AddRefusal, extra: Omit<Extract<AddOutcome, { kind: "refused" }>, "kind" | "model" | "reason"> = {}): AddOutcome => ({
    kind: "refused",
    model,
    reason,
    location,
    ...(input.free ? { free: true } : {}),
    ...extra,
  });
  const outcome = await sendTestCall(db, plugins, userId, { provider, model, location, request: plugin.connect.testRequest(model) }, () => now, input.task);
  if (outcome.kind === "answered") {
    const repliedModel = plugin.connect.replyModel(outcome.body);
    if (repliedModel && !namesPickedModel(repliedModel, model, input.otherIds)) {
      return refuse("wrong_model", { reply: { status: outcome.status, repliedModel } });
    }
    return {
      kind: "added",
      model: {
        provider,
        model,
        location,
        addedAt: now.toISOString(),
        test: {
          at: now.toISOString(),
          location,
          status: outcome.status,
          repliedModel,
          // A reasoning model can spend its few tokens thinking and give no
          // text: its 200 still proves it answers.
          text: plugin.connect.replyText(outcome.body),
          usage: outcome.usage,
          costUsd: outcome.costUsd,
        },
      },
    };
  }
  const connection = await readConnection(db, userId, provider);
  if (outcome.failure) {
    const { failure } = outcome;
    const plain = plugin.connect.classify(failure, connection);
    return refuse(plain.reason, {
      reply: failure.step === "call" ? { status: failure.status, errorName: failure.errorName, message: failure.message } : undefined,
      fix: plain.fix,
      links: plain.links,
    });
  }
  if (outcome.kind === "provider_error") return refuse("no_reply", { note: `${plugin.connect.guide.short} did not answer the test call.` });
  switch (outcome.reason) {
    case "not_callable":
      return refuse("cannot_call");
    case "no_price":
      return refuse("no_price");
    case "budget_spent":
      return refuse("budget_spent", { note: `Resumes ${outcome.resumesOn}.` });
    case "credential_failed":
      return outcome.missing
        ? refuse("app_not_configured", { note: `Admin's one-time setup is missing ${outcome.missing.join(", ")}.` })
        : refuse("no_reply", { note: `No answer from ${plugin.connect.guide.short} while connecting.` });
    default:
      return refuse("not_connected");
  }
}

export async function addModel(
  db: D1Database,
  plugins: PluginRegistry,
  input: { userId: string; provider: Provider; model: string; now: Date },
): Promise<AddOutcome> {
  const { userId, provider, model, now } = input;
  const plugin = plugins[provider];
  if (!plugin || !(await readConnection(db, userId, provider))) return { kind: "refused", model, reason: "not_connected" };
  const offers = await listOffer(db, plugins, userId, provider);
  const offer = offers.find((r) => r.model === model);
  if (!offer) return { kind: "refused", model, reason: "not_offered" };
  if (!offer.callable || offer.accountLeftOut) return { kind: "refused", model, reason: "cannot_call", location: offer.location };
  if (!offer.price) return { kind: "refused", model, reason: "no_price", location: offer.location };
  const outcome = await testModel(db, plugin, plugins, { userId, model, location: offer.location, otherIds: offers.map((r) => r.model), now, free: offer.free });
  if (outcome.kind === "added") await saveUserModel(db, userId, outcome.model);
  return outcome;
}

// The plain sentence for a refusal: the first of the result's lines.
export function refusalText(o: Extract<AddOutcome, { kind: "refused" }>, plugin: ProviderPlugin | undefined): string {
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
      return plugin?.connect.canCall(o.model)
        ? `${o.model} is not offered for your account: your ${short} settings leave it out.`
        : `${o.model} is not offered at ${name}: ${plugin?.connect.notCallableReason(o.model) ?? "the app cannot call it"}.`;
    case "wrong_model":
      return `${short}'s reply names another model${o.reply?.repliedModel ? ` (${o.reply.repliedModel})` : ""}, not ${o.model}, so ${o.model} was not added.`;
    case "budget_spent":
      return `This month's budget for ${name} is spent, so the test call waits until the 1st.`;
    case "not_passed":
      return `${o.model} did not pass in your latest Test all models run, so it cannot be added from it.`;
    case "no_credits":
      if (o.free) return `${short} asked for credit even for this free model.`;
      return plugin ? reasonText(o.reason, plugin) : `${short} refused the test call.`;
    default:
      return plugin ? reasonText(o.reason, plugin) : `${short} refused the test call.`;
  }
}

// The fix line, where the plug-in gave none.
export function refusalFix(o: Extract<AddOutcome, { kind: "refused" }>, plugin: ProviderPlugin | undefined): string {
  if (o.fix) return o.fix;
  switch (o.reason) {
    case "wrong_model":
      return `Pick ${o.model} again; if the reply still names another model, ${plugin?.connect.guide.name ?? "the provider"} is answering with it.`;
    case "budget_spent":
      return `Raise the budget on Budgets, then pick ${o.model} again.`;
    case "not_connected":
      return "Open Providers and connect it.";
    case "not_passed":
      return `Choose ${o.model} in the list above to run its own test call.`;
    default:
      return "";
  }
}
