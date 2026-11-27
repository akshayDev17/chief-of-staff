// The tasks the app routes model calls by, and the model each one uses
// (design-v3 1.5 and decision 6, T18).
//
//   readTaskRoutes(db, userId) -> TaskRoute[]     one per task, in TASKS order
//   routeTask(db, userId, task) -> Route | undefined
//   acceptProposals(db, userId, now, changes?)    the one tap
//   useFreeModels(db, userId, now, changes?)      the one tap for free models, where nothing is proposed
//   changeTasks(db, userId, changes, now)        the user's own choices, all or none
//   callTask(db, plugins, call, now?) -> ProxyOutcome | NoModel
//
// Only the user's usable models (models/usable.ts: each model whose latest
// test passed, on its row or in Test all models, that the provider still
// offers the user) are ever offered, each named by its provider and model, so
// a second provider plugs in without a change here. A task uses only its
// saved choice: its main model while that is usable; once it is not (a later
// test of the model failed, or the provider dropped it), its saved fallback
// alone while that is usable, which the task shows it runs on, else nothing,
// and the task has no model until the user chooses one. Its calls
// never go to a model the user did not choose for it. A task with no saved
// choice has no model (migration 0013 saved, as accepted choices, the one
// model each user's tasks used before this rule).
//
// A task is offered, proposed and given only models of its own strength
// (the owner, 2026-11-27: "when suggested strenght == Smallest --> the
// dropdown next to it should only contain all passing run models tagged with
// the smallest chip"): a usable model whose strength chip (prices/tiers.ts
// strengthChip, the chip its row shows on Providers) is the task's tier. Each
// task gets a proposal: the cheapest such model as its main model and the
// next cheapest as its fallback, another model (on OpenRouter today, the one
// provider, a fallback is another OpenRouter model). No task is
// Strongest, and none is proposed or offered a model of another strength. A
// saved choice made before this rule, of another strength, keeps running and
// is shown as it is until the user changes it. A free model (prices/openrouter.ts
// isTrulyFreeTextModel: rate-limited, and the provider may log prompts)
// is never proposed: a task uses it only once the
// user chooses it, in its list or, for the tasks with no model and no
// proposal (all of a $0 account's passed models are free), with one tap
// ("Use my free models for N tasks", the owner, 2026-11-27: "use only the
// free models"), which picks by the proposal's own rule among the free models
// of each task's strength (a free model is Smallest, so it takes the Smallest
// tasks) and saves the tasks as the user's own choice. The proposal is used once the user accepts it;
// an accepted task whose proposal has since changed (say a model at another
// provider was added) is pending again and keeps its accepted models until
// the next tap. A task the user changed is never overwritten by a tap.
// Every query is scoped to the user.
//
// `callTask` is how the app makes a task's model call: it sends it to the
// task's main model through the proxy (`callModel`, T12), whose one fallback
// rule hands a refusal (429, 408, 5xx, no reply) to the task's fallback,
// named in its ledger row (and, for a fallback on another provider, a failed
// credential or a spent budget at the main model's provider too).

import { PROVIDERS_PATH, TASK_MODELS_PATH } from "../paths";
import { currentSnapshot, readCurrentCatalog, readSnapshotRows } from "../prices/store";
import { modelTier, strengthChip, tierFromInputPrice, type Tier } from "../prices/tiers";
import type { Provider } from "../prices/types";
import type { ModelRequest, PluginRegistry } from "../proxy/plugin";
import { callModel, type ModelChoice, type ProxyOutcome } from "../proxy/proxy";
import { readPriceCaps } from "./price-caps";
import { readNotUsable, readUsableModels, type NotUsable, type UsableModel } from "./usable";

export interface Task {
  id: string;
  label: string;
  // The owner's tier for it (2026-11-24); never Strongest.
  tier: Exclude<Tier, "Strongest">;
}

export const TASKS: readonly Task[] = [
  { id: "match", label: "Matching questions", tier: "Smallest" },
  { id: "extract", label: "Extracting facts", tier: "Smallest" },
  { id: "score", label: "Scoring roles", tier: "Middle" },
  { id: "fill_form", label: "Filling forms", tier: "Middle" },
  { id: "check_form", label: "Checking a form", tier: "Middle" },
  { id: "cover_letter", label: "Cover letters", tier: "Middle" },
  { id: "free_text", label: "Free-text answers", tier: "Middle" },
  { id: "linkedin_message", label: "LinkedIn invitations and messages", tier: "Smallest" },
];

export const taskById = (id: string): Task | undefined => TASKS.find((t) => t.id === id);

// One of the user's usable models, as its row on Providers shows it: the
// provider's name for it, its strength chip (`tier`; none and `otherFees`
// for a model at $0 a token that is not free), its list price per million
// input and output tokens (a router's is its cap) and whether it is free
// (prices/openrouter.ts isTrulyFreeTextModel).
export interface Offered extends UsableModel {
  name?: string;
  tier?: Tier;
  otherFees?: boolean;
  inputUsd?: number;
  outputUsd?: number;
  free?: boolean;
}

// Whether `m` is of `task`'s strength: the one rule for what a task offers.
export const ofStrength = (task: Task, m: { tier?: Tier }): boolean => m.tier === task.tier;

export interface Route {
  main: Offered;
  fallback?: Offered;
}

export interface TaskRoute {
  task: Task;
  // What the task uses now: the user's choice. Undefined until a proposal is
  // accepted or a model chosen, and while its saved main model is not usable.
  current?: Route & { setHow: "accepted" | "changed" };
  proposal?: Route;
  // The proposal waits for the one tap: the task has no saved choice yet, or
  // its accepted models differ from its proposal now.
  pending: boolean;
  // The task's saved choice names a main model that is not usable now
  // (`main`), for the reason `why`. Its calls go to `fallback`, its saved
  // fallback, while that is usable; without one the task reads "Choose a
  // model". No proposal replaces the choice by itself.
  stopped?: Stopped<Offered> & { why: NotUsable };
  // The task's saved fallback, where it is not usable now, and why: the task
  // has no fallback while it is not, and shows it with the reason.
  fallbackGone?: { provider: Provider; model: string; why: NotUsable };
}

export interface Stopped<M> {
  main: { provider: Provider; model: string };
  fallback?: M;
}

export const modelKey = (m: { provider: Provider; model: string }): string => `${m.provider}|${m.model}`;

// The user's usable models, each as its Providers row shows it, from one read
// of the current price snapshot, model list and the user's price caps.
export async function readOffered(db: D1Database, userId: string): Promise<Offered[]> {
  const models = await readUsableModels(db, userId);
  if (!models.length) return [];
  const snapshot = await currentSnapshot(db);
  const rows = snapshot ? await readSnapshotRows(db, snapshot.id) : [];
  const listed = new Map(((await readCurrentCatalog(db))?.models ?? []).map((m) => [m.id, m]));
  const providers = [...new Set(models.map((m) => m.provider))];
  const caps = new Map(await Promise.all(providers.map(async (p) => [p, await readPriceCaps(db, userId, p)] as const)));
  return models.map((m) => {
    const own = rows.filter((r) => r.provider === m.provider && r.model === m.model);
    const dearest = (kind: "input" | "output"): number | undefined => {
      const at = own.filter((r) => r.tokenKind === kind && !r.longPrompt && !r.batch && (r.region === m.location || r.deployment === m.location)).map((r) => r.usdPerMTok);
      return at.length ? Math.max(...at) : undefined;
    };
    // A router's price is its cap, as on its row.
    const cap = caps.get(m.provider)?.get(m.model);
    const inputUsd = cap ? cap.input : dearest("input");
    const outputUsd = cap ? cap.output : dearest("output");
    const entry = listed.get(m.model);
    const free = entry?.free === true;
    const chip = strengthChip({ tier: cap ? tierFromInputPrice(cap.input) : modelTier(m.provider, own), input: inputUsd, output: outputUsd, free });
    return {
      ...m,
      ...(entry?.name && entry.name !== m.model ? { name: entry.name } : {}),
      ...(chip === "Other fees" ? { otherFees: true } : chip ? { tier: chip } : {}),
      inputUsd,
      outputUsd,
      free,
    };
  });
}

// The models `task` offers, among `models`: those of its strength, the
// cheapest first (by input, then output price), ties by name.
export function offeredFor(task: Task, models: Offered[]): Offered[] {
  return models
    .filter((m) => ofStrength(task, m))
    .sort((a, b) => (a.inputUsd ?? Infinity) - (b.inputUsd ?? Infinity) || (a.outputUsd ?? Infinity) - (b.outputUsd ?? Infinity) || modelKey(a).localeCompare(modelKey(b)));
}

// The cheapest model of the task's strength among `models`; never a free one
// unless `free` says to take only free ones.
const bestFor = (task: Task, models: Offered[], free = false): Offered | undefined => offeredFor(task, models).find((m) => Boolean(m.free) === free);

export function proposeRoute(task: Task, models: Offered[], free = false): Route | undefined {
  const main = bestFor(task, models, free);
  if (!main) return undefined;
  return { main, fallback: bestFor(task, models.filter((m) => modelKey(m) !== modelKey(main)), free) };
}

// The tasks with no model and no proposal, which the user's free models can
// take with one tap, each with the route they would get. A task running on
// its fallback has a model.
export function freeRoutes(offered: Offered[], routes: TaskRoute[]): Array<{ task: Task; route: Route }> {
  return routes.flatMap((r) => {
    if (r.current || r.proposal || r.stopped?.fallback) return [];
    const route = proposeRoute(r.task, offered, true);
    return route ? [{ task: r.task, route }] : [];
  });
}

const sameRoute = (a: Route, b: Route): boolean =>
  modelKey(a.main) === modelKey(b.main) && (a.fallback && modelKey(a.fallback)) === (b.fallback && modelKey(b.fallback));

interface ChoiceRecord {
  task: string;
  main_provider: Provider;
  main_model: string;
  fallback_provider: Provider | null;
  fallback_model: string | null;
  set_how: "accepted" | "changed";
}

const CHOICE_COLUMNS = "task, main_provider, main_model, fallback_provider, fallback_model, set_how";

// A saved choice as models among `byKey` (the user's usable ones): its main
// model and its fallback while the main is there (a fallback not there is
// left out); once the main is not, `stopped`, with the fallback where that is.
// The one rule readTaskRoutes shows and routeTask calls by.
function savedRoute<M extends UsableModel>(r: ChoiceRecord, byKey: Map<string, M>): { main: M; fallback?: M } | { stopped: Stopped<M> } {
  const main = byKey.get(modelKey({ provider: r.main_provider, model: r.main_model }));
  const fallback = r.fallback_provider && r.fallback_model ? byKey.get(modelKey({ provider: r.fallback_provider, model: r.fallback_model })) : undefined;
  if (main) return { main, fallback };
  return { stopped: { main: { provider: r.main_provider, model: r.main_model }, ...(fallback ? { fallback } : {}) } };
}

export async function readTaskRoutes(db: D1Database, userId: string): Promise<{ offered: Offered[]; routes: TaskRoute[] }> {
  const offered = await readOffered(db, userId);
  const byKey = new Map(offered.map((m) => [modelKey(m), m]));
  const { results } = await db
    .prepare(`SELECT ${CHOICE_COLUMNS} FROM task_routes WHERE user_id = ?`)
    .bind(userId)
    .all<ChoiceRecord>();
  const saved = new Map(results.map((r) => [r.task, r]));
  // Every saved model that is not usable now, main or fallback, and why.
  const gone = results.flatMap((r) => [
    { provider: r.main_provider, model: r.main_model },
    ...(r.fallback_provider && r.fallback_model ? [{ provider: r.fallback_provider, model: r.fallback_model }] : []),
  ]).filter((m, i, all) => !byKey.has(modelKey(m)) && all.findIndex((x) => modelKey(x) === modelKey(m)) === i);
  const notUsable = await readNotUsable(db, userId, gone);
  const why = new Map(gone.map((m, i) => [modelKey(m), notUsable[i]!]));
  const routes = TASKS.map((task): TaskRoute => {
    const r = saved.get(task.id);
    const proposal = proposeRoute(task, offered);
    if (!r) return { task, proposal, pending: proposal !== undefined };
    const fallbackRef = r.fallback_provider && r.fallback_model ? { provider: r.fallback_provider, model: r.fallback_model } : undefined;
    const fallbackGone = fallbackRef && why.has(modelKey(fallbackRef)) ? { fallbackGone: { ...fallbackRef, why: why.get(modelKey(fallbackRef))! } } : {};
    const route = savedRoute(r, byKey);
    if ("stopped" in route) return { task, proposal, pending: false, stopped: { ...route.stopped, why: why.get(modelKey(route.stopped.main))! }, ...fallbackGone };
    const pending = r.set_how === "accepted" && proposal !== undefined && !sameRoute(route, proposal);
    return { task, proposal, current: { ...route, setHow: r.set_how }, pending, ...fallbackGone };
  });
  return { offered, routes };
}

const readChoice = (db: D1Database, userId: string, task: string): Promise<ChoiceRecord | null> =>
  db.prepare(`SELECT ${CHOICE_COLUMNS} FROM task_routes WHERE user_id = ? AND task = ?`).bind(userId, task).first<ChoiceRecord>();

// The models a call for `task` goes to, or undefined when the task has none,
// from the user's usable models and the task's one saved choice only, by the
// rule readTaskRoutes shows: its main model and fallback while the main is
// usable; its fallback alone once only that is. A task with no saved choice
// has none. Never a model the user did not choose for the task.
export async function routeTask(db: D1Database, userId: string, task: string): Promise<Route | undefined> {
  const r = await readChoice(db, userId, task);
  if (!r) return undefined;
  const models = await readUsableModels(db, userId);
  const route = savedRoute(r, new Map(models.map((m) => [modelKey(m), m])));
  if (!("stopped" in route)) return route;
  return route.stopped.fallback ? { main: route.stopped.fallback } : undefined;
}

type ModelRef = { provider: Provider; model: string };

function prepareChoiceWrite(db: D1Database, userId: string, task: string, route: { main: ModelRef; fallback?: ModelRef }, setHow: "accepted" | "changed", now: Date): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO task_routes (user_id, task, main_provider, main_model, fallback_provider, fallback_model, set_how, set_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (user_id, task) DO UPDATE SET main_provider = excluded.main_provider, main_model = excluded.main_model,
         fallback_provider = excluded.fallback_provider, fallback_model = excluded.fallback_model, set_how = excluded.set_how, set_at = excluded.set_at`,
    )
    .bind(userId, task, route.main.provider, route.main.model, route.fallback?.provider ?? null, route.fallback?.model ?? null, setHow, now.toISOString());
}

// The one tap: every pending task takes its proposal, all or none, with
// `changes`, the user's own choices for other rows, saved as they chose them
// in the same write (changeTasks): a task the user changed, now or before,
// is kept. Returns how many took their proposal, or the refused change.
export async function acceptProposals(db: D1Database, userId: string, now: Date, changes: TaskChange[] = []): Promise<number | ChangeRefusal> {
  const { offered, routes } = await readTaskRoutes(db, userId);
  const writes = await changeWrites(db, userId, offered, changes, now);
  if (!Array.isArray(writes)) return writes;
  const changed = new Set(changes.map((c) => c.task));
  const pending = routes.filter((r) => r.pending && !changed.has(r.task.id));
  const all = [...writes, ...pending.map((r) => prepareChoiceWrite(db, userId, r.task.id, r.proposal!, "accepted", now))];
  if (all.length) await db.batch(all);
  return pending.length;
}

// The one tap for free models: every task with no model and no proposal
// takes the user's free models by the proposal's rule, saved as the user's
// own choice (a later proposal never overwrites it), with `changes` saved as
// acceptProposals saves them. Returns the tasks set, or the refused change.
export async function useFreeModels(db: D1Database, userId: string, now: Date, changes: TaskChange[] = []): Promise<Array<{ task: Task; route: Route }> | ChangeRefusal> {
  const { offered, routes } = await readTaskRoutes(db, userId);
  const writes = await changeWrites(db, userId, offered, changes, now);
  if (!Array.isArray(writes)) return writes;
  const changed = new Set(changes.map((c) => c.task));
  const set = freeRoutes(offered, routes).filter((s) => !changed.has(s.task.id));
  const all = [...writes, ...set.map((s) => prepareChoiceWrite(db, userId, s.task.id, s.route, "changed", now))];
  if (all.length) await db.batch(all);
  return set;
}

export type ChangeProblem = "no_such_task" | "no_main" | "not_your_model" | "wrong_strength" | "same_model";

// One task's choice as the user sent it: each model named by provider and
// model (modelKey), the fallback "" for none.
export interface TaskChange {
  task: string;
  main: string;
  fallback: string;
}

const parseKey = (key: string): ModelRef | undefined => {
  const at = key.indexOf("|");
  return at > 0 && at < key.length - 1 ? { provider: key.slice(0, at) as Provider, model: key.slice(at + 1) } : undefined;
};

export interface ChangeRefusal {
  task: string;
  problem: ChangeProblem;
}

// The writes that set each task to the models the user chose, among
// `offered` (their usable models): each one of the task's strength, the
// fallback another model or none. A model the task's saved choice already
// names in that role may stay as it is, whatever it is now (one of another
// strength saved before the rule, or one no longer usable, which then still
// reads as it does), so a change to one role never forces the other. Returns
// the first refused change and why instead, so nothing is written.
async function changeWrites(db: D1Database, userId: string, offered: Offered[], changes: TaskChange[], now: Date): Promise<D1PreparedStatement[] | ChangeRefusal> {
  const byKey = new Map(offered.map((m) => [modelKey(m), m]));
  const writes: D1PreparedStatement[] = [];
  for (const c of changes) {
    const task = taskById(c.task);
    if (!task) return { task: c.task, problem: "no_such_task" };
    if (!c.main) return { task: c.task, problem: "no_main" };
    const saved = await readChoice(db, userId, c.task);
    const kept = (role: "main" | "fallback"): string | undefined => {
      const provider = saved?.[`${role}_provider`];
      const model = saved?.[`${role}_model`];
      return provider && model ? modelKey({ provider, model }) : undefined;
    };
    const pick = (key: string, role: "main" | "fallback"): ModelRef | ChangeProblem => {
      if (key === kept(role)) return parseKey(key)!;
      const m = byKey.get(key);
      if (!m) return "not_your_model";
      return ofStrength(task, m) ? m : "wrong_strength";
    };
    const main = pick(c.main, "main");
    if (typeof main === "string") return { task: c.task, problem: main };
    const fallback = c.fallback ? pick(c.fallback, "fallback") : undefined;
    if (typeof fallback === "string") return { task: c.task, problem: fallback };
    if (fallback && modelKey(fallback) === modelKey(main)) return { task: c.task, problem: "same_model" };
    writes.push(prepareChoiceWrite(db, userId, c.task, { main, fallback }, "changed", now));
  }
  return writes;
}

// Sets each task to the models the user chose, all or none (changeWrites).
// Returns the first refused change and why, or undefined once all are saved.
export async function changeTasks(db: D1Database, userId: string, changes: TaskChange[], now: Date): Promise<ChangeRefusal | undefined> {
  const writes = await changeWrites(db, userId, await readOffered(db, userId), changes, now);
  if (!Array.isArray(writes)) return writes;
  if (writes.length) await db.batch(writes);
  return undefined;
}

export interface TaskCall {
  userId: string;
  task: string;
  site?: string;
  company?: string;
  runId?: string;
  // The request in the given provider's own format: main and fallback may
  // be on providers that take different formats.
  request: (model: { provider: Provider; model: string }) => ModelRequest;
}

export interface NoModel {
  kind: "no_model";
  task: string;
  detail: string;
}

const choiceOf = (m: Offered, call: TaskCall): ModelChoice => ({
  provider: m.provider,
  model: m.model,
  location: m.location,
  request: call.request(m),
});

export async function callTask(
  db: D1Database,
  plugins: PluginRegistry,
  call: TaskCall,
  now: () => Date = () => new Date(),
): Promise<ProxyOutcome | NoModel> {
  const route = await routeTask(db, call.userId, call.task);
  if (!route) {
    const choice = await readChoice(db, call.userId, call.task);
    const [why] = choice ? await readNotUsable(db, call.userId, [{ provider: choice.main_provider, model: choice.main_model }]) : [];
    return {
      kind: "no_model",
      task: call.task,
      detail: !choice
        ? `no model chosen for this task: choose one for it on Models › Setup › Model for each task (${TASK_MODELS_PATH})`
        : why === "earlier_key"
          ? `no usable model for this task: its model needs a test on the new key; run Test all models on Models › Setup › Providers and models (${PROVIDERS_PATH})`
          : "no usable model for this task: test its model again on Models › Setup › Providers and models, or choose another on Model for each task",
    };
  }
  const { userId, task, site, company, runId } = call;
  return callModel(
    db,
    plugins,
    { userId, task, site, company, runId, main: choiceOf(route.main, call), fallback: route.fallback && choiceOf(route.fallback, call) },
    now,
  );
}
