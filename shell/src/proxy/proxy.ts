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
//   the provider's list now drops, refuses or no longer offers there;
// - the model has no input or output list price at that location (`no_price`):
//   the budget stop needs a real price;
// - the user has set no monthly budget for the provider (`no_budget`), except
//   for a Connect test call (`testCall`), which runs before budgets are set;
// - the user's spend at the provider since the 1st has reached the budget
//   (`budget_spent`), until the 1st of next month;
// - the user has not connected the provider (`not_connected`), or the
//   connection gave no credential (`credential_failed`).
//
// One fallback on another provider: when the main model's provider is spent
// (`budget_spent`), its credential fails, or the provider refuses or fails
// the call (429, 408 or 5xx, see plugin.ts), the task's fallback runs once,
// under all the same checks and within its own provider's budget. Any other
// outcome is returned as it is.
//
// Every call sent to a provider writes one ledger row, answered or not, its
// tokens costed at the price table's list price: at the long-prompt rows
// when the provider billed the call at them, and each cache write at its own
// 5-minute or 1-hour row. A kind the call used with no row of its own is
// costed so it can never be below what the vendor charges: cached input at
// the input price, anything else at the dearest rate the table lists for the
// model there. The row names each such kind and its rate, and the
// maintainers get a `price_missing` alert. The
// request and reply bodies pass through untouched and are never logged or
// stored; the credential lives only for the call.
//
// A refusal the plug-in reads as the grant removed on the provider's side
// (`connect.classify` says `not_set_up`), whether minting the credential or
// in the call itself, stops the provider at once and is recorded for T49's
// alert.

import { AppNotConfigured } from "../issuer";
import { lookupPrice, lookupTier, type PriceAnswer } from "../prices/lookup";
import { addAlertOncePerDay } from "../prices/store";
import type { Provider, TokenKind } from "../prices/types";
import { readBudget } from "./budgets";
import { readConnection } from "./connections";
import { monthSpend, nextMonthStart, writeLedgerRow } from "./ledger";
import { recordGrantRefused } from "../providers/revoked";
import { fallbackAnswers, ProviderRefusal, type Failure, type ModelRequest, type PluginRegistry, type Usage } from "./plugin";

export interface ModelChoice {
  provider: Provider;
  model: string;
  // The region or deployment type, as the price table names it.
  location: string;
  // Foundry only: the user's deployment name for the model (Add a model,
  // T17); the plug-in's own default, the model ID, when absent.
  deployment?: string;
  // The Connect test call only: the plug-in's own ID for its test model at
  // `location` (connect.testModelIds), called whatever the provider's list
  // says of the model.
  modelId?: string;
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
  // The task's fallback, on another provider.
  fallback?: ModelChoice;
}

export type Refusal = "no_plugin" | "not_callable" | "no_price" | "no_budget" | "budget_spent" | "not_connected" | "credential_failed";

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
const USAGE_KINDS: ReadonlyArray<readonly [Exclude<keyof Usage, "longPrompt">, TokenKind]> = [
  ["input", "input"],
  ["cachedInput", "cached_input"],
  ["cacheWrite", "cache_write"],
  ["cacheWrite1h", "cache_write_1h"],
  ["output", "output"],
];

type Prices = Partial<Record<TokenKind, PriceAnswer>>;

export interface Cost {
  usd: number;
  // Each kind the call used that had no row of its own at the tier billed,
  // and the rate, in USD per million tokens, it was costed at instead.
  conservative: Partial<Record<TokenKind, number>>;
}

// Tokens at the price table's list price, each kind at its own row at the
// tier the provider billed (`short` or `long` prompt). A kind with no row
// there is never costed lower than the vendor charges: cached input at the
// input price, any other kind at the dearest rate the model lists at either
// tier.
export function costOf(usage: Usage, short: Prices, long: Prices): Cost {
  const billed = usage.longPrompt ? long : short;
  const ceiling = Math.max(...[...Object.values(short), ...Object.values(long)].map((p) => p?.usdPerMTok ?? 0));
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
  return { usd: usd / 1_000_000, conservative };
}

// The model's list prices at its location, at the short- or long-prompt rows.
export async function listPrices(db: D1Database, { provider, model, location }: ModelChoice, longPrompt: boolean): Promise<Prices> {
  const answers = await Promise.all(USAGE_KINDS.map(([, tokenKind]) => lookupPrice(db, { provider, model, location, tokenKind, longPrompt })));
  return Object.fromEntries(USAGE_KINDS.map(([, kind], i) => [kind, answers[i]]));
}

const RESUMES = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

export const PROVIDER_NAMES: Record<Provider, string> = { foundry: "Microsoft Foundry", bedrock: "Amazon Bedrock", vertex: "Google Vertex AI" };

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
  if (!choice.modelId) {
    if (!plugin.connect.canCall(model)) return refuse("not_callable", `${model} is not offered at ${PROVIDER_NAMES[provider]} yet: ${plugin.connect.notCallableReason(model)}`);
    if (!plugin.connect.locations(model).includes(location)) return refuse("not_callable", `${PROVIDER_NAMES[provider]} does not offer ${model} at ${location} any more`);
  }

  const prices = await listPrices(db, choice, false);
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
  let usage: Usage = { input: 0, cachedInput: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, longPrompt: false };
  try {
    const reply = await plugin.call({ credential, connection, model, location, deployment: choice.deployment, modelId: choice.modelId, request: choice.request });
    status = reply.status;
    body = reply.body;
    if (reply.usage) usage = reply.usage;
    if (status < 200 || status >= 300) failure = { step: "call", status, errorName: reply.error?.name ?? `HTTP ${status}`, message: reply.error?.message ?? "" };
  } catch {
    // No reply at all: the provider failing, as a 5xx is.
    status = 0;
    body = { error: `no reply from ${PROVIDER_NAMES[provider]}` };
  }
  const durationMs = Date.now() - t0;
  const cost = costOf(usage, prices, await listPrices(db, choice, true));

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
    tier: await lookupTier(db, { provider, model }),
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
// when it does not: a spent budget, a failed credential, or the provider
// refusing or failing (no reply at all counts as failing).
export const handOver = (o: ProxyOutcome): "refused" | "budget_spent" | undefined => {
  if (o.kind === "refused") return o.reason === "budget_spent" ? "budget_spent" : o.reason === "credential_failed" ? "refused" : undefined;
  if (o.kind === "provider_error") return o.status === 0 || fallbackAnswers(o.status) ? "refused" : undefined;
  return undefined;
};

export async function callModel(
  db: D1Database,
  plugins: PluginRegistry,
  call: ModelCall,
  now: () => Date = () => new Date(),
): Promise<ProxyOutcome> {
  if (call.fallback && call.fallback.provider === call.main.provider) {
    throw new Error("a task's fallback must be on another provider");
  }
  const main = await attempt(db, plugins, call, call.main, undefined, now);
  const reason = handOver(main);
  if (!reason || !call.fallback) return main;
  return attempt(db, plugins, call, call.fallback, reason, now);
}

// The Connect test call (src/providers/check.ts): one call on `choice`, with
// every check above except that no budget need be set yet (budgets come after
// providers on the setup checklist); a budget set and spent still stops it.
// Its ledger row's task is `test_call`, and it has no fallback.
export async function sendTestCall(db: D1Database, plugins: PluginRegistry, userId: string, choice: ModelChoice, now: () => Date): Promise<ProxyOutcome> {
  return attempt(db, plugins, { userId, task: TEST_TASK, main: choice }, choice, undefined, now, true);
}
