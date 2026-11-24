// The tasks the app routes model calls by, and the model each one uses
// (design-v3 1.5 and decision 6, T18).
//
//   readTaskRoutes(db, userId) -> TaskRoute[]     one per task, in TASKS order
//   routeTask(db, userId, task) -> Route | undefined
//   acceptProposals(db, userId, now)              the one tap
//   changeTask(db, userId, task, main, fallback?, now)
//   callTask(db, plugins, call, now?) -> ProxyOutcome | NoModel
//
// Only the user's own passed models (user_models, T17) are ever offered.
// With one passed model every task uses it. Otherwise each task gets a
// proposal: a main model at the task's strength and a fallback at that
// strength on another provider, each model's strength (tier) worked out from
// its price (lookupTier, T11). No task is proposed the Strongest tier; where
// the user has no model of the task's own strength, the other non-Strongest
// tier is proposed instead. The proposal is used once the user accepts it;
// any task can be changed to any of the user's models, the Strongest
// included. Every query is scoped to the user.
//
// `callTask` is how the app makes a task's model call: it sends it to the
// task's main model through the proxy (`callModel`, T12), whose one fallback
// rule hands a refusal (429, 408, 5xx, no reply), a failed credential or a
// spent budget at the main model's provider to the task's fallback, named in
// its ledger row.

import { lookupPrice, lookupTier } from "../prices/lookup";
import type { Tier } from "../prices/tiers";
import type { Provider } from "../prices/types";
import type { ModelRequest, PluginRegistry } from "../proxy/plugin";
import { callModel, type ModelChoice, type ProxyOutcome } from "../proxy/proxy";
import { readUserModels, type UserModel } from "./add";

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

// One of the user's passed models, with its strength and input price.
export interface Offered extends UserModel {
  tier?: Tier;
  inputUsd?: number;
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
}

export const modelKey = (m: { provider: Provider; model: string }): string => `${m.provider}|${m.model}`;

export async function readOffered(db: D1Database, userId: string): Promise<Offered[]> {
  const models = await readUserModels(db, userId);
  return Promise.all(
    models.map(async (m) => ({
      ...m,
      tier: await lookupTier(db, m),
      inputUsd: (await lookupPrice(db, { provider: m.provider, model: m.model, location: m.location, tokenKind: "input" }))?.usdPerMTok,
    })),
  );
}

const PREFERRED: Record<Task["tier"], readonly Tier[]> = { Smallest: ["Smallest", "Middle"], Middle: ["Middle", "Smallest"] };

// The cheapest model at the nearest proposable strength, among `models`.
function bestFor(task: Task, models: Offered[]): Offered | undefined {
  for (const tier of PREFERRED[task.tier]) {
    const at = models.filter((m) => m.tier === tier).sort((a, b) => (a.inputUsd ?? Infinity) - (b.inputUsd ?? Infinity) || modelKey(a).localeCompare(modelKey(b)));
    if (at[0]) return at[0];
  }
  return undefined;
}

export function proposeRoute(task: Task, models: Offered[]): Route | undefined {
  const main = bestFor(task, models);
  if (!main) return undefined;
  return { main, fallback: bestFor(task, models.filter((m) => m.provider !== main.provider)) };
}

interface ChoiceRecord {
  task: string;
  main_provider: Provider;
  main_model: string;
  fallback_provider: Provider | null;
  fallback_model: string | null;
  set_how: "accepted" | "changed";
}

export async function readTaskRoutes(db: D1Database, userId: string): Promise<{ offered: Offered[]; routes: TaskRoute[] }> {
  const offered = await readOffered(db, userId);
  const byKey = new Map(offered.map((m) => [modelKey(m), m]));
  const { results } = await db
    .prepare("SELECT task, main_provider, main_model, fallback_provider, fallback_model, set_how FROM task_models WHERE user_id = ?")
    .bind(userId)
    .all<ChoiceRecord>();
  const saved = new Map(results.map((r) => [r.task, r]));
  const routes = TASKS.map((task): TaskRoute => {
    if (offered.length === 1) return { task, current: { main: offered[0]!, setHow: "only_model" } };
    const proposal = proposeRoute(task, offered);
    const r = saved.get(task.id);
    const main = r && byKey.get(modelKey({ provider: r.main_provider, model: r.main_model }));
    if (!r || !main) return { task, proposal };
    const fallback = r.fallback_provider && r.fallback_model ? byKey.get(modelKey({ provider: r.fallback_provider, model: r.fallback_model })) : undefined;
    return { task, proposal, current: { main, fallback, setHow: r.set_how } };
  });
  return { offered, routes };
}

// The models a call for `task` goes to, or undefined when the task has none.
export async function routeTask(db: D1Database, userId: string, task: string): Promise<Route | undefined> {
  const { routes } = await readTaskRoutes(db, userId);
  return routes.find((r) => r.task.id === task)?.current;
}

async function saveChoice(db: D1Database, userId: string, task: string, route: Route, setHow: "accepted" | "changed", now: Date): Promise<void> {
  await db
    .prepare(
      `INSERT INTO task_models (user_id, task, main_provider, main_model, fallback_provider, fallback_model, set_how, set_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (user_id, task) DO UPDATE SET main_provider = excluded.main_provider, main_model = excluded.main_model,
         fallback_provider = excluded.fallback_provider, fallback_model = excluded.fallback_model, set_how = excluded.set_how, set_at = excluded.set_at`,
    )
    .bind(userId, task, route.main.provider, route.main.model, route.fallback?.provider ?? null, route.fallback?.model ?? null, setHow, now.toISOString())
    .run();
}

// The one tap: every task with a proposal and no choice of the user's takes
// its proposal. A task the user changed is kept. Returns how many were set.
export async function acceptProposals(db: D1Database, userId: string, now: Date): Promise<number> {
  const { routes } = await readTaskRoutes(db, userId);
  const pending = routes.filter((r) => !r.current && r.proposal);
  for (const r of pending) await saveChoice(db, userId, r.task.id, r.proposal!, "accepted", now);
  return pending.length;
}

export type ChangeProblem = "no_such_task" | "not_your_model" | "same_provider";

// Sets one task to models the user chose, each one of their passed models;
// the fallback, if any, on another provider.
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
  if (fallbackModel && fallbackModel.provider === mainModel.provider) return "same_provider";
  await saveChoice(db, userId, task, { main: mainModel, fallback: fallbackModel }, "changed", now);
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
  deployment: m.deployment,
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
