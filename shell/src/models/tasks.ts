// The tasks the app routes model calls by, and the model each one uses
// (design-v3 1.5 and decision 6, T18).
//
//   readTaskRoutes(db, userId) -> TaskRoute[]     one per task, in TASKS order
//   routeTask(db, userId, task) -> Route | undefined
//   acceptProposals(db, userId, now)              the one tap
//   useFreeModels(db, userId, now)                the one tap for free models, where nothing is proposed
//   changeTask(db, userId, task, main, fallback?, now)
//   callTask(db, plugins, call, now?) -> ProxyOutcome | NoModel
//
// Only the user's own passed models (user_models, T17: chosen one by one, or
// added from Test all models' results) are ever offered, each named by its
// provider and model, so a second provider plugs in without a change here.
// With one passed model every task uses it, unless it is free. Otherwise each
// task gets a proposal: a main model
// at the task's strength and a fallback at that strength, another of the
// user's models (on OpenRouter today, the one provider, a fallback is another
// OpenRouter model), each model's strength (tier) worked out from its price
// (tiers.ts, T11). No task is proposed the Strongest tier; where
// the user has no model of the task's own strength, the other non-Strongest
// tier is proposed instead. A free model ($0 in and out, such as
// OpenRouter's `:free` ones: rate-limited, and the provider may log prompts)
// is never proposed, nor used as the one model: a task uses it only once the
// user chooses it, with Change or, for every task with no model and no
// proposal (all of a $0 account's passed models are free), with one tap
// ("Use my free models for every task", the owner, 2026-11-27: "use only the
// free models"), which picks by the proposal's own rule and saves the tasks
// as the user's own choice. The proposal is used once the user accepts it;
// an accepted task whose proposal has since changed (say a model at another
// provider was added) is pending again and keeps its accepted models until
// the next tap. Any task can be changed to any of the user's models, the
// Strongest included, and a changed task is never overwritten by a tap.
// Every query is scoped to the user.
//
// `callTask` is how the app makes a task's model call: it sends it to the
// task's main model through the proxy (`callModel`, T12), whose one fallback
// rule hands a refusal (429, 408, 5xx, no reply) to the task's fallback,
// named in its ledger row (and, for a fallback on another provider, a failed
// credential or a spent budget at the main model's provider too).

import { currentSnapshot, readSnapshotRows } from "../prices/store";
import { modelTier, type Tier } from "../prices/tiers";
import type { Provider } from "../prices/types";
import type { ModelRequest, PluginRegistry } from "../proxy/plugin";
import { callModel, modelPrices, type ModelChoice, type ProxyOutcome } from "../proxy/proxy";
import { isFree, readUserModels, type UserModel } from "./add";

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

// One of the user's passed models, with its strength and input price, and
// whether it is free ($0 in and out).
export interface Offered extends UserModel {
  tier?: Tier;
  inputUsd?: number;
  free?: boolean;
}

export interface Route {
  main: Offered;
  fallback?: Offered;
}

export interface TaskRoute {
  task: Task;
  // What the task uses now: the user's choice, or with one passed model
  // that model. Undefined until a proposal is accepted or a model chosen.
  current?: Route & { setHow: "accepted" | "changed" | "only_model" };
  proposal?: Route;
  // The proposal waits for the one tap: the task has no model yet, or its
  // accepted models differ from its proposal now.
  pending: boolean;
}

export const modelKey = (m: { provider: Provider; model: string }): string => `${m.provider}|${m.model}`;

// The user's passed models with each one's tier, input price and whether it
// is free, from one read of the current price snapshot.
export async function readOffered(db: D1Database, userId: string): Promise<Offered[]> {
  const models = await readUserModels(db, userId);
  const snapshot = models.length ? await currentSnapshot(db) : undefined;
  const rows = snapshot ? await readSnapshotRows(db, snapshot.id) : [];
  return models.map((m) => {
    const own = rows.filter((r) => r.provider === m.provider && r.model === m.model);
    const dearest = (kind: "input" | "output"): number | undefined => {
      const at = own.filter((r) => r.tokenKind === kind && !r.longPrompt && !r.batch && (r.region === m.location || r.deployment === m.location)).map((r) => r.usdPerMTok);
      return at.length ? Math.max(...at) : undefined;
    };
    const inputUsd = dearest("input");
    return { ...m, tier: modelTier(m.provider, own), inputUsd, free: isFree({ input: inputUsd, output: dearest("output") }) };
  });
}

// The one model every task uses: the user's only passed model, unless it is free.
export const onlyModel = (offered: Offered[]): Offered | undefined => (offered.length === 1 && !offered[0]!.free ? offered[0] : undefined);

const PREFERRED: Record<Task["tier"], readonly Tier[]> = { Smallest: ["Smallest", "Middle"], Middle: ["Middle", "Smallest"] };

// The cheapest model at the nearest proposable strength, among `models`;
// never a free one unless `free` says to take only free ones.
function bestFor(task: Task, models: Offered[], free = false): Offered | undefined {
  for (const tier of PREFERRED[task.tier]) {
    const at = models.filter((m) => m.tier === tier && Boolean(m.free) === free).sort((a, b) => (a.inputUsd ?? Infinity) - (b.inputUsd ?? Infinity) || modelKey(a).localeCompare(modelKey(b)));
    if (at[0]) return at[0];
  }
  return undefined;
}

export function proposeRoute(task: Task, models: Offered[], free = false): Route | undefined {
  const main = bestFor(task, models, free);
  if (!main) return undefined;
  return { main, fallback: bestFor(task, models.filter((m) => modelKey(m) !== modelKey(main)), free) };
}

// The tasks with no model and no proposal, which the user's free models can
// take with one tap, each with the route they would get.
export function freeRoutes(offered: Offered[], routes: TaskRoute[]): Array<{ task: Task; route: Route }> {
  return routes.flatMap((r) => {
    if (r.current || r.proposal) return [];
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

// A saved choice as models among `byKey` (the user's own); a choice whose
// main model is no longer there is ignored, as is a fallback no longer there.
function savedRoute<M extends UserModel>(r: ChoiceRecord, byKey: Map<string, M>): { main: M; fallback?: M } | undefined {
  const main = byKey.get(modelKey({ provider: r.main_provider, model: r.main_model }));
  if (!main) return undefined;
  const fallback = r.fallback_provider && r.fallback_model ? byKey.get(modelKey({ provider: r.fallback_provider, model: r.fallback_model })) : undefined;
  return { main, fallback };
}

export async function readTaskRoutes(db: D1Database, userId: string): Promise<{ offered: Offered[]; routes: TaskRoute[] }> {
  const offered = await readOffered(db, userId);
  const byKey = new Map(offered.map((m) => [modelKey(m), m]));
  const { results } = await db
    .prepare(`SELECT ${CHOICE_COLUMNS} FROM task_routes WHERE user_id = ?`)
    .bind(userId)
    .all<ChoiceRecord>();
  const saved = new Map(results.map((r) => [r.task, r]));
  const only = onlyModel(offered);
  const routes = TASKS.map((task): TaskRoute => {
    if (only) return { task, current: { main: only, setHow: "only_model" }, pending: false };
    const proposal = proposeRoute(task, offered);
    const r = saved.get(task.id);
    const route = r && savedRoute(r, byKey);
    if (!r || !route) return { task, proposal, pending: proposal !== undefined };
    const pending = r.set_how === "accepted" && proposal !== undefined && !sameRoute(route, proposal);
    return { task, proposal, current: { ...route, setHow: r.set_how }, pending };
  });
  return { offered, routes };
}

// The models a call for `task` goes to, or undefined when the task has none:
// what `readTaskRoutes` names its current route, read from the user's models
// and the task's one saved choice only.
export async function routeTask(db: D1Database, userId: string, task: string): Promise<Route | undefined> {
  const models = await readUserModels(db, userId);
  if (models.length === 1) {
    const { short } = await modelPrices(db, models[0]!);
    if (!isFree({ input: short.input?.usdPerMTok, output: short.output?.usdPerMTok })) return { main: models[0]! };
  }
  const r = await db.prepare(`SELECT ${CHOICE_COLUMNS} FROM task_routes WHERE user_id = ? AND task = ?`).bind(userId, task).first<ChoiceRecord>();
  return r ? savedRoute(r, new Map(models.map((m) => [modelKey(m), m]))) : undefined;
}

function prepareChoiceWrite(db: D1Database, userId: string, task: string, route: Route, setHow: "accepted" | "changed", now: Date): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO task_routes (user_id, task, main_provider, main_model, fallback_provider, fallback_model, set_how, set_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (user_id, task) DO UPDATE SET main_provider = excluded.main_provider, main_model = excluded.main_model,
         fallback_provider = excluded.fallback_provider, fallback_model = excluded.fallback_model, set_how = excluded.set_how, set_at = excluded.set_at`,
    )
    .bind(userId, task, route.main.provider, route.main.model, route.fallback?.provider ?? null, route.fallback?.model ?? null, setHow, now.toISOString());
}

// The one tap: every pending task takes its proposal, all or none. A task
// the user changed is kept. Returns how many were set.
export async function acceptProposals(db: D1Database, userId: string, now: Date): Promise<number> {
  const { routes } = await readTaskRoutes(db, userId);
  const pending = routes.filter((r) => r.pending);
  if (pending.length) await db.batch(pending.map((r) => prepareChoiceWrite(db, userId, r.task.id, r.proposal!, "accepted", now)));
  return pending.length;
}

// The one tap for free models: every task with no model and no proposal
// takes the user's free models by the proposal's rule, saved as the user's
// own choice (a later proposal never overwrites it). Returns the tasks set.
export async function useFreeModels(db: D1Database, userId: string, now: Date): Promise<Array<{ task: Task; route: Route }>> {
  const { offered, routes } = await readTaskRoutes(db, userId);
  const set = freeRoutes(offered, routes);
  if (set.length) await db.batch(set.map((s) => prepareChoiceWrite(db, userId, s.task.id, s.route, "changed", now)));
  return set;
}

export type ChangeProblem = "no_such_task" | "not_your_model" | "same_model";

// Sets one task to models the user chose, each one of their passed models
// named by provider and model; the fallback, if any, another model.
export async function changeTask(
  db: D1Database,
  userId: string,
  task: string,
  main: string,
  fallback: string | undefined,
  now: Date,
): Promise<ChangeProblem | undefined> {
  if (!taskById(task)) return "no_such_task";
  const offered = await readOffered(db, userId);
  const byKey = new Map(offered.map((m) => [modelKey(m), m]));
  const mainModel = byKey.get(main);
  const fallbackModel = fallback ? byKey.get(fallback) : undefined;
  if (!mainModel || (fallback && !fallbackModel)) return "not_your_model";
  if (fallbackModel && modelKey(fallbackModel) === modelKey(mainModel)) return "same_model";
  await prepareChoiceWrite(db, userId, task, { main: mainModel, fallback: fallbackModel }, "changed", now).run();
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
    return { kind: "no_model", task: call.task, detail: "choose a model for this task on Models › Setup › Model for each task" };
  }
  const { userId, task, site, company, runId } = call;
  return callModel(
    db,
    plugins,
    { userId, task, site, company, runId, main: choiceOf(route.main, call), fallback: route.fallback && choiceOf(route.fallback, call) },
    now,
  );
}
