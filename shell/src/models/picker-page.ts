// Models › Setup › Model for each task, rendered on the server (design T02 /
// T18).
//
//   GET  /chief-of-staff/models/setup/tasks
//   POST /chief-of-staff/models/setup/tasks/accept    the one tap: every proposal is taken
//   POST /chief-of-staff/models/setup/tasks/change    task, main, fallback (or none)
//   POST /chief-of-staff/models/setup/tasks/help      friends only: "Ask Admin for help"
//
// Only the user's own passed models are offered. With one, every task uses
// it ("Model now"). With more, each task shows its main model and its
// fallback on another provider: the user's choice, or the proposal at the
// task's suggested strength marked "proposed" until accepted (again, for an
// accepted task whose proposal has changed). A proposed model of the other
// strength, where the user has none of the task's own, says so. Any task can be
// changed to any of the user's models, the Strongest included. A model known
// to make no tool call (the plug-in's `noToolUse`, shown in the model list too)
// reads "no tool use" wherever it is named. Friend screens say "Admin" for
// the owner and never "tier".
//
// TODO(T18): tasks name no tools yet. Once a task's agent sends tools, never
// propose a "no tool use" model for it, and refuse one chosen for it.

import { CONTROLS_CSS, esc, PAGE_CSS } from "../prices/page";
import type { Provider } from "../prices/types";
import { BUDGETS_PATH, PROVIDERS_PATH, TASK_MODELS_PATH } from "../paths";
import type { Viewer } from "../providers/page";
import type { PluginRegistry } from "../proxy/plugin";
import { PROVIDER_NAMES } from "../proxy/proxy";
import { acceptProposals, changeTask, modelKey, readTaskRoutes, taskById, type ChangeProblem, type Offered, type Route, type Task, type TaskRoute } from "./tasks";

export interface PickerPageInput {
  viewer: Viewer;
  offered: Offered[];
  routes: TaskRoute[];
  // Each provider's short name on screen ("Bedrock").
  providerName: (p: Provider) => string;
  // True for a model known to make no tool call.
  noToolUse: (m: { provider: Provider; model: string }) => boolean;
  problem?: string;
  said?: string;
}

const modelName = (m: Offered, input: PickerPageInput): string =>
  `${m.model} · ${input.providerName(m.provider)}${input.noToolUse(m) ? " · no tool use" : ""}`;

function changeForm(r: TaskRoute, now: Route | undefined, input: PickerPageInput): string {
  const option = (m: Offered, selected: boolean) =>
    `<option value="${esc(modelKey(m))}"${selected ? " selected" : ""}>${esc(modelName(m, input))}${m.tier ? ` (${m.tier})` : ""}</option>`;
  const mains = input.offered.map((m) => option(m, now?.main !== undefined && modelKey(m) === modelKey(now.main))).join("");
  const fallbacks = input.offered.map((m) => option(m, now?.fallback !== undefined && modelKey(m) === modelKey(now.fallback))).join("");
  const id = `t-${r.task.id}`;
  const fallback =
    input.offered.length > 1 && new Set(input.offered.map((m) => m.provider)).size > 1
      ? `<label class="small" for="${id}-f">Fallback (another provider)</label>
<select class="f" id="${id}-f" name="fallback"><option value="">None</option>${fallbacks}</select>`
      : "";
  return `<details class="change"><summary class="btn small ghost">Change</summary>
<form method="post" action="${TASK_MODELS_PATH}/change" class="pick">
<input type="hidden" name="task" value="${esc(r.task.id)}">
<label class="small" for="${id}-m">Main</label>
<select class="f" id="${id}-m" name="main">${mains}</select>
${fallback}
<div class="row"><button type="submit" class="btn small">Save</button></div></form></details>`;
}

// Why a proposed model is not of the task's suggested strength.
function substituteNote(task: Task, m: Offered, atAnotherProvider: boolean): string {
  if (!m.tier || m.tier === task.tier) return "";
  return ` <span class="small">a ${m.tier} model, since you have no ${task.tier} model${atAnotherProvider ? " at another provider" : ""} yet</span>`;
}

function routeCells(r: TaskRoute, route: Route | undefined, input: PickerPageInput, single: boolean): string {
  if (single) return `<td data-l="Model now">${route ? esc(modelName(route.main, input)) : "–"}</td>`;
  if (!route) return `<td data-l="Main">none yet: add a model of the suggested strength</td><td data-l="Fallback (another provider)">–</td>`;
  const tag = r.pending ? ` <span class="pill">proposed</span>` : "";
  const fromProposal = r.pending || r.current?.setHow === "accepted";
  const note = (m: Offered, atAnotherProvider: boolean) => (fromProposal ? substituteNote(r.task, m, atAnotherProvider) : "");
  const fallback = route.fallback
    ? esc(modelName(route.fallback, input)) + tag + note(route.fallback, true)
    : input.offered.some((m) => m.provider !== route.main.provider)
      ? "none"
      : "none: add a model at another provider";
  return `<td data-l="Main">${esc(modelName(route.main, input))}${tag}${note(route.main, false)}</td><td data-l="Fallback (another provider)">${fallback}</td>`;
}

export function renderPickerPage(input: PickerPageInput): string {
  const single = input.offered.length === 1;
  const providers = new Set(input.offered.map((m) => m.provider)).size;
  const intro = !input.offered.length
    ? `<div class="banner warn">Choose a model first: only your own models that passed their test call are offered here. Choose one below a provider's passed Connect. <a href="${PROVIDERS_PATH}">Providers and models</a></div>`
    : single
      ? `<p>You have one model that passed, so every task uses it for now. Choose a model of the suggested strength, or at another provider for a fallback, and the app proposes it here.</p>`
      : providers > 1
        ? `<p>You have models at more than one provider, so each task gets a main model and a fallback on another provider, at the suggested strength for that task. You can change any of them.</p>`
        : `<p>Your models are all at one provider, so each task gets a main model at the suggested strength and no fallback. Choose a model at another provider for a fallback. You can change any of them.</p>`;
  const head = single
    ? `<th>Task</th><th>Suggested strength</th><th>Model now</th><th></th>`
    : `<th>Task</th><th>Suggested strength</th><th>Main</th><th>Fallback (another provider)</th><th></th>`;
  const body = input.routes
    .map((r) => {
      const route = r.pending ? r.proposal : r.current;
      const change = input.offered.length > 1 ? changeForm(r, route, input) : "";
      return `<tr><td data-l="Task">${esc(r.task.label)}</td><td data-l="Suggested strength">${r.task.tier}</td>
${routeCells(r, route, input, single)}
<td data-l="">${change}</td></tr>`;
    })
    .join("\n");
  const table = input.offered.length
    ? `<div class="tbl-wrap"><table class="stackable"><thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody></table></div>`
    : "";
  const pending = input.routes.some((r) => r.pending);
  const accept = pending
    ? `<form method="post" action="${TASK_MODELS_PATH}/accept"><button type="submit" class="btn">Accept all with one tap</button></form>`
    : "";
  const help =
    input.viewer === "friend"
      ? `<form method="post" action="${TASK_MODELS_PATH}/help"><button type="submit" class="btn help-btn small">Ask Admin for help</button></form>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Models · Model for each task · Chief of staff</title>
<style>${PAGE_CSS}${CONTROLS_CSS}${CSS}</style>
</head>
<body>
<main class="screen">
<h1>Models</h1>
<div class="subtabs"><span class="on">Setup</span><span aria-disabled="true">Usage</span></div>
<p class="small" style="margin:-4px 0 10px"><a href="${PROVIDERS_PATH}">Providers and models</a> · <a href="${BUDGETS_PATH}">Budgets</a> · <strong>Model for each task</strong></p>
<h2>Model for each task</h2>
${input.problem ? `<div class="banner warn" role="alert">${esc(input.problem)}</div>` : ""}
${input.said ? `<div class="banner ok" role="status">${esc(input.said)}</div>` : ""}
${intro}
${table}
<div class="row" style="margin-top:10px">${accept}<a class="btn${pending ? " secondary" : ""}" href="${BUDGETS_PATH}">Next: budget</a>${help}</div>
</main>
</body>
</html>`;
}

const CSS = `
.pill { background: var(--line); color: var(--text); }
.btn.small { font-size: .85rem; min-height: 28px; padding: 3px 9px; }
.btn.ghost { background: transparent; color: var(--accent); border-color: var(--line); }
.help-btn { border-color: var(--line); background: var(--card); color: var(--text); }
details.change > summary { list-style: none; display: inline-flex; cursor: pointer; }
details.change > summary::-webkit-details-marker { display: none; }
form.pick { display: grid; gap: 4px; min-width: 14em; margin-top: 6px; }
form.pick label { color: var(--muted); }
form.pick select { max-width: 100%; }
`;

const ROUTE = new RegExp(`^${TASK_MODELS_PATH}(?:/(accept|change|help))?$`);

export const isTaskModelsPath = (pathname: string): boolean => ROUTE.test(pathname);

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const PROBLEMS: Record<ChangeProblem, string> = {
  no_such_task: "There is no such task.",
  not_your_model: "Pick one of your own models that passed its test call.",
  same_provider: "The fallback must be on another provider than the main model.",
};

// Every route is scoped to the signed-in user.
export async function handleTaskModels(
  request: Request,
  input: { db: D1Database; plugins: PluginRegistry; userId: string; viewer: Viewer; now: Date },
): Promise<Response> {
  const { db, plugins, userId, viewer, now } = input;
  const url = new URL(request.url);
  const [, verb] = ROUTE.exec(url.pathname) ?? [];
  const page = async (extra: { problem?: string; said?: string } = {}, status = 200) => {
    const { offered, routes } = await readTaskRoutes(db, userId);
    const providerName = (p: Provider) => plugins[p]?.connect.guide.short ?? PROVIDER_NAMES[p];
    const noToolUse = (m: { provider: Provider; model: string }) => plugins[m.provider]?.connect.noToolUse?.(m.model) !== undefined;
    return html(renderPickerPage({ viewer, offered, routes, providerName, noToolUse, ...extra }), status);
  };

  if (!verb) return request.method === "GET" ? page() : new Response(null, { status: 405 });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  // A form posted from another site is refused.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return new Response(null, { status: 403 });
  const form = await request.formData();
  const field = (name: string): string => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };

  if (verb === "accept") {
    const n = await acceptProposals(db, userId, now);
    return page({ said: n ? `Accepted: ${n} ${n === 1 ? "task uses its" : "tasks use their"} proposed models.` : "There was nothing to accept." });
  }
  if (verb === "change") {
    const problem = await changeTask(db, userId, field("task"), field("main"), field("fallback") || undefined, now);
    if (problem) return page({ problem: PROBLEMS[problem] }, 400);
    return page({ said: `${taskById(field("task"))!.label}: saved.` });
  }
  // "Ask Admin for help": the item's name only.
  if (viewer !== "friend") return new Response(null, { status: 403 });
  await db
    .prepare("INSERT INTO help_requests (user_id, item, reason, at) VALUES (?, ?, ?, ?)")
    .bind(userId, "Model for each task", "asked for help choosing a model for each task", now.toISOString())
    .run();
  return page({ said: "Sent to Admin: this item's name and its reason only." });
}
