// The model proxy core (design-v3 1.4, 1.7, 1.8). It knows no provider: the
// provider's plug-in mints the credential and makes the call; the core
// prices, enforces the budget, picks the fallback and writes the ledger.
//
//   callModel(db, plugins, call, now?) -> ProxyOutcome
//
// Before sending a call to a provider the core refuses it when:
// - no plug-in serves the provider (`no_plugin`);
// - the plug-in cannot call the model, or not at its location
//   (`not_callable`, with the plug-in's reason): a model the user added that
//   the provider's list now drops;
// - the model has no input or output list price at that location (`no_price`):
//   the budget stop needs a real price; a router (priced by the model it picks
//   for each call) is priced at the user's price cap instead, and refused
//   without one (`no_cap`); its call asks the provider for no model dearer
//   than the cap;
// - the user has set no monthly budget for the provider (`no_budget`), except
//   for a test call (`testCall`), which runs before budgets are set;
// - the user's spend at the provider since the 1st has reached the budget
//   (`budget_spent`), until the 1st of next month;
// - the user has not connected the provider (`not_connected`), or the
//   connection gave no credential (`credential_failed`).
//
// One fallback, another model: when the provider refuses or fails the main
// model's call (429, 408 or 5xx, or no reply; see plugin.ts), the task's
// fallback runs once, under all the same checks. A fallback on another
// provider also answers a spent budget or a failed credential at the main
// model's provider; with one provider (OpenRouter today) those stop the
// fallback too, which shares the budget and the key. Any other outcome is
// returned as it is.
//
// Every call sent to a provider writes one ledger row, answered or not. Its
// cost is the cost the provider's reply reports (OpenRouter's `usage.cost`),
// what the user is billed (`cost_source` `reported`). Only when the reply
// reports none are its tokens costed at the price table's list price
// (`list_price`): at the long-prompt rows when the prompt reached them, and
// each cache write at its own 5-minute or 1-hour row. A kind the call used
// with no row of its own is then costed so it can never be below what the
// provider charges: cached input at the input price, anything else at the
// dearest token rate the table lists for the model there. A call that used
// tokens also pays the model's fee per call (`request`), where it lists one. The row names each such
// kind and its rate, and the maintainers get a `price_missing` alert. The
// row also keeps the provider's own ID for the call (OpenRouter's generation
// ID), so it can be checked against the provider's own record. The request
// and reply bodies pass through untouched and are never logged or stored;
// the credential lives only for the call.
//
// A refusal the plug-in reads as the grant removed on the provider's side
// (`connect.classify` says `not_set_up`), whether minting the credential or
// in the call itself, stops the provider at once and is recorded for T49's
// alert.

import { AppNotConfigured } from "../app-config";
import type { PriceAnswer } from "../prices/lookup";
import { currentSnapshot, readModelRows } from "../prices/store";
import { modelTier, tierFromInputPrice, type Tier } from "../prices/tiers";
import { addAlertOncePerDay } from "../prices/store";
import { readPriceCap } from "../models/price-caps";
import type { Provider, TokenKind } from "../prices/types";
import { readBudget } from "./budgets";
import { readConnection } from "./connections";
import { monthSpend, nextMonthStart, writeLedgerRow } from "./ledger";
import { recordGrantRefused } from "../providers/revoked";
import { fallbackAnswers, ProviderRefusal, type Failure, type ModelRequest, type PluginRegistry, type Usage } from "./plugin";

export interface ModelChoice {
  provider: Provider;
  model: string;
  // The region or deployment type, as the price table names it (`global`
  // on OpenRouter).
  location: string;
  // The request in this provider's own format.
  request: ModelRequest;
}

export interface ModelCall {
  userId: string;
  task: string;
  site?: string;
  company?: string;
  runId?: string;
  main: ModelChoice;
  // The task's fallback: another model, on the same provider or another.
  fallback?: ModelChoice;
}

export type Refusal = "no_plugin" | "not_callable" | "no_price" | "no_cap" | "no_budget" | "budget_spent" | "not_connected" | "credential_failed";

export const TEST_TASK = "test_call";

export type ProxyOutcome =
  | { kind: "answered"; provider: Provider; model: string; fallback: boolean; status: number; body: unknown; usage: Usage; costUsd: number }
  // The provider's own refusal or failure, passed back as it came; `failure`
  // is its status, error name and message, absent when it did not reply.
  | { kind: "provider_error"; provider: Provider; model: string; fallback: boolean; status: number; body: unknown; failure?: Failure }
  // On `credential_failed`: the provider's own refusal (`failure`), or the
  // app's own settings still missing (`missing`).
  | {
      kind: "refused";
      provider: Provider;
      model: string;
      fallback: boolean;
      reason: Refusal;
      detail: string;
      resumesOn?: string;
      failure?: Failure;
      missing?: string[];
    };

// Each usage count and the price-table row it is costed at.
const USAGE_KINDS: ReadonlyArray<readonly [Exclude<keyof Usage, "longPrompt" | "reportedCostUsd">, TokenKind]> = [
  ["input", "input"],
  ["cachedInput", "cached_input"],
  ["cacheWrite", "cache_write"],
  ["cacheWrite1h", "cache_write_1h"],
  ["output", "output"],
];

type Prices = Partial<Record<TokenKind, PriceAnswer>>;

export interface Cost {
  usd: number;
  // `reported`: the provider's own reported cost; `list_price`: the table's.
  source: "reported" | "list_price";
  // Each kind the call used that had no row of its own at the tier billed,
  // and the rate, in USD per million tokens, it was costed at instead.
  conservative: Partial<Record<TokenKind, number>>;
}

// Tokens at the price table's list price, each kind at its own row at the
// tier the provider billed (`short` or `long` prompt). A kind with no row
// there is never costed lower than the vendor charges: cached input at the
// input price, any other kind at the dearest token rate the model lists at
// either tier. A call that used tokens adds the fee per call, the dearer of
// the two tiers' `request` rows.
export function costOf(usage: Usage, short: Prices, long: Prices): Cost {
  if (usage.reportedCostUsd !== undefined) return { usd: usage.reportedCostUsd, source: "reported", conservative: {} };
  const billed = usage.longPrompt ? long : short;
  const tokenRates = (p: Prices) => Object.entries(p).filter(([kind]) => kind !== "request").map(([, a]) => a?.usdPerMTok ?? 0);
  const ceiling = Math.max(0, ...tokenRates(short), ...tokenRates(long));
  const conservative: Cost["conservative"] = {};
  let usd = 0;
  for (const [count, kind] of USAGE_KINDS) {
    if (!usage[count]) continue;
    let rate = billed[kind]?.usdPerMTok;
    if (rate === undefined) {
      rate = kind === "cached_input" && billed.input ? billed.input.usdPerMTok : ceiling;
      conservative[kind] = rate;
    }
    usd += usage[count] * rate;
  }
  if (USAGE_KINDS.some(([count]) => usage[count] > 0)) usd += Math.max(short.request?.usdPerMTok ?? 0, long.request?.usdPerMTok ?? 0);
  return { usd: usd / 1_000_000, source: "list_price", conservative };
}

// The model's list prices at its location, at the short- and long-prompt
// rows, and its tier, from one read of its rows in the current snapshot. Each
// kind is the dearest row the table has for it there.
export async function modelPrices(db: D1Database, { provider, model, location }: Pick<ModelChoice, "provider" | "model" | "location">): Promise<{ short: Prices; long: Prices; tier?: Tier }> {
  const snapshot = await currentSnapshot(db);
  const rows = snapshot ? await readModelRows(db, snapshot.id, { provider, model }) : [];
  const at = rows.filter((r) => !r.batch && (r.region === location || r.deployment === location));
  const pick = (longPrompt: boolean): Prices => {
    const out: Prices = {};
    for (const r of at.filter((x) => x.longPrompt === longPrompt)) {
      const seen = out[r.tokenKind];
      if (!seen || r.usdPerMTok > seen.usdPerMTok) out[r.tokenKind] = { usdPerMTok: r.usdPerMTok, source: r.source, dateRead: r.dateRead, stale: r.stale };
    }
    return out;
  };
  return { short: pick(false), long: pick(true), tier: modelTier(provider, rows) };
}

const RESUMES = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

export const PROVIDER_NAMES: Record<Provider, string> = { openrouter: "OpenRouter" };

async function attempt(
  db: D1Database,
  plugins: PluginRegistry,
  call: ModelCall,
  choice: ModelChoice,
  fallbackReason: "refused" | "budget_spent" | undefined,
  now: () => Date,
  testCall = false,
): Promise<ProxyOutcome> {
  const { provider, model, location } = choice;
  const base = { provider, model, fallback: fallbackReason !== undefined };
  const refuse = (reason: Refusal, detail: string, extra?: { resumesOn?: string; failure?: Failure; missing?: string[] }): ProxyOutcome => ({
    kind: "refused",
    ...base,
    reason,
    detail,
    ...extra,
  });

  const plugin = plugins[provider];
  if (!plugin) return refuse("no_plugin", `${PROVIDER_NAMES[provider]} is not available yet`);
  if (!plugin.connect.canCall(model)) return refuse("not_callable", `${model} is not offered at ${PROVIDER_NAMES[provider]}: ${plugin.connect.notCallableReason(model)}`);
  if (!plugin.connect.locations(model).includes(location)) return refuse("not_callable", `${PROVIDER_NAMES[provider]} does not offer ${model} at ${location} any more`);

  let { short: prices, long: longPrices, tier } = await modelPrices(db, choice);
  let maxPrice: { inputUsdPerMTok: number; outputUsdPerMTok: number } | undefined;
  if (plugin.connect.isRouter?.(model)) {
    const cap = await readPriceCap(db, call.userId, provider, model);
    if (!cap) return refuse("no_cap", `${model} is priced by the model it picks for each call: set it a price cap on Models › Setup › Providers`);
    const at = (usdPerMTok: number) => ({ usdPerMTok, source: plugin.priceSource[0]!, dateRead: (cap.setAt ?? "").slice(0, 10), stale: false });
    prices = { input: at(cap.input), output: at(cap.output) };
    longPrices = {};
    tier = tierFromInputPrice(cap.input);
    maxPrice = { inputUsdPerMTok: cap.input, outputUsdPerMTok: cap.output };
  }
  if (!prices.input || !prices.output) return refuse("no_price", `${model} has no list price at ${PROVIDER_NAMES[provider]} (${location}) yet`);

  const budget = await readBudget(db, call.userId, provider);
  if (!budget && !testCall) return refuse("no_budget", `set a monthly budget for ${PROVIDER_NAMES[provider]} on Models › Setup › Budgets`);
  const startedAt = now();
  if (budget && (await monthSpend(db, call.userId, provider, startedAt)) >= budget.monthlyUsd) {
    const resumesOn = RESUMES.format(nextMonthStart(startedAt));
    return refuse("budget_spent", `model budget for ${PROVIDER_NAMES[provider]} this month reached. Resumes ${resumesOn}`, { resumesOn });
  }

  const connection = await readConnection(db, call.userId, provider);
  if (!connection) return refuse("not_connected", `${PROVIDER_NAMES[provider]} is not connected`);
  const recordIfRevoked = async (failure: Failure): Promise<void> => {
    if (plugin.connect.classify(failure, connection).reason === "not_set_up") await recordGrantRefused(db, call.userId, provider, now());
  };
  let credential: unknown;
  try {
    credential = await plugin.mintCredential(connection, { userId: call.userId });
  } catch (error) {
    let failure: Failure | undefined;
    if (error instanceof ProviderRefusal) {
      const { step, status, errorName, message } = error.refusal;
      failure = { step: "credential", exchange: step, status, errorName, message };
      await recordIfRevoked(failure);
    }
    // The plug-in's own error is not repeated: it may quote the connection.
    return refuse("credential_failed", `the ${PROVIDER_NAMES[provider]} connection gave no credential; it may have been revoked`, {
      failure,
      missing: error instanceof AppNotConfigured ? error.missing : undefined,
    });
  }

  const t0 = Date.now();
  let status: number;
  let body: unknown;
  let failure: Failure | undefined;
  let callId: string | undefined;
  let usage: Usage = { input: 0, cachedInput: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, longPrompt: false };
  try {
    const reply = await plugin.call({ credential, connection, model, location, request: choice.request, ...(maxPrice ? { maxPrice } : {}) });
    status = reply.status;
    body = reply.body;
    callId = reply.callId;
    if (reply.usage) usage = reply.usage;
    if (status < 200 || status >= 300) failure = { step: "call", status, errorName: reply.error?.name ?? `HTTP ${status}`, message: reply.error?.message ?? "" };
  } catch {
    // No reply at all: the provider failing, as a 5xx is.
    status = 0;
    body = { error: `no reply from ${PROVIDER_NAMES[provider]}` };
  }
  const durationMs = Date.now() - t0;
  const cost = costOf(usage, prices, longPrices);

  await writeLedgerRow(db, {
    userId: call.userId,
    at: startedAt,
    task: call.task,
    site: call.site ?? "none",
    company: call.company,
    runId: call.runId,
    provider,
    model,
    region: location,
    tier,
    pluginVersion: plugin.version,
    status,
    fallbackReason,
    inputTokens: usage.input,
    cachedInputTokens: usage.cachedInput,
    cacheWriteTokens: usage.cacheWrite,
    cacheWrite1hTokens: usage.cacheWrite1h,
    outputTokens: usage.output,
    longPrompt: usage.longPrompt,
    durationMs,
    costUsd: cost.usd,
    costSource: cost.source,
    providerCallId: callId,
    costedConservatively: cost.conservative,
  });
  for (const tokenKind of Object.keys(cost.conservative)) {
    const detail =
      `${model} at ${PROVIDER_NAMES[provider]} (${location}) has no ${usage.longPrompt ? "long-prompt " : ""}list price for ${tokenKind}; ` +
      "its calls are costed above it, each ledger row naming the rate, until the price table has the row.";
    if (await addAlertOncePerDay(db, startedAt, "price_missing", detail)) console.warn(`price missing: ${detail}`);
  }

  if (failure) {
    await recordIfRevoked(failure);
    return { kind: "provider_error", ...base, status, body, failure };
  }
  if (status === 0) return { kind: "provider_error", ...base, status, body };
  return { kind: "answered", ...base, status, body, usage, costUsd: cost.usd };
}

// Why the main model's outcome hands the call to the fallback, or undefined
// when it does not: the provider refusing or failing (no reply at all counts
// as failing), and, for a fallback on another provider only, a spent budget
// or a failed credential at the main model's provider.
export const handOver = (o: ProxyOutcome, fallbackElsewhere: boolean): "refused" | "budget_spent" | undefined => {
  if (o.kind === "refused" && fallbackElsewhere) return o.reason === "budget_spent" ? "budget_spent" : o.reason === "credential_failed" ? "refused" : undefined;
  if (o.kind === "provider_error") return o.status === 0 || fallbackAnswers(o.status) ? "refused" : undefined;
  return undefined;
};

export async function callModel(
  db: D1Database,
  plugins: PluginRegistry,
  call: ModelCall,
  now: () => Date = () => new Date(),
): Promise<ProxyOutcome> {
  if (call.fallback && call.fallback.provider === call.main.provider && call.fallback.model === call.main.model) {
    throw new Error("a task's fallback must be another model");
  }
  const main = await attempt(db, plugins, call, call.main, undefined, now);
  const reason = call.fallback ? handOver(main, call.fallback.provider !== call.main.provider) : undefined;
  if (!reason || !call.fallback) return main;
  return attempt(db, plugins, call, call.fallback, reason, now);
}

// A model's test call (Test with <model>?, src/models/add.ts): one call on `choice`, with
// every check above except that no budget need be set yet (budgets come after
// providers on the setup checklist); a budget set and spent still stops it.
// Its ledger row's task is `test_call`, and it has no fallback.
// Test all models' calls are the same, under their own task name.
export async function sendTestCall(db: D1Database, plugins: PluginRegistry, userId: string, choice: ModelChoice, now: () => Date, task = TEST_TASK): Promise<ProxyOutcome> {
  return attempt(db, plugins, { userId, task, main: choice }, choice, undefined, now, true);
}
