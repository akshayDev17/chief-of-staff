// Testing a model (design-v3 1.5, T17): on the provider's Connect screen
// (providers/models-table.ts), one table lists every model the connected
// provider lists, each with Test. Test runs the model's test call once and
// records it as the model's latest test (models/usable.ts): a model whose
// latest test passed is one the user's tasks can use, and a later failed
// test takes it out (the owner, 2026-11-27: "quite franky remove the add
// feature altogether"). Only the model's own verdict is recorded so: a
// refusal that says nothing about the model (`notVerdict`: the provider not
// connected, the month's budget spent, no credential, no credit, the
// provider busy) leaves its latest test, and so its tasks, as they were.
//
//   listOffer(db, plugins, userId, provider) -> OfferRow[]
//   testOne(db, plugins, { userId, provider, model, now }) -> TestOutcome     Test on a row
//   testModel(db, plugin, plugins, input) -> TestOutcome                      one test call, also for Test all models
//   testRecord(outcome, plugin) -> TestRecord                                  what a test showed, as stored
//
// The list is every model OpenRouter's own model list names (the owner,
// 2026-11-27: "i would like to list all models and then choose"), read with
// the price table (src/prices/openrouter.ts). Each row carries the model's
// list price, the source and date read, and its tier from that price
// (tiers.ts). A model the plug-in cannot call shows why and cannot be tested;
// one with no input and output price shows "no price yet" and cannot be
// tested, because the budget stop needs a real price; the proxy refuses a
// call to either. A router is priced at the user's price cap
// (models/price-caps.ts) and cannot be tested without one. A free model
// (prices/openrouter.ts isTrulyFreeTextModel: it gives only text and every
// price OpenRouter lists for it is 0) carries FREE_NOTE; it is never proposed
// for a task (models/tasks.ts). A model at $0 a token that is not free that
// way says so.
//
// The test call goes through the proxy's one pipeline (`sendTestCall`), which
// prices it and writes its ledger row. Where the reply names its model, a
// reply naming another model than the one picked fails the test with a
// plain reason.

import { readCurrentCatalog, currentSnapshot, readSnapshotRows } from "../prices/store";
import { modelTier, tierFromInputPrice, type Tier } from "../prices/tiers";
import type { PriceRow, Provider, SourceId } from "../prices/types";
import { reasonText } from "../providers/check";
import { readConnection } from "../proxy/connections";
import type { Link, PlainReason, PluginRegistry, ProviderPlugin, Usage } from "../proxy/plugin";
import { sendTestCall } from "../proxy/proxy";
import { readAccountList } from "./account-list";
import { readPriceCaps, type PriceCap } from "./price-caps";
import { latestTestWrite, type TestRecord } from "./usable";

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
  // A router: priced per call by the model it picks, so its price is the
  // user's cap (`cap`), and it cannot be tested without one.
  router: boolean;
  cap?: PriceCap;
  // The user's own account leaves it out (models/account-list.ts).
  accountLeftOut: boolean;
  // Where the provider lists no tool support for it, the plug-in's words.
  noToolUse?: string;
  // The plug-in's plain notes for the entry (a retirement date, a price
  // that rises with the prompt's length).
  notes: string[];
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

// Why a test did not pass, each a plain sentence on the page.
export type TestRefusal =
  | PlainReason
  | "not_connected"
  | "not_offered"
  | "no_price"
  | "no_cap"
  | "cap_refused"
  | "cannot_call"
  | "wrong_model"
  | "budget_spent";

// The refusals a friend can ask Admin about, by the sentence they saw.
export const MODEL_HELP_REASONS: ReadonlySet<string> = new Set<TestRefusal>([
  "not_set_up", "no_credits", "no_such_model", "no_permission", "busy", "app_not_configured", "no_reply", "refused",
  "wrong_model", "budget_spent", "cannot_call", "no_price", "no_cap", "cap_refused",
]);

export const FREE_NOTE = "free: rate-limited, and the provider may log prompts";
export const NOT_FREE_NOTE = "not free: OpenRouter lists other fees for it";

export interface Refused {
  kind: "refused";
  model: string;
  reason: TestRefusal;
  // The provider's own reply, verbatim: status, error name and message, or
  // the model a reply named. Absent when nothing reached the provider.
  reply?: { status: number; errorName?: string; message?: string; repliedModel?: string };
  note?: string;
  fix?: string;
  links?: Link[];
  location?: string;
  // The model is free, so a 402 on it is not a paid model's.
  free?: boolean;
  // Says nothing about the model, so it is no verdict on it.
  notVerdict?: true;
}

export type TestOutcome = { kind: "passed"; model: string; test: TestResult } | Refused;

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

// Every model the provider's own list names and every model the price table
// prices there, by ID.
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
  const account = await readAccountList(db, userId, provider);
  const caps = await readPriceCaps(db, userId, provider);
  const ids = [...new Set([...names.keys(), ...rowsByModel.keys()])].sort(byText);
  return ids.map((model) => {
    const location = plugin.connect.locations(model)[0] ?? "global";
    const name = names.get(model);
    const router = plugin.connect.isRouter?.(model) === true;
    const cap = router ? caps.get(model) : undefined;
    // A router's price is its cap: what the budget stop prices its calls at.
    const priced: Pick<OfferRow, "price" | "tier"> = cap
      ? {
          price: { input: cap.input, output: cap.output, source: plugin.priceSource[0]!, dateRead: (cap.setAt ?? "").slice(0, 10), stale: false },
          tier: tierFromInputPrice(cap.input),
        }
      : priceOf(rowsByModel.get(model) ?? [], location);
    const isFree = free.has(model);
    const zeroTokens = priced.price?.input === 0 && priced.price.output === 0;
    return {
      model,
      ...(name && name !== model ? { name } : {}),
      location,
      ...priced,
      free: isFree,
      callable: plugin.connect.canCall(model),
      router,
      ...(cap ? { cap } : {}),
      accountLeftOut: account !== undefined && !account.models.has(model),
      noToolUse: plugin.connect.noToolUse?.(model),
      notes: [...(isFree ? [FREE_NOTE] : zeroTokens ? [NOT_FREE_NOTE] : []), ...(plugin.connect.modelNotes?.(model) ?? [])],
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

// What keeps an entry from being tested, and so which action unblocks it on
// its row: `router` a price cap, `account` the account's provider settings
// (a link to them, then Check again); `not_callable` and `no_price` none.
export type BlockKind = "not_callable" | "router" | "account" | "no_price";

export function blockKind(row: OfferRow): BlockKind | undefined {
  if (!row.callable) return "not_callable";
  if (row.router && !row.cap) return "router";
  if (row.accountLeftOut) return "account";
  if (!row.price) return "no_price";
  return undefined;
}

// Why an entry cannot be tested, or undefined when it can.
export function blockedReason(row: OfferRow, plugin: ProviderPlugin): string | undefined {
  switch (blockKind(row)) {
    case "not_callable":
      return `not offered: ${plugin.connect.notCallableReason(row.model)}`;
    case "router":
      return `priced per call by the model it picks: set it a price cap`;
    case "account":
      return `not offered for your account: your ${plugin.connect.guide.short} settings (provider preferences, privacy or guardrails) leave it out`;
    case "no_price":
      return `no price yet: not in ${plugin.connect.guide.short}'s price list yet`;
    default:
      return undefined;
  }
}

// The failure kinds that say nothing about the model: the key is gone, the
// account or key is out of credit, the provider is busy.
const NOT_VERDICT_FAILURES: ReadonlySet<PlainReason> = new Set<PlainReason>(["not_set_up", "no_credits", "busy"]);

// Whether an outcome is the model's own verdict, which becomes its latest test.
export const isVerdict = (o: TestOutcome): boolean => o.kind === "passed" || !o.notVerdict;

// One test call on `model` through the proxy, and what it proved: the passed
// call, or the plain refusal. Used by Test and by Test all models.
export async function testModel(
  db: D1Database,
  plugin: ProviderPlugin,
  plugins: PluginRegistry,
  input: { userId: string; model: string; location: string; otherIds: readonly string[]; now: Date; task?: string; free?: boolean },
): Promise<TestOutcome> {
  const { userId, model, location, now } = input;
  const provider = plugin.provider;
  const refuse = (reason: TestRefusal, extra: Omit<Refused, "kind" | "model" | "reason"> = {}): Refused => ({
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
    // A router's reply names the model it picked, which is the point.
    if (repliedModel && !plugin.connect.isRouter?.(model) && !namesPickedModel(repliedModel, model, input.otherIds)) {
      return refuse("wrong_model", { reply: { status: outcome.status, repliedModel } });
    }
    return {
      kind: "passed",
      model,
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
    };
  }
  const connection = await readConnection(db, userId, provider);
  // A router called under the user's cap that OpenRouter refuses for the
  // request itself (no model under the cap, a router's own limit): its own
  // words, not a missing model.
  if (outcome.failure?.step === "call" && plugin.connect.isRouter?.(model) && [400, 404, 422].includes(outcome.failure.status)) {
    const { failure } = outcome;
    return refuse("cap_refused", {
      reply: { status: failure.status, errorName: failure.errorName, message: failure.message },
      fix: `${plugin.connect.guide.short}'s own words are above. Raise the price cap if no model fits under it, then test again.`,
    });
  }
  if (outcome.failure) {
    const { failure } = outcome;
    const plain = plugin.connect.classify(failure, connection);
    const credential = outcome.kind === "refused" && outcome.reason === "credential_failed";
    return refuse(plain.reason, {
      reply: failure.step === "call" ? { status: failure.status, errorName: failure.errorName, message: failure.message } : undefined,
      fix: plain.fix,
      links: plain.links,
      ...(credential || NOT_VERDICT_FAILURES.has(plain.reason) ? { notVerdict: true as const } : {}),
    });
  }
  if (outcome.kind === "provider_error") return refuse("no_reply", { note: `${plugin.connect.guide.short} did not answer the test call.` });
  switch (outcome.reason) {
    case "not_callable":
      return refuse("cannot_call");
    case "no_price":
      return refuse("no_price");
    case "no_cap":
      return refuse("no_cap");
    case "budget_spent":
      return refuse("budget_spent", { note: `Resumes ${outcome.resumesOn}.`, notVerdict: true });
    case "credential_failed":
      return outcome.missing
        ? refuse("app_not_configured", { note: `Admin's one-time setup is missing ${outcome.missing.join(", ")}.`, notVerdict: true })
        : refuse("no_reply", { note: `No answer from ${plugin.connect.guide.short} while connecting.`, notVerdict: true });
    default:
      return refuse("not_connected", { notVerdict: true });
  }
}

// The refusals made before any call, because the row cannot be tested: no
// test is recorded for them.
export const PRECHECK_REFUSALS: ReadonlySet<TestRefusal> = new Set<TestRefusal>(["not_connected", "not_offered", "cannot_call", "no_cap", "no_price"]);

// Whether the user may test `model` now, and the offer row if so.
async function offerFor(
  db: D1Database,
  plugins: PluginRegistry,
  input: { userId: string; provider: Provider; model: string },
): Promise<{ offer: OfferRow; offers: OfferRow[]; plugin: ProviderPlugin } | Refused> {
  const { userId, provider, model } = input;
  const plugin = plugins[provider];
  if (!plugin || !(await readConnection(db, userId, provider))) return { kind: "refused", model, reason: "not_connected" };
  const offers = await listOffer(db, plugins, userId, provider);
  const offer = offers.find((r) => r.model === model);
  if (!offer) return { kind: "refused", model, reason: "not_offered" };
  switch (blockKind(offer)) {
    case "not_callable":
    case "account":
      return { kind: "refused", model, reason: "cannot_call", location: offer.location };
    case "router":
      return { kind: "refused", model, reason: "no_cap", location: offer.location };
    case "no_price":
      return { kind: "refused", model, reason: "no_price", location: offer.location };
  }
  return { offer, offers, plugin };
}

// What a test showed, as stored: the passed call, or the plain reason with
// the provider's own words.
export function testRecord(o: TestOutcome, plugin: ProviderPlugin): TestRecord {
  if (o.kind === "passed") return { text: "Works now.", test: o.test };
  const fix = refusalFix(o, plugin);
  return {
    reason: o.reason,
    text: refusalText(o, plugin),
    ...(o.reply ? { reply: o.reply } : {}),
    ...(fix ? { fix } : {}),
    ...(o.links?.length ? { links: o.links } : {}),
  };
}

// Test on a row: one test call, recorded as the model's latest test when it
// is the model's verdict. A row that cannot be tested is refused with no
// call and nothing recorded.
export async function testOne(
  db: D1Database,
  plugins: PluginRegistry,
  input: { userId: string; provider: Provider; model: string; now: Date },
): Promise<TestOutcome> {
  const { userId, provider, model, now } = input;
  const found = await offerFor(db, plugins, input);
  if ("kind" in found) return found;
  const { offer, offers, plugin } = found;
  const outcome = await testModel(db, plugin, plugins, { userId, model, location: offer.location, otherIds: offers.map((r) => r.model), now, free: offer.free });
  if (isVerdict(outcome)) await latestTestWrite(db, userId, provider, model, outcome.kind === "passed" ? "passed" : "failed", testRecord(outcome, plugin), now).run();
  return outcome;
}

// The plain sentence for a refusal: the first of the result's lines.
export function refusalText(o: Refused, plugin: ProviderPlugin | undefined): string {
  const name = plugin?.connect.guide.name ?? "That provider";
  const short = plugin?.connect.guide.short ?? "The provider";
  switch (o.reason) {
    case "not_connected":
      return `${name} is not connected.`;
    case "not_offered":
      return `Not on ${name}'s list.`;
    case "no_price":
      return "No price yet, so it can't be tested.";
    case "no_cap":
      return "It needs a price cap first.";
    case "cap_refused":
      return `${short} refused the call under your price cap.`;
    case "cannot_call":
      return plugin?.connect.canCall(o.model) ? "Not offered for your account." : "The app can't call this model.";
    case "wrong_model":
      return `${short}'s reply named another model.`;
    case "budget_spent":
      return "This month's budget is spent.";
    case "no_credits":
      if (o.free) return `${short} asked for credit even for this free model.`;
      return plugin ? reasonText(o.reason, plugin) : `${short} refused the test call.`;
    default:
      return plugin ? reasonText(o.reason, plugin) : `${short} refused the test call.`;
  }
}

// The reason and the fix, collapsed under the plain line; the plug-in's own
// fix where it gave one.
export function refusalFix(o: Refused, plugin: ProviderPlugin | undefined): string {
  if (o.fix) return o.fix;
  const name = plugin?.connect.guide.name ?? "the provider";
  switch (o.reason) {
    case "no_price":
      return "The budget stop needs a real price.";
    case "no_cap":
      return `${name} prices it by the model it picks for each call. Set it a price cap on its row, then test it.`;
    case "cannot_call":
      return plugin?.connect.canCall(o.model)
        ? `Your ${plugin.connect.guide.short} settings leave ${o.model} out.`
        : `${o.model}: ${plugin?.connect.notCallableReason(o.model) ?? "the app cannot call it"}.`;
    case "wrong_model":
      return `Test ${o.model} again; if the reply still names another model, ${name} is answering with it.`;
    case "budget_spent":
      return `The test call waits until the 1st. Raise the budget on Budgets, then test ${o.model} again.`;
    case "not_connected":
      return "Open Providers and connect it.";
    default:
      return "";
  }
}
