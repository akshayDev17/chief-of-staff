// The model proxy core (design-v3 1.4, 1.7, 1.8). It knows no provider: the
// provider's plug-in mints the credential and makes the call; the core
// prices, enforces the budget, picks the fallback and writes the ledger.
//
//   callModel(db, plugins, call, now?) -> ProxyOutcome
//
// Before sending a call to a provider the core refuses it when:
// - no plug-in serves the provider (`no_plugin`);
// - the model has no input or output list price at that location (`no_price`):
//   the budget stop needs a real price;
// - the user has set no monthly budget for the provider (`no_budget`);
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
// Every call sent to a provider writes one ledger row, answered or not. The
// request and reply bodies pass through untouched and are never logged or
// stored; the credential lives only for the call.

import { lookupPrice, lookupTier, type PriceAnswer } from "../prices/lookup";
import type { Provider, TokenKind } from "../prices/types";
import { readBudget } from "./budgets";
import { readConnection } from "./connections";
import { monthSpend, nextMonthStart, writeLedgerRow } from "./ledger";
import { fallbackAnswers, type ModelRequest, type PluginRegistry, type Usage } from "./plugin";

export interface ModelChoice {
  provider: Provider;
  model: string;
  // The region or deployment type, as the price table names it.
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
  // The task's fallback, on another provider.
  fallback?: ModelChoice;
}

export type Refusal = "no_plugin" | "no_price" | "no_budget" | "budget_spent" | "not_connected" | "credential_failed";

export type ProxyOutcome =
  | { kind: "answered"; provider: Provider; model: string; fallback: boolean; status: number; body: unknown }
  // The provider's own refusal or failure, passed back as it came.
  | { kind: "provider_error"; provider: Provider; model: string; fallback: boolean; status: number; body: unknown }
  | { kind: "refused"; provider: Provider; model: string; fallback: boolean; reason: Refusal; detail: string; resumesOn?: string };

const PRICED_KINDS: readonly TokenKind[] = ["input", "cached_input", "cache_write", "output"];

type Prices = Partial<Record<TokenKind, PriceAnswer>>;

// Tokens at the price table's list price. A model with no cached-input or
// cache-write row has those tokens costed at its input price.
export function costOf(usage: Usage, prices: Prices): number {
  const input = prices.input!.usdPerMTok;
  const cached = prices.cached_input?.usdPerMTok ?? input;
  const cacheWrite = prices.cache_write?.usdPerMTok ?? input;
  const output = prices.output!.usdPerMTok;
  return (usage.input * input + usage.cachedInput * cached + usage.cacheWrite * cacheWrite + usage.output * output) / 1_000_000;
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
): Promise<ProxyOutcome> {
  const { provider, model, location } = choice;
  const base = { provider, model, fallback: fallbackReason !== undefined };
  const refuse = (reason: Refusal, detail: string, resumesOn?: string): ProxyOutcome => ({ kind: "refused", ...base, reason, detail, resumesOn });

  const plugin = plugins[provider];
  if (!plugin) return refuse("no_plugin", `${PROVIDER_NAMES[provider]} is not available yet`);

  const prices: Prices = {};
  const answers = await Promise.all(PRICED_KINDS.map((tokenKind) => lookupPrice(db, { provider, model, location, tokenKind })));
  PRICED_KINDS.forEach((kind, i) => (prices[kind] = answers[i]));
  if (!prices.input || !prices.output) return refuse("no_price", `${model} has no list price at ${PROVIDER_NAMES[provider]} (${location}) yet`);

  const budget = await readBudget(db, call.userId, provider);
  if (!budget) return refuse("no_budget", `set a monthly budget for ${PROVIDER_NAMES[provider]} on Models › Setup › Budgets`);
  const startedAt = now();
  if ((await monthSpend(db, call.userId, provider, startedAt)) >= budget.monthlyUsd) {
    const resumesOn = RESUMES.format(nextMonthStart(startedAt));
    return refuse("budget_spent", `model budget for ${PROVIDER_NAMES[provider]} this month reached. Resumes ${resumesOn}`, resumesOn);
  }

  const connection = await readConnection(db, call.userId, provider);
  if (!connection) return refuse("not_connected", `${PROVIDER_NAMES[provider]} is not connected`);
  let credential: unknown;
  try {
    credential = await plugin.mintCredential(connection);
  } catch {
    // The plug-in's own error is not repeated: it may quote the connection.
    return refuse("credential_failed", `the ${PROVIDER_NAMES[provider]} connection gave no credential; it may have been revoked`);
  }

  const t0 = Date.now();
  let status: number;
  let body: unknown;
  let usage: Usage = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
  try {
    const reply = await plugin.call({ credential, connection, model, location, request: choice.request });
    status = reply.status;
    body = reply.body;
    if (reply.usage) usage = reply.usage;
  } catch {
    // No reply at all: the provider failing, as a 5xx is.
    status = 0;
    body = { error: `no reply from ${PROVIDER_NAMES[provider]}` };
  }
  const durationMs = Date.now() - t0;

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
    outputTokens: usage.output,
    durationMs,
    costUsd: costOf(usage, prices),
  });

  const kind = status >= 200 && status < 300 ? "answered" : "provider_error";
  return { kind, ...base, status, body };
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
