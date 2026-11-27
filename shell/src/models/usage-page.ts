// Models › Usage, rendered on the server (design-v3 10.1 and 1.8; the M0
// design's Models → Usage screen): the month's OpenRouter spend against the
// monthly budget, as the budget bar shows it (the same bar as Models › Setup
// › Budgets, proxy/budget-bar.ts), then the spend per model and per task,
// from the usage ledger (usage.ts).
//
//   GET /chief-of-staff/models/usage[?models=<column>:<dir>][&tasks=<column>:<dir>]
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
// Sorting a table is in the page: the script reorders the rows and keeps the
// order in the address without loading anything. Without a script each
// header is a plain link, and the server sorts.
//
// With nothing to show yet, the page says what is missing and puts its one
// next action where the figures will appear: Connect OpenRouter, then Set a
// budget, then Test a model.

import { BUDGETS_PATH, PROVIDERS_PATH, USAGE_PATH } from "../paths";
import { CONTROLS_CSS, esc, PAGE_CSS } from "../prices/page";
import type { OpenRouterCatalog } from "../prices/openrouter";
import { readCurrentCatalog } from "../prices/store";
import { OPENROUTER_ACTIVITY_URL } from "../providers/openrouter";
import type { SecretStore } from "../providers/secrets";
import { BAR_CSS, BAR_JS, barParts, money, readKeyFigure, renderBudgetBar, type KeyFigure } from "../proxy/budget-bar";
import { readBudget } from "../proxy/budgets";
import { connectedProviders, readConnection } from "../proxy/connections";
import { nextMonthStart } from "../proxy/ledger";
import type { ConnectionFields } from "../proxy/plugin";
import { TEST_TASK } from "../proxy/proxy";
import { modelsSubtabs } from "./setup-tabs";
import { taskById } from "./tasks";
import { TEST_ALL_TASK } from "./test-all";
import { readMonthUsage, type MonthUsage, type UsageLine } from "./usage";

export type UsageColumn = "name" | "calls" | "cost";
export type SortDir = "asc" | "desc";
export interface UsageSort {
  column: UsageColumn;
  dir: SortDir;
}
export type TableId = "models" | "tasks";
export type Sorts = Record<TableId, UsageSort>;

// Dearest first, the question the tables answer: where the money went.
export const DEFAULT_SORT: UsageSort = { column: "cost", dir: "desc" };

// "<column>:<dir>" from the address; the default for anything else.
export function parseUsageSort(raw: string | null): UsageSort {
  const [c, d] = (raw ?? "").split(":");
  if ((c !== "name" && c !== "calls" && c !== "cost") || (d !== "asc" && d !== "desc")) return DEFAULT_SORT;
  return { column: c, dir: d };
}

// A header's next sort: its own column the other way round, or a new column
// from A to Z for names and from the largest for figures.
export function nextSort(current: UsageSort, column: UsageColumn): UsageSort {
  if (current.column === column) return { column, dir: current.dir === "asc" ? "desc" : "asc" };
  return { column, dir: column === "name" ? "asc" : "desc" };
}

// A line with the name the page shows for it.
export interface NamedLine extends UsageLine {
  name: string;
  // Models only: the model is in OpenRouter's current list, and it is free there.
  listed?: boolean;
  free?: boolean;
}

const byName = (a: NamedLine, b: NamedLine) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }) || a.key.localeCompare(b.key);

// Ties go by name, so the order is the same on the server and in the page.
export function sortLines(lines: NamedLine[], sort: UsageSort): NamedLine[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const primary = (a: NamedLine, b: NamedLine) =>
    sort.column === "name" ? byName(a, b) : (sort.column === "calls" ? a.calls - b.calls : a.costUsd - b.costUsd);
  return [...lines].sort((a, b) => primary(a, b) * sign || byName(a, b));
}

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
  sorts: Sorts;
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
const dollars = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

const sortQuery = (sorts: Sorts) => `?models=${sorts.models.column}:${sorts.models.dir}&tasks=${sorts.tasks.column}:${sorts.tasks.dir}`;

function header(label: string, table: TableId, column: UsageColumn, sorts: Sorts, numeric: boolean): string {
  const cls = column === "calls" ? "num wide" : numeric ? "num" : "";
  const sort = sorts[table];
  const on = sort.column === column;
  const next = nextSort(sort, column);
  const ariaSort = on ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
  const arrow = on ? (sort.dir === "asc" ? "▲" : "▼") : "";
  return `<th scope="col"${cls ? ` class="${cls}"` : ""} aria-sort="${ariaSort}"><a class="th-sort" href="${sortQuery({ ...sorts, [table]: next })}" data-sort="${column}">${label}<span class="sort-arrow" aria-hidden="true">${arrow}</span></a></th>`;
}

function costCell(l: NamedLine): string {
  const all = l.estimatedUsd > 0 && l.estimatedUsd >= l.costUsd - 0.000_000_5;
  const note = l.estimatedUsd <= 0 ? "" : all ? ` <span class="pill warn">estimated</span>` : `<span class="u-sub">${money(l.estimatedUsd)} of it estimated</span>`;
  const figure = l.costUsd > 0 ? money(l.costUsd) : `<span class="muted">${money(l.costUsd)}</span>`;
  return `${figure}${note}`;
}

function row(l: NamedLine, table: TableId, topCost: number): string {
  const share = topCost > 0 ? (l.costUsd / topCost) * 100 : 0;
  const top = topCost > 0 && l.costUsd === topCost;
  const id = table === "models" ? `<span class="u-sub mono">${esc(l.key)}${l.listed ? "" : " · not in OpenRouter's list now"}</span>` : "";
  const free = l.free ? ` <span class="pill free">free</span>` : "";
  const refused = l.refused ? `${count(l.refused)} refused` : "";
  const phone = [`${count(l.calls)} call${l.calls === 1 ? "" : "s"}`, `${count(l.inputTokens + l.outputTokens)} tokens`, refused].filter(Boolean).join(" · ");
  return `<tr data-name="${esc(l.name.toLowerCase())}" data-calls="${l.calls}" data-cost="${l.costUsd}">
<td><span class="u-name">${esc(l.name)}</span>${free}${id}<span class="u-sub u-phone">${phone}</span>${share >= 1.5 ? `<span class="share${top ? " top" : ""}" aria-hidden="true"><span style="width:${share.toFixed(1)}%"></span></span>` : ""}</td>
<td class="num wide">${count(l.calls)}${refused ? `<span class="u-sub">${refused}</span>` : ""}</td>
<td class="num wide">${count(l.inputTokens)}</td>
<td class="num wide">${count(l.outputTokens)}</td>
<td class="num">${costCell(l)}</td>
</tr>`;
}

function table(table: TableId, lines: NamedLine[], input: UsagePageInput, emptyRow: string): string {
  const label = table === "models" ? "Model" : "Task";
  const sorted = sortLines(lines, input.sorts[table]);
  const topCost = Math.max(0, ...lines.map((l) => l.costUsd));
  const { total } = input.usage;
  const body = sorted.length ? sorted.map((l) => row(l, table, topCost)).join("\n") : `<tr class="empty"><td colspan="5">${emptyRow}</td></tr>`;
  const foot = sorted.length
    ? `<tfoot><tr><th scope="row">This month<span class="u-sub u-phone">${count(total.calls)} call${total.calls === 1 ? "" : "s"}</span></th><td class="num wide">${count(total.calls)}</td><td class="num wide">${count(total.inputTokens)}</td><td class="num wide">${count(total.outputTokens)}</td><td class="num">${money(total.costUsd)}</td></tr></tfoot>`
    : "";
  return `<div class="tbl-wrap"><table class="usage" id="by-${table}" data-sort-table="${table}" aria-labelledby="by-${table}-h">
<thead><tr>${header(label, table, "name", input.sorts, false)}${header("Calls", table, "calls", input.sorts, true)}<th scope="col" class="num wide">Input tokens</th><th scope="col" class="num wide">Output tokens</th>${header("Cost", table, "cost", input.sorts, true)}</tr></thead>
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
<p class="fig"><span class="big">${money(p.spent)}</span><span class="of">/ ${dollars(input.budgetUsd)} (${pctText})</span></p>
<p class="small muted">${resets}</p>
${bar}
</section>`;
}

export function renderUsagePage(input: UsagePageInput): string {
  const step = nextStep(input);
  const connect = !input.connected
    ? `<div class="banner next" role="note"><p>OpenRouter is not connected. Its spend shows here once it is.</p><a class="btn" href="${PROVIDERS_PATH}" data-next>Connect OpenRouter</a></div>`
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
<script>${BAR_JS}${SORT_JS}
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
table.usage th.num .th-sort { justify-content: flex-end; }
table.usage tbody tr:last-child td { border-bottom: 0; }
table.usage tfoot th, table.usage tfoot td { border-top: 1px solid var(--line); border-bottom: 0; font-weight: 600; font-size: .9rem; color: var(--text); }
table.usage tr.empty td { color: var(--muted); }
table.usage tr.empty td > * { vertical-align: middle; }
.u-name { overflow-wrap: anywhere; }
.u-sub { display: block; font-size: .8rem; color: var(--muted); font-weight: 400; overflow-wrap: anywhere; white-space: normal; }
table.usage .num .u-sub { white-space: nowrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .76rem; }
.share { display: block; height: 2px; margin-top: 6px; }
.share > span { display: block; height: 100%; background: var(--line); }
.share.top > span { background: var(--text); }
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

// Sorting in the page: a header's click reorders the rows, marks the column
// and puts the order in the address (history.replaceState: nothing loads).
// The header links stay real links, so a page without this script sorts on
// the server.
export const SORT_JS = `
(function () {
  var tables = Array.prototype.slice.call(document.querySelectorAll("table[data-sort-table]"));
  if (!tables.length) return;
  var state = {};
  function read(t) {
    var th = t.querySelector("th[aria-sort=ascending], th[aria-sort=descending]");
    var a = th && th.querySelector("a[data-sort]");
    return a ? { column: a.getAttribute("data-sort"), dir: th.getAttribute("aria-sort") === "ascending" ? "asc" : "desc" } : { column: "cost", dir: "desc" };
  }
  function next(cur, column) {
    if (cur.column === column) return { column: column, dir: cur.dir === "asc" ? "desc" : "asc" };
    return { column: column, dir: column === "name" ? "asc" : "desc" };
  }
  function query(over) {
    var parts = [];
    ["models", "tasks"].forEach(function (id) {
      var s = (over && over.id === id) ? over.sort : state[id];
      if (s) parts.push(id + "=" + s.column + ":" + s.dir);
    });
    return "?" + parts.join("&");
  }
  function byName(a, b) { return a.getAttribute("data-name").localeCompare(b.getAttribute("data-name"), "en", { numeric: true, sensitivity: "base" }); }
  function apply(t) {
    var id = t.getAttribute("data-sort-table"), s = state[id], sign = s.dir === "asc" ? 1 : -1;
    var body = t.querySelector("tbody");
    var rows = Array.prototype.slice.call(body.querySelectorAll("tr[data-name]"));
    rows.sort(function (a, b) {
      var p = s.column === "name" ? byName(a, b) : Number(a.getAttribute("data-" + s.column)) - Number(b.getAttribute("data-" + s.column));
      return p * sign || byName(a, b);
    });
    rows.forEach(function (r) { body.appendChild(r); });
  }
  function mark() {
    tables.forEach(function (t) {
      var id = t.getAttribute("data-sort-table"), s = state[id];
      t.querySelectorAll("a[data-sort]").forEach(function (a) {
        var column = a.getAttribute("data-sort"), on = column === s.column;
        a.parentElement.setAttribute("aria-sort", on ? (s.dir === "asc" ? "ascending" : "descending") : "none");
        a.querySelector(".sort-arrow").textContent = on ? (s.dir === "asc" ? "\\u25B2" : "\\u25BC") : "";
        a.setAttribute("href", query({ id: id, sort: next(s, column) }));
      });
    });
  }
  tables.forEach(function (t) { state[t.getAttribute("data-sort-table")] = read(t); });
  tables.forEach(function (t) {
    var id = t.getAttribute("data-sort-table");
    t.querySelectorAll("a[data-sort]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        state[id] = next(state[id], a.getAttribute("data-sort"));
        apply(t);
        mark();
        try { window.history.replaceState(null, "", location.pathname + query()); } catch (err) {}
      });
    });
  });
})();
`;

export interface UsageDeps {
  db: D1Database;
  userId: string;
  now: Date;
  secrets: SecretStore;
  fetcher?: typeof fetch;
}

export async function usagePageInput(url: URL, deps: UsageDeps): Promise<UsagePageInput> {
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
    sorts: { models: parseUsageSort(url.searchParams.get("models")), tasks: parseUsageSort(url.searchParams.get("tasks")) },
  };
}

// GET only; scoped to the signed-in user throughout.
export async function handleUsage(request: Request, deps: UsageDeps): Promise<Response> {
  const html = renderUsagePage(await usagePageInput(new URL(request.url), deps));
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export const isUsagePath = (pathname: string): boolean => pathname === USAGE_PATH;
