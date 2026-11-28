// Try it on Models › Setup › Model for each task: one short real call for a
// task, through the very pipeline every task's own calls use (the owner,
// 2026-11-28: "the pipeline that each task will eventually have to subscribe
// to and use is the one being tested").
//
//   tryTask(db, plugins, userId, taskId, now?) -> TryOutcome
//
// What it proves is that pipeline only, never a task's quality: the user's
// key works for real calls, a call goes only to the model the task saved,
// the fallback answers once when the main model fails, the tokens and cost
// are the provider's own, the budget stop holds, a router carries its price
// cap, and the call is in the month's ledger. In order:
//
// 1. The task's saved choice (tasks.ts readChoice). None: refused, no call.
// 2. `callTask` with the task's one fixed sample prompt (Task.sample), as the
//    provider's own request (`connect.promptRequest`), the reply capped at
//    TRY_MAX_TOKENS. callTask routes it by the saved choice alone, the proxy
//    prices it, stops it at the budget (none set, or spent, is refused
//    before any request to the model), carries a router's cap, hands a
//    failed main call to the fallback once and writes one ledger row per
//    call sent; a failed model is marked Failed when used (ready.ts
//    recordUse).
// 3. The month's spend after it, from that same ledger (ledger.ts
//    monthSpend), the figure the budget bar and Models › Usage count.
//
// It never writes the task's saved choice.

import { BUDGETS_PATH, PROVIDERS_PATH, TASK_MODELS_PATH } from "../paths";
import { readConnection } from "../proxy/connections";
import { readBudget } from "../proxy/budgets";
import { monthSpend } from "../proxy/ledger";
import type { Failure, Link, PluginRegistry, ProviderPlugin, Usage } from "../proxy/plugin";
import { PROVIDER_NAMES, type ProxyOutcome } from "../proxy/proxy";
import type { Provider } from "../prices/types";
import { CONNECT_AGAIN, reasonText, readCheck, removedText } from "../providers/check";
import { rowAnchor, viewQuery } from "../providers/models-table";
import { marksModel } from "./ready";
import { callTask, readChoice, taskById, type Task } from "./tasks";

// The reply's cap: room for a short answer, and for a reasoning model's
// thinking before it.
export const TRY_MAX_TOKENS = 300;

type Ref = { provider: Provider; model: string };

// A model that did not answer, in plain words, with the provider's own
// where it replied. `marked`: its Providers row now reads Failed when used.
// `actions`: what answers it, where its reason has a direct one (no model
// fits: the provider's settings, and a router's Change cap).
export interface TryFailure extends Ref {
  role: "main" | "fallback";
  reason: string;
  reply?: string;
  marked: boolean;
  actions?: Link[];
}

export type TryOutcome =
  | {
      kind: "answered";
      task: Task;
      model: Ref;
      // Which of the task's saved models answered.
      role: "main" | "fallback";
      // The model a router picked for the call, as its reply names it.
      picked?: string;
      // The main model's failure the fallback answered.
      mainFailed?: TryFailure;
      text?: string;
      usage: Usage;
      costUsd: number;
      // The cost is the provider's own figure from its reply; else the price
      // table's list price (proxy.ts costOf).
      costReported: boolean;
      durationMs: number;
      // The provider's own ID for the call, to find it in its records.
      callId?: string;
      month: { spentUsd: number; budgetUsd?: number };
    }
  | {
      kind: "refused";
      task?: Task;
      // The plain sentence, and the one action that fixes it, where one does.
      reason: string;
      action?: Link;
      // The models that did not answer: one that failed at the provider, and,
      // when the fallback ran, both, each with its own reason.
      failed: TryFailure[];
    };

const budgetsLink = (label: string): Link => ({ label, href: BUDGETS_PATH });
// A router's row on Providers, its price cap open.
const capHref = (provider: Provider, model: string): string => `${PROVIDERS_PATH}?${viewQuery(provider, { cap: model })}#${rowAnchor(model)}`;

// The plain reason a call that reached the provider failed, and whether it
// marked its model, by the same rule as recordUse.
function failureOf(o: Extract<ProxyOutcome, { kind: "provider_error" }>, role: TryFailure["role"], plugin: ProviderPlugin | undefined, connection: Record<string, string> | undefined): TryFailure {
  const ref = { provider: o.provider, model: o.model, role };
  const short = plugin?.connect.guide.short ?? PROVIDER_NAMES[o.provider];
  if (!o.failure || !plugin) return { ...ref, reason: `No reply from ${short}.`, marked: false };
  const failure: Failure = o.failure;
  const plain = plugin.connect.classify(failure, connection);
  // "404 No endpoints found…", the error's own name too where it is not just the status.
  const name = failure.errorName && failure.errorName !== `HTTP ${failure.status}` ? `${failure.errorName}: ` : "";
  const reply = `${failure.status} ${name}${failure.message}`.trim();
  const changeCap = plugin.connect.isRouter?.(o.model) ? [{ label: "Change cap", href: capHref(o.provider, o.model) }] : [];
  const actions = plain.reason === "no_fit" ? [...plain.links, ...changeCap] : [];
  return { ...ref, reason: reasonText(plain.reason, plugin), reply, marked: marksModel(plain.reason), ...(actions.length ? { actions } : {}) };
}

// The plain reason for a call refused before it was sent, with its fix.
function refusalOf(o: Extract<ProxyOutcome, { kind: "refused" }>, plugin: ProviderPlugin | undefined): { reason: string; action?: Link } {
  const name = plugin?.connect.guide.name ?? PROVIDER_NAMES[o.provider];
  switch (o.reason) {
    case "no_budget":
      return { reason: `Set a monthly budget for ${name} first.`, action: budgetsLink("Set a budget") };
    case "budget_spent":
      return { reason: `This month's budget is spent. Calls resume ${o.resumesOn}.`, action: budgetsLink("Raise the budget") };
    case "not_connected":
    case "credential_failed":
      return { reason: o.reason === "not_connected" ? `${name} is not connected.` : `The ${name} connection gave no key.`, action: { label: `Connect ${name}`, href: PROVIDERS_PATH } };
    case "no_cap":
      return { reason: "This router needs a price cap.", action: { label: "Set its price cap", href: capHref(o.provider, o.model) } };
    case "no_price":
      return { reason: "This model has no price yet, so the budget stop can't count it." };
    default:
      return { reason: `The app can't call ${o.model} now.` };
  }
}

// One Try it: the task's sample prompt on its saved models, never changing them.
export async function tryTask(db: D1Database, plugins: PluginRegistry, userId: string, taskId: string, now: () => Date = () => new Date()): Promise<TryOutcome> {
  const task = taskById(taskId);
  if (!task) return { kind: "refused", reason: "There is no such task.", failed: [] };
  const saved = await readChoice(db, userId, task.id);
  const chooseLink = { label: "Choose a model", href: `${TASK_MODELS_PATH}#task-${task.id}` };
  if (!saved) return { kind: "refused", task, reason: "Save a model for this task first.", action: chooseLink, failed: [] };

  const outcome = await callTask(
    db,
    plugins,
    { userId, task: task.id, request: (m) => plugins[m.provider]!.connect.promptRequest(task.sample, TRY_MAX_TOKENS) },
    now,
  );
  if (outcome.kind === "no_model") return { kind: "refused", task, reason: "Its saved models are no longer offered. Choose another.", action: chooseLink, failed: [] };

  const connection = await readConnection(db, userId, saved.main_provider);
  const main = outcome.fellBackFrom;
  // Once the fallback ran, a model refused before sending did not answer either.
  const failedOf = (o: ProxyOutcome, role: TryFailure["role"]): TryFailure[] =>
    o.kind === "provider_error"
      ? [failureOf(o, role, plugins[o.provider], connection)]
      : o.kind === "refused" && main
        ? [{ provider: o.provider, model: o.model, role, reason: refusalOf(o, plugins[o.provider]).reason, marked: false }]
        : [];
  const mainFailed = main ? failedOf(main, "main") : [];
  if (outcome.kind === "answered") {
    const isFallback = saved.fallback_model === outcome.model && saved.fallback_provider === outcome.provider;
    const budgetNow = await readBudget(db, userId, outcome.provider);
    const answeredBy = plugins[outcome.provider];
    const picked = answeredBy?.connect.isRouter?.(outcome.model) ? answeredBy.connect.replyModel(outcome.body) : undefined;
    return {
      kind: "answered",
      task,
      model: { provider: outcome.provider, model: outcome.model },
      role: isFallback ? "fallback" : "main",
      ...(picked && picked !== outcome.model ? { picked } : {}),
      ...(mainFailed[0] ? { mainFailed: mainFailed[0] } : {}),
      text: plugins[outcome.provider]?.connect.replyText(outcome.body),
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      costReported: outcome.usage.reportedCostUsd !== undefined,
      durationMs: outcome.durationMs,
      ...(outcome.callId ? { callId: outcome.callId } : {}),
      month: { spentUsd: await monthSpend(db, userId, outcome.provider, now()), ...(budgetNow ? { budgetUsd: budgetNow.monthlyUsd } : {}) },
    };
  }
  const failed = [...mainFailed, ...failedOf(outcome, main ? "fallback" : "main")];
  if (outcome.kind === "provider_error") {
    const last = failed.at(-1)!;
    // The key removed on the provider's side: the proxy recorded it as
    // revoked (revoked.ts), the state Providers reads too, so both say the
    // same and offer the same Connect.
    const plugin = plugins[outcome.provider];
    if (plugin && last.reason === reasonText("not_set_up", plugin) && (await readCheck(db, userId, outcome.provider))?.state === "revoked") {
      return { kind: "refused", task, reason: `${removedText(plugin)}.`, action: { label: CONNECT_AGAIN, href: PROVIDERS_PATH }, failed: failed.map((f) => (f.provider === outcome.provider ? { ...f, reason: `${removedText(plugin)}.` } : f)) };
    }
    return { kind: "refused", task, reason: last.reason, failed };
  }
  return { kind: "refused", task, ...refusalOf(outcome, plugins[outcome.provider]), failed };
}
