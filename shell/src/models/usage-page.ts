// Models › Usage, rendered on the server (design-v3 10.1 and 1.8; the M0
// design's Models → Usage screen): the month's OpenRouter spend against the
// monthly budget, as the budget bar shows it (the same bar as Models › Setup
// › Budgets, proxy/budget-bar.ts), then the spend per model and per task,
// from the usage ledger (usage.ts).
//
//   GET /chief-of-staff/models/usage
//
// Every figure on the page comes from one read of the ledger: the month's
// total is the app's own count the bar shows, and each table's foot is that
// same total. OpenRouter's own figure for the key is read live, server side,
// only once a budget is set, as on Budgets.
//
// Each model is named as OpenRouter's live list names it, its ID beside it;
// a model no longer in the list is shown by its ID. The app holds no list of
// its own. A model that list marks free (prices/openrouter.ts
// isTrulyFreeTextModel) carries "free"; every other one is paid.
//
// Both tables list the dearest first, ties by name: where the money went.
//
// With nothing to show yet, the page says what is missing and puts its one
// next action where the figures will appear: Connect OpenRouter, then Set a
// budget, then Test a model. After a Disconnect the month's figures stay, and
// the page says they are from before it.

import { BUDGETS_PATH, PROVIDERS_PATH, USAGE_PATH } from "../paths";
import { CONTROLS_CSS, esc, PAGE_CSS } from "../prices/page";
import type { OpenRouterCatalog } from "../prices/openrouter";
import { readCurrentCatalog } from "../prices/store";
import { OPENROUTER_ACTIVITY_URL } from "../providers/openrouter";
import type { SecretStore } from "../providers/secrets";
import { BAR_CSS, BAR_JS, barParts, budgetText, money, readKeyFigure, renderBudgetBar, type KeyFigure } from "../proxy/budget-bar";
import { readBudget } from "../proxy/budgets";
import { connectedProviders, readConnection } from "../proxy/connections";
import { nextMonthStart } from "../proxy/ledger";
import type { ConnectionFields } from "../proxy/plugin";
import { TEST_TASK } from "../proxy/proxy";
import { modelsSubtabs } from "./setup-tabs";
import { taskById } from "./tasks";
import { TEST_ALL_TASK } from "./test-all";
import { readMonthUsage, type MonthUsage, type UsageLine } from "./usage";

// A line with the name the page shows for it.
export interface NamedLine extends UsageLine {
  name: string;
  // Models only: the model is in OpenRouter's current list, and it is free there.
  listed?: boolean;
  free?: boolean;
}

const byName = (a: NamedLine, b: NamedLine) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }) || a.key.localeCompare(b.key);

const sortDearestFirst = (lines: NamedLine[]): NamedLine[] => [...lines].sort((a, b) => b.costUsd - a.costUsd || byName(a, b));

// The test calls are tasks of their own in the ledger; every other task is
// named as Model for each task names it.
const TASK_NAMES: Record<string, string> = { [TEST_TASK]: "Model tests", [TEST_ALL_TASK]: "Test all models" };
export const taskName = (id: string): string => TASK_NAMES[id] ?? taskById(id)?.label ?? id;

export function nameModels(lines: UsageLine[], catalog: OpenRouterCatalog | undefined): NamedLine[] {
  const listed = new Map((catalog?.models ?? []).map((m) => [m.id, m]));
  return lines.map((l) => {
    const m = listed.get(l.key);
    return { ...l, name: m?.name || l.key, listed: Boolean(m), free: Boolean(m?.free) };
  });
}

export const nameTasks = (lines: UsageLine[]): NamedLine[] => lines.map((l) => ({ ...l, name: taskName(l.key) }));

export interface UsagePageInput {
  now: Date;
  connected: boolean;
  budgetUsd?: number;
  // OpenRouter's own figure for the key, read once the budget is set.
  key?: KeyFigure;
  connection?: ConnectionFields;
  usage: MonthUsage;
  models: NamedLine[];
  tasks: NamedLine[];
}

// The one next action the page highlights: the first thing missing.
export type NextStep = "connect" | "budget" | "test" | undefined;
export function nextStep(input: Pick<UsagePageInput, "connected" | "budgetUsd" | "usage">): NextStep {
  if (!input.connected) return "connect";
  if (input.budgetUsd === undefined) return "budget";
  if (!input.usage.total.calls) return "test";
  return undefined;
}

const dayMonth = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
const count = (n: number) => n.toLocaleString("en-US");

function costCell(l: NamedLine): string {
  const all = l.estimatedUsd > 0 && l.estimatedUsd >= l.costUsd - 0.000_000_5;
  const note = l.estimatedUsd <= 0 ? "" : all ? ` <span class="pill warn">estimated</span>` : `<span class="u-sub">${money(l.estimatedUsd)} of it estimated</span>`;
  const figure = l.costUsd > 0 ? money(l.costUsd) : `<span class="muted">${money(l.costUsd)}</span>`;
  return `${figure}${note}`;
}

function row(l: NamedLine, table: "models" | "tasks"): string {
  const id = table === "models" ? `<span class="u-sub mono">${esc(l.key)}${l.listed ? "" : " · not in OpenRouter's list now"}</span>` : "";
  const free = l.free ? ` <span class="pill free">free</span>` : "";
  const refused = l.refused ? `${count(l.refused)} refused` : "";
  const phone = [`${count(l.calls)} call${l.calls === 1 ? "" : "s"}`, `${count(l.inputTokens + l.outputTokens)} tokens`, refused].filter(Boolean).join(" · ");
  return `<tr>
<td><span class="u-name">${esc(l.name)}</span>${free}${id}<span class="u-sub u-phone">${phone}</span></td>
<td class="num wide">${count(l.calls)}${refused ? `<span class="u-sub">${refused}</span>` : ""}</td>
<td class="num wide">${count(l.inputTokens)}</td>
<td class="num wide">${count(l.outputTokens)}</td>
<td class="num">${costCell(l)}</td>
</tr>`;
}

function table(table: "models" | "tasks", lines: NamedLine[], input: UsagePageInput, emptyRow: string): string {
  const label = table === "models" ? "Model" : "Task";
  const sorted = sortDearestFirst(lines);
  const { total } = input.usage;
  const body = sorted.length ? sorted.map((l) => row(l, table)).join("\n") : `<tr class="empty"><td colspan="5">${emptyRow}</td></tr>`;
  const foot = sorted.length
    ? `<tfoot><tr><th scope="row">This month<span class="u-sub u-phone">${count(total.calls)} call${total.calls === 1 ? "" : "s"}</span></th><td class="num wide">${count(total.calls)}</td><td class="num wide">${count(total.inputTokens)}</td><td class="num wide">${count(total.outputTokens)}</td><td class="num">${money(total.costUsd)}</td></tr></tfoot>`
    : "";
  return `<div class="tbl-wrap"><table class="usage" id="by-${table}" aria-labelledby="by-${table}-h">
<thead><tr><th scope="col">${label}</th><th scope="col" class="num wide">Calls</th><th scope="col" class="num wide">Input tokens</th><th scope="col" class="num wide">Output tokens</th><th scope="col" class="num">Cost</th></tr></thead>
<tbody>
${body}
</tbody>${foot}</table></div>`;
}

function spendCard(input: UsagePageInput, step: NextStep): string {
  const ledgerUsd = input.usage.total.costUsd;
  const resets = `From ${dayMonth(input.usage.since)}, at OpenRouter; starts again on ${dayMonth(nextMonthStart(input.now).toISOString())}.`;
  if (input.budgetUsd === undefined || !input.key) {
    // A budget is set per connected provider, so before Connect there is
    // nothing to set it on: Connect, above, comes first.
    const set = input.connected ? `<a class="btn${step === "budget" ? "" : " secondary"}" href="${BUDGETS_PATH}" data-next>Set a budget</a>` : "";
    return `<section class="card lead" aria-labelledby="spend-h"><h2 id="spend-h">Model spend this month</h2>
<p class="fig"><span class="big">${money(ledgerUsd)}</span><span class="of">no budget set</span></p>
<p class="small muted">${resets}</p>
<div class="unset"><p>${input.connected ? "Model calls stay stopped until you set a monthly budget." : "Once OpenRouter is connected, set a monthly budget for it."}</p>${set}</div>
</section>`;
  }
  const p = barParts(input.budgetUsd, ledgerUsd, input.key);
  const pct = (p.spent / input.budgetUsd) * 100;
  const pctText = p.spent > 0 && pct < 1 ? "under 1%" : `${Math.round(pct)}%`;
  const bar = renderBudgetBar({ budgetUsd: input.budgetUsd, ledgerUsd, key: input.key, connection: input.connection });
  return `<section class="card lead" aria-labelledby="spend-h"><h2 id="spend-h">Model spend this month</h2>
<p class="fig"><span class="big">${money(p.spent)}</span><span class="of">/ ${budgetText(input.budgetUsd)} (${pctText})</span></p>
<p class="small muted">${resets}</p>
${bar}
</section>`;
}

export function renderUsagePage(input: UsagePageInput): string {
  const step = nextStep(input);
  const disconnected = input.usage.total.calls
    ? "OpenRouter is disconnected. These figures are from before you disconnected."
    : "OpenRouter is not connected. Its spend shows here once it is.";
  const connect = !input.connected
    ? `<div class="banner next" role="note"><p>${disconnected}</p><a class="btn" href="${PROVIDERS_PATH}" data-next>Connect OpenRouter</a></div>`
    : "";
  const testLink = `<a class="btn${step === "test" ? "" : " secondary"} small" href="${PROVIDERS_PATH}#test"${step === "test" ? " data-next" : ""}>Test a model</a>`;
  // The next action goes once, in the first table's frame.
  const noCalls = "No model calls this month yet.";
  const emptyModels = input.connected ? `<span>${noCalls}</span> ${testLink}` : noCalls;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Models · Usage · Chief of staff</title>
<style>${PAGE_CSS}${CONTROLS_CSS}${BAR_CSS}${CSS}</style>
</head>
<body>
<main class="screen">
<h1>Models</h1>
${modelsSubtabs("usage")}
${connect}
${spendCard(input, step)}
<div class="stack">
<section class="card" aria-labelledby="by-models-h"><h2 id="by-models-h">Per model</h2>
${table("models", input.models, input, emptyModels)}
</section>
<section class="card" aria-labelledby="by-tasks-h"><h2 id="by-tasks-h">Per task</h2>
${table("tasks", input.tasks, input, noCalls)}
</section>
</div>
<p class="small muted">Each cost is OpenRouter's own, from its reply; “estimated” is a list price, where a reply gave none.</p>
<details class="more"><summary>How these figures are counted</summary><ul class="small">
<li>From the app's own record of every call it sent to OpenRouter, the same count that stops calls at the budget.</li>
<li>An estimated cost is the model's list price from the price table, never below what OpenRouter can charge.</li>
<li>Calls OpenRouter refused are counted, at what it reported, usually $0.</li>
<li>Model tests are the test calls on Providers and models.</li>
<li>OpenRouter's own record: <a href="${OPENROUTER_ACTIVITY_URL}" target="_blank" rel="noopener noreferrer">its Activity page</a>, filtered by the “Chief of staff” key.</li>
</ul></details>
</main>
<script>${BAR_JS}
</script>
</body>
</html>`;
}

const CSS = `
.card { border-color: color-mix(in oklab, var(--line) 50%, var(--card)); }
.stack > .card { margin-top: 16px; }
table.usage th:first-child { width: 40%; }
.card h2 { margin: 12px 0 8px; }
.lead .fig { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; margin: 0; font-variant-numeric: tabular-nums; }
.lead .big { font-size: 2rem; line-height: 1.15; font-weight: 600; }
.lead .of { font-size: 1.1rem; color: var(--muted); }
.lead .fig + .small { margin: 2px 0 0; }
.unset { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-top: 10px; }
.unset p { margin: 0; }
.banner.next { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between; }
.banner.next p { margin: 0; }
.btn.small { font-size: .85rem; min-height: 28px; padding: 3px 9px; }
.tbl-wrap { border: 0; background: transparent; }
table.usage { table-layout: auto; }
table.usage th, table.usage td { padding: 8px 6px; }
table.usage th:first-child, table.usage td:first-child { padding-left: 0; }
table.usage th:last-child, table.usage td:last-child { padding-right: 0; }
table.usage .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
table.usage tbody tr:last-child td { border-bottom: 0; }
table.usage tfoot th, table.usage tfoot td { border-top: 1px solid var(--line); border-bottom: 0; font-weight: 600; font-size: .9rem; color: var(--text); }
table.usage tr.empty td { color: var(--muted); }
table.usage tr.empty td > * { vertical-align: middle; }
.u-name { overflow-wrap: anywhere; }
.u-sub { display: block; font-size: .8rem; color: var(--muted); font-weight: 400; overflow-wrap: anywhere; white-space: normal; }
table.usage .num .u-sub { white-space: nowrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .76rem; }
.u-phone { display: none; }
@media (max-width: 639px) {
  table.usage .wide { display: none; }
  table.usage th:first-child { width: 62%; }
  table.usage .num .u-sub { white-space: normal; }
  .u-phone { display: block; }
}
.pill.free { background: var(--ok-soft); color: var(--ok); }
.pill { white-space: nowrap; }
`;

export interface UsageDeps {
  db: D1Database;
  userId: string;
  now: Date;
  secrets: SecretStore;
  fetcher?: typeof fetch;
}

export async function usagePageInput(deps: UsageDeps): Promise<UsagePageInput> {
  const { db, userId, now } = deps;
  const [providers, budget, usage, connection, catalog] = await Promise.all([
    connectedProviders(db, userId),
    readBudget(db, userId, "openrouter"),
    readMonthUsage(db, userId, now),
    readConnection(db, userId, "openrouter"),
    readCurrentCatalog(db),
  ]);
  return {
    now,
    connected: providers.includes("openrouter"),
    budgetUsd: budget?.monthlyUsd,
    ...(budget ? { key: await readKeyFigure(deps.secrets, userId, now, deps.fetcher) } : {}),
    connection,
    usage,
    models: nameModels(usage.byModel, catalog),
    tasks: nameTasks(usage.byTask),
  };
}

// GET only; scoped to the signed-in user throughout.
export async function handleUsage(deps: UsageDeps): Promise<Response> {
  const html = renderUsagePage(await usagePageInput(deps));
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export const isUsagePath = (pathname: string): boolean => pathname === USAGE_PATH;
