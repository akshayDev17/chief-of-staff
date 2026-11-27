// Models › Setup › Model for each task, rendered on the server (design T02 /
// T18).
//
//   GET  /chief-of-staff/models/setup/tasks
//   POST /chief-of-staff/models/setup/tasks/accept    the one tap: every proposal is taken
//   POST /chief-of-staff/models/setup/tasks/change    task, main, fallback (or none)
//   POST /chief-of-staff/models/setup/tasks/use-free  the one tap for free models, where nothing is proposed
//   POST /chief-of-staff/models/setup/tasks/help      friends only: "Ask Admin for help"
//
// Only the user's usable models are offered (models/usable.ts: each model
// whose latest test passed). Each task shows its main model and its
// fallback, another of the user's models: the user's choice, or the proposal
// at the task's suggested strength marked "proposed" until accepted (again,
// for an accepted task whose proposal has changed); a task with neither
// reads "Choose a model". A task whose saved main model stopped passing
// reads that it runs on its fallback, named, with its Change form open to
// choose a new main model; with no usable fallback it reads "Choose a model". Changing a task chooses the provider and then the
// model, for the main and the fallback (the owner, 2026-11-27: "for each kind
// of task : choose the provider and the model"); OpenRouter is the one
// provider today, and another provider's passed models join the same lists. A proposed model of the other
// strength, where the user has none of the task's own, says so. Any task can be
// changed to any of the user's models, the Strongest included. A model known
// to make no tool call (the plug-in's `noToolUse`, shown in the model list too)
// reads "no tool use" wherever it is named, and a free model reads FREE_NOTE;
// a free model is never proposed, only chosen: with Change, or with one tap
// for every task that has no model and no proposal (a $0 account's passed
// models are all free), which the page offers and explains, with the
// provider's own terms for free models. Friend screens say "Admin" for
// the owner and never "tier".
//
// TODO(T18): tasks name no tools yet. Once a task's agent sends tools, never
// propose a "no tool use" model for it, and refuse one chosen for it.

import { CONTROLS_CSS, esc, PAGE_CSS } from "../prices/page";
import type { Provider } from "../prices/types";
import { PROVIDERS_PATH, TASK_MODELS_PATH } from "../paths";
import { modelsSubtabs, nextAction, setupTabsLine } from "./setup-tabs";
import type { Viewer } from "../providers/page";
import type { PluginRegistry } from "../proxy/plugin";
import { PROVIDER_NAMES } from "../proxy/proxy";
import { FREE_NOTE } from "./test-model";
import type { Link } from "../proxy/plugin";
import { acceptProposals, changeTask, freeRoutes, modelKey, readTaskRoutes, taskById, TASKS, useFreeModels, type ChangeProblem, type Offered, type Route, type Task, type TaskRoute } from "./tasks";

export interface PickerPageInput {
  viewer: Viewer;
  offered: Offered[];
  routes: TaskRoute[];
  // Each provider's short name on screen ("OpenRouter").
  providerName: (p: Provider) => string;
  // True for a model known to make no tool call.
  noToolUse: (m: { provider: Provider; model: string }) => boolean;
  // The provider's own conditions on free models, shown when one is offered.
  freeTerms?: { text: string; links: Link[] };
  problem?: string;
  said?: string;
}

const marks = (m: Offered, input: PickerPageInput): string => `${input.noToolUse(m) ? " · no tool use" : ""}${m.free ? ` · ${FREE_NOTE}` : ""}`;

const modelName = (m: Offered, input: PickerPageInput): string => `${m.model} · ${input.providerName(m.provider)}${marks(m, input)}`;

// One provider select and one model select, the models grouped by provider;
// a small script shows only the chosen provider's models, and the server
// checks the pair either way.
function pairSelects(id: string, role: "main" | "fallback", chosen: Offered | undefined, input: PickerPageInput): string {
  const providers = [...new Set(input.offered.map((m) => m.provider))];
  const none = role === "fallback" ? `<option value="">None</option>` : "";
  const providerOptions = providers
    .map((p) => `<option value="${esc(p)}"${chosen?.provider === p ? " selected" : ""}>${esc(input.providerName(p))}</option>`)
    .join("");
  const groups = providers
    .map(
      (p) =>
        `<optgroup label="${esc(input.providerName(p))}" data-provider="${esc(p)}">${input.offered
          .filter((m) => m.provider === p)
          .map((m) => `<option value="${esc(m.model)}"${chosen && modelKey(m) === modelKey(chosen) ? " selected" : ""}>${esc(m.model + marks(m, input))}${m.tier ? ` (${m.tier})` : ""}</option>`)
          .join("")}</optgroup>`,
    )
    .join("");
  const label = role === "main" ? "Main" : "Fallback (another model)";
  return `<fieldset class="pair" data-pair><legend class="small">${label}</legend>
<label class="small" for="${id}-${role}-p">Provider</label>
<select class="f" id="${id}-${role}-p" name="${role}_provider" data-pair-provider>${role === "fallback" ? `<option value=""${chosen ? "" : " selected"}>None</option>` : ""}${providerOptions}</select>
<label class="small" for="${id}-${role}-m">Model</label>
<select class="f" id="${id}-${role}-m" name="${role}_model" data-pair-model>${none}${groups}</select></fieldset>`;
}

function changeForm(r: TaskRoute, now: { main?: Offered; fallback?: Offered } | undefined, input: PickerPageInput): string {
  const id = `t-${r.task.id}`;
  return `<details class="change"${r.stopped?.fallback ? " open" : ""}><summary class="btn small ghost">Change</summary>
<form method="post" action="${TASK_MODELS_PATH}/change" class="pick">
<input type="hidden" name="task" value="${esc(r.task.id)}">
${pairSelects(id, "main", now?.main, input)}
${input.offered.length > 1 ? pairSelects(id, "fallback", now?.fallback, input) : ""}
<div class="row"><button type="submit" class="btn small">Save</button></div></form></details>`;
}

// Why a proposed model is not of the task's suggested strength.
function substituteNote(task: Task, m: Offered, asFallback: boolean): string {
  if (!m.tier || m.tier === task.tier) return "";
  return ` <span class="small">a ${m.tier} model, since you have no ${asFallback ? "other " : ""}${task.tier} model yet</span>`;
}

function routeCells(r: TaskRoute, route: Route | undefined, input: PickerPageInput): string {
  const onFallback = r.stopped?.fallback;
  if (onFallback) {
    return `<td data-l="Main">Runs on its fallback for now: ${esc(r.stopped!.main.model)} stopped passing its test. Choose a new main model with Change.</td><td data-l="Fallback (another model)">${esc(modelName(onFallback, input))}</td>`;
  }
  if (!route) return `<td data-l="Main">Choose a model</td><td data-l="Fallback (another model)">–</td>`;
  const tag = r.pending ? ` <span class="pill">proposed</span>` : "";
  const fromProposal = r.pending || r.current?.setHow === "accepted";
  const note = (m: Offered, asFallback: boolean) => (fromProposal ? substituteNote(r.task, m, asFallback) : "");
  const fallback = route.fallback
    ? esc(modelName(route.fallback, input)) + tag + note(route.fallback, true)
    : input.offered.length > 1
      ? "none"
      : "none: test another model for a fallback";
  return `<td data-l="Main">${esc(modelName(route.main, input))}${tag}${note(route.main, false)}</td><td data-l="Fallback (another model)">${fallback}</td>`;
}

// The one tap for free models, where tasks have no model and no proposal.
function freeTap(input: PickerPageInput): string {
  const set = freeRoutes(input.offered, input.routes);
  if (!set.length) return "";
  const allFree = input.offered.every((m) => m.free);
  const why = allFree
    ? "Your models that passed are all free, so the app proposes none."
    : `${set.length === 1 ? "One task has" : `${set.length} tasks have`} no proposed model. Your free models can take ${set.length === 1 ? "it" : "them"}.`;
  return `<div class="banner" role="note"><p style="margin:0 0 6px">${esc(why)}</p>
<form method="post" action="${TASK_MODELS_PATH}/use-free"><button type="submit" class="btn">Use my free models for ${set.length === TASKS.length ? "every task" : set.length === 1 ? "that task" : "those tasks"}</button></form>
<details class="more"><summary>Why free models are not proposed</summary><ul class="small">
<li>A free model is rate-limited, and its providers may log prompts.</li>
<li>The tap picks the cheapest free model at each task's strength.</li>
<li>Another free model becomes its fallback. You can change any task.</li>
</ul></details></div>`;
}

function freeTermsLine(input: PickerPageInput): string {
  if (!input.freeTerms || !input.offered.some((m) => m.free)) return "";
  const links = input.freeTerms.links.map((l) => `<a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`).join(" · ");
  return `<details class="more"><summary>OpenRouter's terms for free models</summary><p class="small muted">${esc(input.freeTerms.text)} ${links}</p></details>`;
}

export function renderPickerPage(input: PickerPageInput): string {
  const intro = !input.offered.length
    ? `<div class="banner warn">Test a model first. Only models that passed are offered here. <a href="${PROVIDERS_PATH}#test">Test a model</a></div>`
    : `<p>Each task gets a main model and a fallback.</p>
<details class="more"><summary>How it works</summary><ul class="small">
<li>Both come from your models that passed, at the task's suggested strength.</li>
<li>When the main model fails a call, the fallback answers it.</li>
<li>Change any task: choose its provider, then its model.</li>
${input.offered.some((m) => m.free) ? "<li>A free model is never proposed. Choose it with Change, or the one tap.</li>" : ""}
</ul></details>`;
  const head = `<th>Task</th><th>Suggested strength</th><th>Main</th><th>Fallback (another model)</th><th></th>`;
  const body = input.routes
    .map((r) => {
      const route = r.pending ? r.proposal : r.current;
      const change = changeForm(r, route ?? (r.stopped?.fallback ? { fallback: r.stopped.fallback } : undefined), input);
      return `<tr><td data-l="Task">${esc(r.task.label)}</td><td data-l="Suggested strength">${r.task.tier}</td>
${routeCells(r, route, input)}
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
${modelsSubtabs("setup")}
${setupTabsLine(TASK_MODELS_PATH)}
<h2>Model for each task</h2>
${input.problem ? `<div class="banner warn" role="alert">${esc(input.problem)}</div>` : ""}
${input.said ? `<div class="banner ok" role="status">${esc(input.said)}</div>` : ""}
${intro}
${freeTap(input)}
${freeTermsLine(input)}
${table}
<div class="row" style="margin-top:10px">${accept}${nextAction(TASK_MODELS_PATH, `btn${pending ? " secondary" : ""}`)}${help}</div>
</main>
<script>
document.querySelectorAll("[data-pair]").forEach(function (pair) {
  var provider = pair.querySelector("[data-pair-provider]"), model = pair.querySelector("[data-pair-model]");
  if (!provider || !model) return;
  function show() {
    var chosen = provider.value, first = null;
    model.querySelectorAll("optgroup").forEach(function (g) {
      var on = g.getAttribute("data-provider") === chosen;
      g.hidden = !on; g.disabled = !on;
      if (on && !first) first = g.querySelector("option");
    });
    var current = model.selectedOptions[0];
    if (!chosen) model.value = "";
    else if (!current || !current.parentElement || current.parentElement.getAttribute("data-provider") !== chosen) { if (first) model.value = first.value; }
  }
  provider.addEventListener("change", show);
  show();
});
</script>
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
fieldset.pair { border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px 8px; margin: 0; display: grid; gap: 4px; }
fieldset.pair legend { padding: 0 4px; color: var(--muted); }
.tbl-wrap { margin-top: 10px; }
`;

const ROUTE = new RegExp(`^${TASK_MODELS_PATH}(?:/(accept|change|use-free|help))?$`);

export const isTaskModelsPath = (pathname: string): boolean => ROUTE.test(pathname);

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const PROBLEMS: Record<ChangeProblem, string> = {
  no_such_task: "There is no such task.",
  not_your_model: "Pick one of your own models that passed its test call.",
  same_model: "The fallback must be another model than the main one.",
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
    const freeTerms = offered.filter((m) => m.free).map((m) => plugins[m.provider]?.connect.freeModelTerms).find(Boolean);
    return html(renderPickerPage({ viewer, offered, routes, providerName, noToolUse, freeTerms, ...extra }), status);
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
  if (verb === "use-free") {
    const set = await useFreeModels(db, userId, now);
    const mains = [...new Set(set.map((s) => s.route.main.model))];
    const said = !set.length
      ? "There was nothing to set."
      : set.length === TASKS.length && mains.length === 1
        ? `Every task now uses ${mains[0]}. Change any task below.`
        : `${set.length} ${set.length === 1 ? "task now uses a free model" : "tasks now use your free models"}. Change any task below.`;
    return page({ said });
  }
  if (verb === "change") {
    const pair = (role: "main" | "fallback") => (field(`${role}_provider`) && field(`${role}_model`) ? modelKey({ provider: field(`${role}_provider`) as Provider, model: field(`${role}_model`) }) : "");
    const problem = await changeTask(db, userId, field("task"), pair("main"), pair("fallback") || undefined, now);
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
