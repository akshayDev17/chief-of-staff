// Models › Usage, rendered on the server (design-v3 10.1 and 1.8; the M0
// design's Models → Usage screen): the month's OpenRouter spend against the
// monthly budget, as the budget bar shows it (the same bar as Models › Setup
// › Budgets, proxy/budget-bar.ts), then the spend per model and per task,
// from the usage ledger (usage.ts).
//
//   GET /chief-of-staff/models/usage
//
// Every figure on the page comes from one read of the ledger: the month's
// total is the app's own count, the figure that stops calls at the budget,
// and the headline says so; each table's foot is that same total.
// OpenRouter's own figure for the current key is read live, server side, on
// every visit, with or without a budget, from the same key and the same
// GET /api/v1/key that Providers' account line reads.
//
// Each model is named as OpenRouter's live list names it, its ID beside it;
// a model no longer in the list is shown by its ID. Its maker is named as on
// Providers: OpenRouter's own models carry the plug-in's own name. The app
// holds no list of its own. A model that list marks free (prices/openrouter.ts
// isTrulyFreeTextModel) carries "free"; every other one is paid.
//
// Both tables list the dearest first, ties by name: where the money went.
// The order is fixed: no sort control, so nothing on the page changes the
// address.
//
// Per model grows with every model tried (a Test all models run adds
// hundreds), so it scrolls inside its own box, about ten rows tall, its
// column header and its "This month" foot pinned to the box's top and
// bottom. Over ten rows, a search sits above it: any part of a model's name,
// maker or ID, with a live count and a Clear when nothing matches; beside it,
// the Maker filter Providers has (maker-filter.ts), which narrows the rows
// with the search. While either narrows the rows, the foot, still the
// month's total, reads "All models this month". Both run in the page only:
// no request, no reload, the address unchanged. Without scripts both stay
// hidden and the box holds the whole list. Per task
// is bounded by the app's tasks, about a dozen rows, so it stays a plain
// table.
//
// When OpenRouter's figure for the current key and the app's count differ,
// one line under the figures says why, from what the app knows: calls this
// month made before the current key (usage.ts beforeKeyUsd) are not in that
// key's figure. When those do not account for the difference, the line says
// only that the two differ. When OpenRouter's figure cannot be read while
// OpenRouter is connected and no budget is set, the line says that, and why,
// instead; with a budget set, the bar's own source line says it.
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
import { BAR_CSS, BAR_JS, budgetText, money, readKeyFigure, renderBudgetBar, type KeyFigure } from "../proxy/budget-bar";
import { readBudget } from "../proxy/budgets";
import { connectedAt, connectedProviders, readConnection } from "../proxy/connections";
import { nextMonthStart } from "../proxy/ledger";
import type { ConnectionFields, PluginRegistry } from "../proxy/plugin";
import { TEST_TASK } from "../proxy/proxy";
import { MAKER_CHIPS_HTML, MAKER_FILTER_CSS, MAKER_FILTER_HTML, MAKER_FILTER_JS, makerKey, makerRowAttrs, nameMakers } from "./maker-filter";
import { modelsSubtabs } from "./setup-tabs";
import { taskById } from "./tasks";
import { TEST_ALL_TASK } from "./test-all";
import { readMonthUsage, type MonthUsage, type UsageLine } from "./usage";

// A line with the name the page shows for it.
export interface NamedLine extends UsageLine {
  name: string;
  // Models only: the model is in OpenRouter's current list, and it is free
  // there; its maker's name, as OpenRouter's model names give it.
  listed?: boolean;
  free?: boolean;
  maker?: string;
}

const byName = (a: NamedLine, b: NamedLine) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }) || a.key.localeCompare(b.key);

const sortDearestFirst = (lines: NamedLine[]): NamedLine[] => [...lines].sort((a, b) => b.costUsd - a.costUsd || byName(a, b));

// The test calls are tasks of their own in the ledger; every other task is
// named as Model for each task names it.
const TASK_NAMES: Record<string, string> = { [TEST_TASK]: "Model tests", [TEST_ALL_TASK]: "Test all models" };
export const taskName = (id: string): string => TASK_NAMES[id] ?? taskById(id)?.label ?? id;

// `own`: the provider the lines are from, named as it names itself.
export function nameModels(lines: UsageLine[], catalog: OpenRouterCatalog | undefined, own?: { key: string; name: string }): NamedLine[] {
  const listed = new Map((catalog?.models ?? []).map((m) => [m.id, m]));
  const makers = nameMakers([...(catalog?.models ?? []), ...lines.map((l) => ({ id: l.key }))], own);
  return lines.map((l) => {
    const m = listed.get(l.key);
    return { ...l, name: m?.name || l.key, listed: Boolean(m), free: Boolean(m?.free), maker: makers.get(makerKey(l.key))! };
  });
}

export const nameTasks = (lines: UsageLine[]): NamedLine[] => lines.map((l) => ({ ...l, name: taskName(l.key) }));

export interface UsagePageInput {
  now: Date;
  connected: boolean;
  budgetUsd?: number;
  // OpenRouter's own figure for the current key, or why it could not be read.
  key: KeyFigure;
  connection?: ConnectionFields;
  // When the current key was made: the connection's connected_at.
  keySince?: string;
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
const dayMonthTime = (iso: string) => `${dayMonth(iso)} at ${iso.slice(11, 16)} UTC`;
const count = (n: number) => n.toLocaleString("en-US");

function costCell(l: NamedLine): string {
  const all = l.estimatedUsd > 0 && l.estimatedUsd >= l.costUsd - 0.000_000_5;
  const note = l.estimatedUsd <= 0 ? "" : all ? ` <span class="pill warn">estimated</span>` : `<span class="u-sub">${money(l.estimatedUsd)} of it estimated</span>`;
  const figure = l.costUsd > 0 ? money(l.costUsd) : `<span class="muted">${money(l.costUsd)}</span>`;
  return `${figure}${note}`;
}

// What a model's search matches: its readable name, its ID, and its
// maker's part of the ID with dashes as spaces ("meta-llama" as "meta llama").
export const findText = (l: NamedLine): string => {
  const maker = l.key.includes("/") ? l.key.slice(0, l.key.indexOf("/")).replace(/[-_]/g, " ") : "";
  return `${l.name} ${l.key} ${maker}`.toLowerCase();
};

function row(l: NamedLine, table: "models" | "tasks"): string {
  // The ID stays on one line, cut with an ellipsis on a phone; the full ID
  // is its tooltip, and the search still matches all of it.
  const id = table === "models"
    ? `<span class="u-sub mono u-id" title="${esc(l.key)}">${esc(l.key)}</span>${l.listed ? "" : `<span class="u-sub">Not in OpenRouter's list now</span>`}`
    : "";
  const free = l.free ? ` <span class="pill free">free</span>` : "";
  const refused = l.refused ? `${count(l.refused)} refused` : "";
  const phone = [`${count(l.calls)} call${l.calls === 1 ? "" : "s"}`, `${count(l.inputTokens + l.outputTokens)} tokens`, refused].filter(Boolean).join(" · ");
  const find = table === "models" ? ` data-find-text="${esc(findText(l))}"${makerRowAttrs(l.key, l.maker ?? makerKey(l.key))}` : "";
  return `<tr${find}>
<td><span class="u-name">${esc(l.name)}</span>${free}${id}<span class="u-sub u-phone">${phone}</span></td>
<td class="num wide">${count(l.calls)}${refused ? `<span class="u-sub">${refused}</span>` : ""}</td>
<td class="num wide">${count(l.inputTokens)}</td>
<td class="num wide">${count(l.outputTokens)}</td>
<td class="num">${costCell(l)}</td>
</tr>`;
}

// Per model's box holds about this many rows; a longer list gets the search.
export const BOX_ROWS = 10;

const SEARCH_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="m11 11 3.5 3.5"/></svg>`;
const CLEAR_ICON = `<svg viewBox="0 0 12 12" width="11" height="11" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg>`;

// The search and the Maker filter above Per model, hidden until the page's
// script shows them.
function modelSearch(n: number): string {
  return `<div class="find" data-find="by-models" data-noun="models" hidden>
<div class="search" role="search"><label class="visually-hidden" for="find-models">Search models by name, maker or ID</label>${SEARCH_ICON}<input type="search" id="find-models" aria-controls="by-models" placeholder="Search name, maker or ID" autocomplete="off" spellcheck="false"><button type="button" class="clear-x" data-clear-q aria-label="Clear search" hidden>${CLEAR_ICON}</button></div>
${MAKER_FILTER_HTML}
<p class="count" data-count aria-live="polite">${count(n)} models</p>
${MAKER_CHIPS_HTML}
</div>`;
}

function table(table: "models" | "tasks", lines: NamedLine[], input: UsagePageInput, emptyRow: string): string {
  const label = table === "models" ? "Model" : "Task";
  const sorted = sortDearestFirst(lines);
  const { total } = input.usage;
  const boxed = table === "models" && sorted.length > 0;
  const searchable = boxed && sorted.length > BOX_ROWS;
  const noMatch = searchable
    ? `\n<tr class="empty" data-no-match hidden><td colspan="5"><span>No model matches “<span data-said></span>”<span data-said-makers hidden> from the makers you picked</span>.</span> <button type="button" class="btn secondary small" data-clear>Clear</button></td></tr>`
    : "";
  const body = sorted.length ? sorted.map((l) => row(l, table)).join("\n") + noMatch : `<tr class="empty"><td colspan="5">${emptyRow}</td></tr>`;
  // The search script names the foot "All models this month" while it narrows the rows.
  const footLabel = searchable ? `<span data-foot-label>This month</span>` : "This month";
  const foot = sorted.length
    ? `<tfoot><tr><th scope="row">${footLabel}<span class="u-sub u-phone">${count(total.calls)} call${total.calls === 1 ? "" : "s"}</span></th><td class="num wide">${count(total.calls)}</td><td class="num wide">${count(total.inputTokens)}</td><td class="num wide">${count(total.outputTokens)}</td><td class="num">${money(total.costUsd)}</td></tr></tfoot>`
    : "";
  const frame = boxed
    ? `${searchable ? modelSearch(sorted.length) : ""}<div class="tbl-wrap tbl-box" tabindex="0" role="region" aria-label="Per model, scrolls">`
    : `<div class="tbl-wrap">`;
  return `${frame}<table class="usage" id="by-${table}" aria-labelledby="by-${table}-h">
<thead><tr><th scope="col">${label}</th><th scope="col" class="num wide">Calls</th><th scope="col" class="num wide">Input tokens</th><th scope="col" class="num wide">Output tokens</th><th scope="col" class="num">Cost</th></tr></thead>
<tbody>
${body}
</tbody>${foot}</table></div>`;
}

// How OpenRouter's figure for the current key and the app's count differ,
// when they do by half a cent or more. `explained`: the calls made before
// the current key account for the whole difference.
export interface SpendGap {
  reportedUsd: number;
  ledgerUsd: number;
  beforeKeyUsd: number;
  explained: boolean;
}

const HALF_CENT = 0.005;

export function spendGap(ledgerUsd: number, key: KeyFigure, beforeKeyUsd: number): SpendGap | undefined {
  if (!("usage" in key)) return undefined;
  const reportedUsd = key.usage.monthlyUsd;
  if (Math.abs(ledgerUsd - reportedUsd) < HALF_CENT) return undefined;
  const explained = beforeKeyUsd >= HALF_CENT && Math.abs(ledgerUsd - beforeKeyUsd - reportedUsd) < HALF_CENT;
  return { reportedUsd, ledgerUsd, beforeKeyUsd, explained };
}

function gapNote(gap: SpendGap, keySince: string | undefined): string {
  const made = keySince ? `, made when you connected on ${dayMonthTime(keySince)}` : "";
  const stops = `The app's count, ${money(gap.ledgerUsd)}, is what stops calls at your budget.`;
  const line = gap.explained
    ? `OpenRouter shows ${money(gap.reportedUsd)} for your current key; ${gap.reportedUsd >= HALF_CENT ? "the other" : "all"} ${money(gap.beforeKeyUsd)} was spent this month on an earlier key.`
    : `OpenRouter's figure for your current key, ${money(gap.reportedUsd)}, and the app's count, ${money(gap.ledgerUsd)}, differ.`;
  const facts = [
    `OpenRouter's figure counts one key only: the key the app holds now${made}. Each Connect makes a new key.`,
    `The app counts every call it sent to OpenRouter this month, on any key${
      gap.beforeKeyUsd >= HALF_CENT ? `: ${money(gap.beforeKeyUsd)} before that key was made, ${money(gap.ledgerUsd - gap.beforeKeyUsd)} since` : ""
    }.`,
    ...(gap.explained ? [] : [`The app cannot tell what the rest of the difference is. Compare the calls on <a href="${OPENROUTER_ACTIVITY_URL}" target="_blank" rel="noopener noreferrer">OpenRouter's Activity page</a>.`]),
    stops,
  ];
  return `<div class="gap"><p class="small">${line}</p>
<details class="more"><summary>Why the two figures differ</summary><ul class="small">${facts.map((f) => `<li>${f}</li>`).join("")}</ul></details></div>`;
}

// The line on OpenRouter's figure for the current key: why it differs from
// the app's count, or, while connected with no budget set, why it could not
// be read (with a budget, the bar says so); nothing when the two agree, or
// when there is no key to read (the Connect banner says so).
function keyNote(input: UsagePageInput): string {
  const { key } = input;
  if ("unread" in key) {
    return input.connected && input.budgetUsd === undefined ? `<div class="gap"><p class="small">The app could not read OpenRouter's figure for your current key just now, so it cannot check its count against it: ${esc(key.unread)}.</p></div>` : "";
  }
  const gap = spendGap(input.usage.total.costUsd, key, input.usage.beforeKeyUsd);
  return gap ? gapNote(gap, input.keySince) : "";
}

function spendCard(input: UsagePageInput, step: NextStep): string {
  const ledgerUsd = input.usage.total.costUsd;
  const counted = `The app's own count since ${dayMonth(input.usage.since)}, the figure that stops calls at your budget. It starts again on ${dayMonth(nextMonthStart(input.now).toISOString())}.`;
  const note = keyNote(input);
  if (input.budgetUsd === undefined) {
    // A budget is set per connected provider, so before Connect there is
    // nothing to set it on: Connect, above, comes first.
    const set = input.connected ? `<a class="btn${step === "budget" ? "" : " secondary"}" href="${BUDGETS_PATH}" data-next>Set a budget</a>` : "";
    return `<section class="card lead" aria-labelledby="spend-h"><h2 id="spend-h">Model spend this month</h2>
<p class="fig"><span class="big">${money(ledgerUsd)}</span><span class="of">no budget set</span></p>
<p class="small muted">${counted}</p>
${note}
<div class="unset"><p>${input.connected ? "Model calls stay stopped until you set a monthly budget." : "Once OpenRouter is connected, set a monthly budget for it."}</p>${set}</div>
</section>`;
  }
  const pct = (ledgerUsd / input.budgetUsd) * 100;
  const pctText = ledgerUsd > 0 && pct < 1 ? "under 1%" : `${Math.round(pct)}%`;
  const bar = renderBudgetBar({ budgetUsd: input.budgetUsd, ledgerUsd, key: input.key, connection: input.connection });
  return `<section class="card lead" aria-labelledby="spend-h"><h2 id="spend-h">Model spend this month</h2>
<p class="fig"><span class="big">${money(ledgerUsd)}</span><span class="of">/ ${budgetText(input.budgetUsd)} (${pctText})</span></p>
<p class="small muted">${counted}</p>
${note}
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
<style>${PAGE_CSS}${CONTROLS_CSS}${BAR_CSS}${MAKER_FILTER_CSS}${CSS}</style>
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
<script>${BAR_JS}${FIND_JS}
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
  table.usage { table-layout: fixed; }
  .u-id { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .u-phone { display: block; }
}
/* Per model: the search and the Maker filter above it, then its own scroll box.
   The filter's tokens (maker-filter.ts), on this page's palette. */
.find { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 8px;
  --surface: var(--card); --raised: color-mix(in oklab, var(--text) 4%, var(--card)); --active: color-mix(in oklab, var(--text) 8%, var(--card));
  --chip-hover: color-mix(in oklab, var(--text) 13%, var(--card)); --border: var(--line); --rule: var(--line); --control: var(--line);
  --control-hover: var(--muted); --shadow: color-mix(in oklab, var(--text) 16%, transparent); --radius-control: 8px; --radius-card: 10px;
  --control-h: 36px; --fs-small: .85rem; --t: 150ms; }
.find .chips { flex: 1 1 100%; }
.find[hidden] { display: none; }
.search { position: relative; flex: 0 1 340px; min-width: 0; }
.search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
.search input { width: 100%; min-height: 36px; padding: 0 34px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--text); font: inherit; font-size: .9rem; }
.search input::placeholder { color: var(--muted); }
.search input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.search input::-webkit-search-cancel-button { display: none; }
.search .clear-x { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: none; color: var(--muted); cursor: pointer; }
.search .clear-x[hidden] { display: none; }
.search .clear-x:hover { color: var(--text); }
.search .clear-x:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
.find .count { margin: 0 0 0 auto; font-size: .85rem; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.tbl-box { max-height: 40rem; overflow: auto; overscroll-behavior: contain; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); border-radius: 0; }
.tbl-box:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tbl-box table.usage { border-collapse: separate; border-spacing: 0; }
.tbl-box thead th { position: sticky; top: 0; z-index: 2; background: var(--card); }
.tbl-box tfoot th, .tbl-box tfoot td { position: sticky; bottom: 0; z-index: 2; background: var(--card); }
.tbl-box th:last-child, .tbl-box td:last-child { padding-right: 8px; }
.gap { margin: 8px 0 0; }
.gap > p { margin: 0; }
.gap details.more { margin-top: 2px; }
.gap ul { margin: 4px 0 0; padding-left: 20px; }
@media (max-width: 639px) {
  .tbl-box { max-height: min(30rem, 64svh); }
  .search { flex: 1 1 100%; }
  .find .count { margin: 0; }
}
.pill.free { background: var(--ok-soft); color: var(--ok); }
.pill { white-space: nowrap; }
`;

// The Per model search and Maker filter: shows them, then filters the rows
// on each keystroke or choice. Every word typed must appear in the row's
// name, maker or ID, and its maker must be one chosen, if any is. The search's
// own clear and Escape clear the search; Clear under "No model matches"
// clears the makers too. While either narrows the rows, the foot reads "All
// models this month". Nothing is sent and the address never changes.
export const FIND_JS = String.raw`
(function () {
${MAKER_FILTER_JS}
Array.prototype.forEach.call(document.querySelectorAll("[data-find]"), function (find) {
  var table = document.getElementById(find.getAttribute("data-find"));
  var box = table.parentNode, input = find.querySelector(".search input"), count = find.querySelector("[data-count]"), x = find.querySelector("[data-clear-q]");
  var rows = Array.prototype.slice.call(table.querySelectorAll("tr[data-find-text]"));
  var none = table.querySelector("tr[data-no-match]"), said = none.querySelector("[data-said]"), fromMakers = none.querySelector("[data-said-makers]"), noun = " " + find.getAttribute("data-noun");
  var footLabel = table.querySelector("[data-foot-label]");
  var all = rows.length.toLocaleString("en-US");
  var makers = makerFilter({ scope: find, rows: function () { return rows; }, changed: apply });
  function apply() {
    var q = input.value.trim(), words = q.toLowerCase().split(/\s+/).filter(Boolean), picked = makers.chosen().length, shown = 0;
    rows.forEach(function (r) {
      var text = r.getAttribute("data-find-text");
      var hit = makers.matches(r) && words.every(function (w) { return text.indexOf(w) !== -1; });
      r.hidden = !hit;
      if (hit) shown++;
    });
    var narrowed = words.length > 0 || picked > 0;
    count.textContent = narrowed ? shown.toLocaleString("en-US") + " of " + all + noun : all + noun;
    footLabel.textContent = narrowed ? "All models this month" : "This month";
    said.textContent = q || "your filter";
    fromMakers.hidden = !picked;
    none.hidden = shown > 0;
    x.hidden = !input.value;
    box.scrollTop = 0;
    makers.render(true);
  }
  function clearSearch() { input.value = ""; apply(); input.focus(); }
  input.addEventListener("input", apply);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") e.preventDefault();
    if (e.key === "Escape" && input.value) { e.preventDefault(); clearSearch(); }
  });
  x.addEventListener("click", clearSearch);
  none.querySelector("[data-clear]").addEventListener("click", function () { makers.clear(); clearSearch(); });
  find.hidden = false;
  apply();
});
})();
`;

export interface UsageDeps {
  db: D1Database;
  userId: string;
  now: Date;
  secrets: SecretStore;
  plugins: PluginRegistry;
  fetcher?: typeof fetch;
}

export async function usagePageInput(deps: UsageDeps): Promise<UsagePageInput> {
  const { db, userId, now } = deps;
  const keySince = await connectedAt(db, userId, "openrouter");
  const [providers, budget, usage, connection, catalog, key] = await Promise.all([
    connectedProviders(db, userId),
    readBudget(db, userId, "openrouter"),
    readMonthUsage(db, userId, now, keySince),
    readConnection(db, userId, "openrouter"),
    readCurrentCatalog(db),
    // Read whatever the budget: without a key in the vault it asks nothing.
    readKeyFigure(deps.secrets, userId, now, deps.fetcher),
  ]);
  const plugin = deps.plugins.openrouter;
  const own = plugin && { key: plugin.provider, name: plugin.connect.guide.name };
  return {
    now,
    connected: providers.includes("openrouter"),
    budgetUsd: budget?.monthlyUsd,
    key,
    connection,
    ...(keySince ? { keySince: keySince.toISOString() } : {}),
    usage,
    models: nameModels(usage.byModel, catalog, own),
    tasks: nameTasks(usage.byTask),
  };
}

// GET only; scoped to the signed-in user throughout.
export async function handleUsage(deps: UsageDeps): Promise<Response> {
  const html = renderUsagePage(await usagePageInput(deps));
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export const isUsagePath = (pathname: string): boolean => pathname === USAGE_PATH;
