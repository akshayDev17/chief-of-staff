// Models › Setup › Budgets, rendered on the server (design-v3 1.8): the
// user's one monthly OpenRouter budget.
//
//   GET  /chief-of-staff/models/setup/budgets[?per_day=<n>]   the page, or with Accept: application/json its <main>
//   POST /chief-of-staff/models/setup/budgets   do=accept (per_day) | do=set (amount)
//
// Before the budget is set the page suggests one, with its basis, marked
// "estimate" with its "checked on" date: the dearest model, for one
// application, among the user's usable models that their tasks' saved
// choices use, else among all their usable models (budgets.ts
// readSuggestionBasis; usable through models/usable.ts only), at its price
// on OpenRouter's list (a router at the user's price cap on it), and the
// design's tokens per application at the applications a day the user plans
// (5 until they type another). Typing the volume works the figure out again
// in the page, with no request. One tap sets the suggestion; the user may
// type their own instead. Until it is set, no model can be called except a
// test call (proxy.ts, `no_budget`). Once set, the page shows the month's
// spend as the shared budget bar (budget-bar.ts, the same bar as Models ›
// Usage), and the budget can be changed.
//
// Nothing reloads the page or changes its address (the owner, 2026-11-28, of
// the Models pages): the page's script sends each form in place with
// Accept: application/json, and swaps in the <main> the
// server answers with. A form posted without the script gets a redirect back
// to the page (post-redirect-get), with any problem and the typed amount in a
// flash cookie the next page shows once, so a refresh re-runs nothing.

import { BUDGETS_PATH, PROVIDERS_PATH } from "../paths";
import { esc, nbDate } from "../prices/page";
import type { Provider } from "../prices/types";
import { modelsSubtabs, nextAction, SETUP_TABS } from "../models/setup-tabs";
import { PAGE_STYLE } from "../providers/page-style";
import type { SecretStore } from "../providers/secrets";
import { BAR_CSS, BAR_JS, budgetText, money, readKeyFigure, renderBudgetBar, type KeyFigure } from "./budget-bar";
import {
  DAYS_A_MONTH,
  DEFAULT_APPLICATIONS_A_DAY,
  MAX_APPLICATIONS_A_DAY,
  parseBudget,
  readBudget,
  readSuggestionBasis,
  setBudget,
  suggest,
  TOKENS_PER_APPLICATION,
  type Budget,
  type SuggestionBasis,
} from "./budgets";
import { readConnection } from "./connections";
import { monthSpend } from "./ledger";
import type { ConnectionFields } from "./plugin";

const PROVIDER: Provider = "openrouter";

// What to show; it changes nothing.
export interface View {
  applicationsADay: number;
}

// What a page shows once, after a form: a problem with the amount typed, or
// what was just done.
export interface Flash {
  problem?: string;
  typed?: string;
  said?: string;
}

export interface BudgetsState {
  connection?: ConnectionFields;
  budget?: Budget;
  spentThisMonth: number;
  basis?: SuggestionBasis;
  // OpenRouter's own figure for the key, read once the budget is set.
  key?: KeyFigure;
  view: View;
  flash: Flash;
}

// The volume the suggestion is worked at: a whole number of applications a
// day from 1 to 100, else the default.
export function parseApplicationsADay(text: string | null): number {
  const n = Number(text);
  return text && Number.isInteger(n) && n >= 1 && n <= MAX_APPLICATIONS_A_DAY ? n : DEFAULT_APPLICATIONS_A_DAY;
}

export const parseView = (params: URLSearchParams): View => ({
  applicationsADay: parseApplicationsADay(params.get("per_day")),
});

const viewHref = (view: View): string => `${BUDGETS_PATH}?per_day=${view.applicationsADay}`;

const perM = (usd: number): string => `$${usd.toFixed(2)}`;
const day = (iso: string): string => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const tabsLine = (): string =>
  `<nav class="tabs" aria-label="Models setup">${SETUP_TABS.map((t) => (t.href === BUDGETS_PATH ? `<span aria-current="page">${esc(t.label)}</span>` : `<a href="${t.href}">${esc(t.label)}</a>`)).join("")}</nav>`;

// The volume field. Typing in it works the suggestion out again in the page;
// without the script its Work out button asks the server.
function volumeForm(view: View, basis: SuggestionBasis): string {
  return `<form class="vol" method="get" action="${BUDGETS_PATH}" data-live>
<span>For</span><input class="num" type="number" id="per-day" name="per_day" min="1" max="${MAX_APPLICATIONS_A_DAY}" step="1" inputmode="numeric" value="${view.applicationsADay}" aria-label="Applications a day you plan" data-per-day data-per-app="${basis.perApplicationUsd}" data-k="per-day"><span>applications a day</span>
<noscript><button type="submit" class="btn small outline">Work out</button></noscript>
</form>`;
}

function basisLines(basis: SuggestionBasis): string {
  const m = basis.model;
  const which = basis.from === "tasks" ? "the dearest model your tasks use" : "the dearest model that passed its test";
  const price = m.capped
    ? `Your price cap on it: ${perM(m.inputUsdPerMTok)} in, ${perM(m.outputUsdPerMTok)} out per million tokens, set ${nbDate(m.checkedOn)}. A call to it costs at most that.`
    : `Its price on OpenRouter's list: ${perM(m.inputUsdPerMTok)} in, ${perM(m.outputUsdPerMTok)} out per million tokens, read ${nbDate(m.checkedOn)}.`;
  return `<p class="from">From <strong>${esc(m.name)}</strong>${m.free ? ' <span class="pill free">free</span>' : ""}, ${which}.</p>
<details class="how"><summary>How this is worked out</summary><ul>
<li>${esc(m.name)} (${esc(m.model)}) is ${which}.</li>
<li>${price}</li>
<li>One application, by the design's estimate: ${TOKENS_PER_APPLICATION.input.toLocaleString("en-US")} tokens in, ${TOKENS_PER_APPLICATION.output.toLocaleString("en-US")} out, every one costed as uncached.</li>
<li>So $${basis.perApplicationUsd.toFixed(4)} an application, times the applications a day, times ${DAYS_A_MONTH} days, rounded up to a whole dollar, at least $1.</li>
<li>Replaced by the figures the app measures once it runs.</li>
</ul></details>`;
}

// The suggestion's head: "Suggested · estimate · checked on <date>", then the figure.
function suggestionHead(basis: SuggestionBasis, view: View): string {
  const s = suggest(basis, view.applicationsADay);
  return `<p class="label">Suggested <span class="pill warn">estimate</span> <span class="meta">checked on ${nbDate(basis.model.checkedOn)}</span></p>
<p class="fig"><span class="num big" data-sugg>${budgetText(s.monthlyUsd)}</span> <span class="unit">a month</span></p>`;
}

const perDayField = (view: View): string => `<input type="hidden" name="per_day" value="${view.applicationsADay}" data-per-day-copy>`;

function acceptForm(basis: SuggestionBasis, view: View, cls: string, label: (usd: string) => string): string {
  const usd = budgetText(suggest(basis, view.applicationsADay).monthlyUsd);
  return `<form method="post" action="${BUDGETS_PATH}" data-fetch>${perDayField(view)}<button type="submit" class="btn ${cls}" name="do" value="accept" data-k="accept" data-accept data-label="${esc(label("{usd}"))}">${esc(label(usd))}</button></form>`;
}

// The field for the user's own amount, with the problem under it when the
// last one typed was not a budget.
function ownForm(state: BudgetsState, opts: { cls: string; button: string; value?: string; label: string }): string {
  const { flash, view } = state;
  const value = flash.problem ? (flash.typed ?? "") : (opts.value ?? "");
  const err = flash.problem ? `<p class="field-err" id="amount-err" role="alert">${esc(flash.problem)}</p>` : "";
  return `<form class="own" method="post" action="${BUDGETS_PATH}" data-fetch>${perDayField(view)}
<label for="amount">${esc(opts.label)}</label>
<span class="money-in"><span aria-hidden="true">$</span><input id="amount" name="amount" inputmode="decimal" autocomplete="off" value="${esc(value)}"${flash.problem ? ' aria-invalid="true" aria-describedby="amount-err"' : ""} data-k="amount"></span>
<button type="submit" class="btn ${opts.cls}" name="do" value="set" data-k="set">${esc(opts.button)}</button>
${err}</form>`;
}

// Under the field before the budget is set: calls stay stopped, and what the
// month has spent already (test calls), which the budget counts too.
function stopLines(state: BudgetsState): string {
  const spent = state.spentThisMonth >= 0.005 ? `<p class="stop">Already spent this month: ${money(state.spentThisMonth)}. The budget counts it.</p>` : "";
  return `<p class="stop">Model calls stay stopped until it is set. Tests still run.</p>${spent}`;
}

function unsetPanel(state: BudgetsState): string {
  const { basis, view } = state;
  if (!basis) {
    return `<div class="sugg">
<p class="label">Suggested</p>
<p class="none">No suggestion yet: no model has passed its test.</p>
<div class="acts"><a class="btn outline" href="${PROVIDERS_PATH}#test" data-k="test">Test a model</a></div>
</div>
<div class="set">${ownForm(state, { cls: "primary", button: "Set budget", label: "Your monthly budget" })}
${stopLines(state)}</div>`;
  }
  return `<div class="sugg">
${suggestionHead(basis, view)}
${volumeForm(view, basis)}
${basisLines(basis)}
</div>
<div class="set">
${acceptForm(basis, view, "primary wide", (usd) => `Set ${usd} a month`)}
<p class="or">or type your own</p>
${ownForm(state, { cls: "outline", button: "Set", label: "Your own monthly budget" })}
${stopLines(state)}
</div>`;
}

function setPanel(state: BudgetsState, budget: Budget): string {
  const { basis, view } = state;
  const bar = renderBudgetBar({ budgetUsd: budget.monthlyUsd, ledgerUsd: state.spentThisMonth, key: state.key ?? { unread: "OpenRouter's figure was not read" }, budgetHref: "#amount", connection: state.connection });
  const again = basis
    ? `<details class="how again"><summary>Suggested: about <span data-sugg>${budgetText(suggest(basis, view.applicationsADay).monthlyUsd)}</span> a month</summary>
${volumeForm(view, basis)}
${basisLines(basis)}
<div class="acts">${acceptForm(basis, view, "small outline", (usd) => `Use ${usd}`)}</div>
</details>`
    : "";
  return `<div class="sugg">
<p class="label">Your budget</p>
<p class="fig"><span class="num big">${budgetText(budget.monthlyUsd)}</span> <span class="unit">a month</span></p>
<p class="meta">Set ${day(budget.setAt)}.</p>
${bar}
</div>
<div class="set">
${ownForm(state, { cls: "outline", button: "Save", value: String(budget.monthlyUsd), label: "Change it" })}
${again}
</div>`;
}

function notConnectedPanel(): string {
  return `<div class="sugg">
<p class="label">OpenRouter <span class="pill">Not connected</span></p>
<p class="none">Connect OpenRouter first. The budget limits its calls.</p>
</div>
<div class="set"><form method="post" action="${PROVIDERS_PATH}/openrouter/connect"><button type="submit" class="btn primary wide" data-k="connect">Connect OpenRouter</button></form></div>`;
}

export function renderMain(state: BudgetsState): string {
  const { budget, flash } = state;
  const panel = !state.connection ? notConnectedPanel() : budget ? setPanel(state, budget) : unsetPanel(state);
  const said = flash.said ? `<div class="banner ok" role="status">${esc(flash.said)}</div>` : "";
  // A problem has its own place under the amount field; with no field (not
  // connected) it shows here.
  const problem = flash.problem && !state.connection ? `<div class="banner warn" role="alert">${esc(flash.problem)}</div>` : "";
  return `<div class="title-row"><h1>Models</h1>${modelsSubtabs("setup")}</div>
${tabsLine()}
${said}${problem}
<section class="block" aria-labelledby="h-budget">
<div class="block-head"><h2 id="h-budget">Monthly budget</h2><p class="sub">One budget for OpenRouter, counted from the 1st.</p></div>
<div class="panel budget">${panel}</div>
<details class="how about"><summary>How a budget works</summary><ul>
<li>When the month's spend reaches it, every model call stops until the 1st, a task's fallback model included.</li>
<li>Until it is set, no model can be called except a model's test call and Test all models.</li>
<li>OpenRouter's key has its own credit limit, set on OpenRouter; it can refuse calls first.</li>
</ul></details>
</section>
<div class="next-row">${nextAction(BUDGETS_PATH, budget ? "btn primary" : "btn outline")}</div>`;
}

export function renderBudgetsPage(state: BudgetsState): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Models · Budgets · Chief of staff</title>
<link rel="icon" href="data:,">
<style>${PAGE_STYLE}${CSS}${BAR_CSS}</style>
</head>
<body>
<main class="screen" id="screen">
${renderMain(state)}
</main>
<script>${BAR_JS}${BUDGETS_SCRIPT}</script>
</body>
</html>`;
}

// The budget bar's own names for the page's tokens, and the panel's layout.
// Grid at 1440: the panel is the screen's 1152px column, the suggestion (or
// the budget with its bar) on the left, the actions in a 360px column on the
// right, as on Providers; one column under 860px.
const CSS = `
:root { --line: var(--border); --card: var(--surface); --warn: var(--pill-warning-ink); --warn-soft: var(--pill-warning-bg); }
.muted { color: var(--muted); }
.budget { display: grid; grid-template-columns: minmax(0, 1fr) 360px; }
.budget > div { padding: var(--card-pad); min-width: 0; }
.budget .set { border-left: 1px solid var(--border); display: grid; gap: 12px; align-content: start; }
.budget .label { font-size: var(--fs-small); color: var(--muted); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.budget .meta { font-size: var(--fs-small); color: var(--muted); }
.budget .bb { margin-top: 20px; }
.budget .fig { margin-top: 6px; display: flex; align-items: baseline; gap: 8px; }
.budget .big { font-size: 34px; line-height: 40px; font-weight: 700; }
.budget .unit { color: var(--muted); }
.budget .none { margin-top: 6px; }
.budget .acts { margin-top: 12px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.vol { margin-top: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.vol input { width: 4.5em; height: var(--control-h); padding: 0 8px; border: 1px solid var(--control); border-radius: var(--radius-control); background: var(--surface); text-align: right; }
.vol input[aria-invalid="true"], .money-in input[aria-invalid="true"] { border-color: var(--negative); }
.from { margin-top: 10px; }
details.how { margin-top: 8px; font-size: var(--fs-small); }
details.how ul { margin-top: 6px; display: grid; gap: 4px; padding-left: 18px; list-style: disc; color: var(--muted); }
details.how > summary { cursor: pointer; color: var(--accent); width: fit-content; }
details.about { margin-top: 12px; }
.own { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 8px; align-items: center; }
.own label { grid-column: 1 / -1; font-size: 14px; }
.money-in { position: relative; display: block; }
.money-in > span { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
.money-in input { width: 100%; height: var(--control-h); padding: 0 10px 0 24px; border: 1px solid var(--control); border-radius: var(--radius-control); background: var(--surface); font-family: var(--figures); font-variant-numeric: tabular-nums; }
.money-in input:focus, .vol input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); } /* taste-skill-ignore: focus ring, not a shadow */
.field-err { grid-column: 1 / -1; color: var(--negative); font-size: var(--fs-small); }
.or { font-size: var(--fs-small); color: var(--muted); text-align: center; }
.stop { font-size: var(--fs-small); color: var(--muted); }
.again .acts { margin-top: 10px; }
.spin { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 860px) {
  .budget { grid-template-columns: minmax(0, 1fr); }
  .budget .set { border-left: 0; border-top: 1px solid var(--border); }
}
@media (max-width: 640px) {
  .budget > div { padding: 16px; }
  .budget .big { font-size: 30px; line-height: 36px; }
  .btn { min-height: 44px; }
  .money-in input, .vol input { height: 44px; }
}
`;

// The page's script. Typing the applications a day works the suggestion out
// again, with monthlyFor's own sum (budgets.ts), and sends nothing; every
// form marked data-fetch is sent in place, asking for JSON, and the <main>
// the server answers with is swapped in, the address unchanged. Focus goes
// where the answer names, else stays.
const BUDGETS_SCRIPT = String.raw`
(function () {
  "use strict";
  var main = document.getElementById("screen");
  if (!main || !window.fetch) return;
  var busy = false;
  var DAYS = ${DAYS_A_MONTH}, MAX = ${MAX_APPLICATIONS_A_DAY};
  function money(n) { return "$" + n.toLocaleString("en-US"); }
  function perDay() {
    var f = main.querySelector("[data-per-day]");
    if (!f) return null;
    var n = Number(f.value);
    return f.value !== "" && n % 1 === 0 && n >= 1 && n <= MAX ? n : null;
  }
  function rework(f) {
    var n = perDay(), ok = n !== null;
    f.setAttribute("aria-invalid", String(!ok));
    main.querySelectorAll("[data-per-day]").forEach(function (o) { if (o !== f) o.value = f.value; });
    main.querySelectorAll("[data-accept]").forEach(function (b) { b.disabled = !ok; });
    if (!ok) return;
    var usd = money(Math.max(1, Math.ceil(Number(f.getAttribute("data-per-app")) * n * DAYS)));
    main.querySelectorAll("[data-sugg]").forEach(function (s) { s.textContent = usd; });
    main.querySelectorAll("[data-accept]").forEach(function (b) { b.textContent = b.getAttribute("data-label").replace("{usd}", usd); });
    main.querySelectorAll("[data-per-day-copy]").forEach(function (h) { h.value = String(n); });
  }
  function say(text) {
    var box = document.createElement("div");
    box.className = "banner warn";
    box.setAttribute("role", "alert");
    box.textContent = text;
    var old = main.querySelector(".banner");
    if (old) old.replaceWith(box); else main.querySelector(".tabs").after(box);
  }
  function swap(html, focusK) {
    main.innerHTML = html;
    if (window.cosBudgetBars) window.cosBudgetBars();
    var t = focusK && (main.querySelector('[data-k="' + focusK + '"]') || (focusK === "next" && main.querySelector("[data-next]")));
    if (t) t.focus({ preventScroll: true });
  }
  function send(url, init, button) {
    if (busy) return;
    busy = true;
    if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); button.insertAdjacentHTML("afterbegin", '<span class="spin" aria-hidden="true"></span> '); }
    init.headers = { accept: "application/json" };
    init.credentials = "same-origin";
    fetch(url, init)
      .then(function (r) { if (!r.ok && r.status !== 400) throw new Error(String(r.status)); return r.json(); })
      .then(function (j) { busy = false; swap(j.main, j.focus); })
      .catch(function () {
        busy = false;
        if (button) { button.disabled = false; button.removeAttribute("aria-busy"); var s = button.querySelector(".spin"); if (s) s.remove(); }
        say("Couldn't reach the app just now. Try again.");
      });
  }
  document.addEventListener("input", function (e) { if (e.target.matches && e.target.matches("[data-per-day]")) rework(e.target); });
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!main.contains(form)) return;
    if (form.matches("form[data-live]")) { e.preventDefault(); return; }
    if (!form.matches("form[data-fetch]")) return;
    e.preventDefault();
    var b = e.submitter || form.querySelector("[type=submit]");
    if (b && b.disabled) return;
    var data = new FormData(form);
    if (b && b.name) data.append(b.name, b.value);
    send(form.action, { method: "POST", body: data }, b);
  });
  document.addEventListener("click", function (e) {
    var to = e.target.closest && e.target.closest('a[href="#amount"]');
    if (to && main.contains(to)) { var f = document.getElementById("amount"); if (f) { e.preventDefault(); f.focus(); f.select(); } }
  });
})();
`;

export interface KeyReader {
  secrets: SecretStore;
  fetcher?: typeof fetch;
}

async function readState(db: D1Database, userId: string, view: View, flash: Flash, now: Date, reader: KeyReader): Promise<BudgetsState> {
  const [connection, budget, spentThisMonth, basis] = await Promise.all([
    readConnection(db, userId, PROVIDER),
    readBudget(db, userId, PROVIDER),
    monthSpend(db, userId, PROVIDER, now),
    readSuggestionBasis(db, userId),
  ]);
  return {
    connection,
    budget,
    spentThisMonth,
    basis,
    ...(budget ? { key: await readKeyFigure(reader.secrets, userId, now, reader.fetcher) } : {}),
    view,
    flash,
  };
}

const FLASH_COOKIE = "cos_budgets_flash";

function encodeFlash(flash: Flash): string {
  const bytes = new TextEncoder().encode(JSON.stringify(flash));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readFlash(request: Request): Flash | undefined {
  const raw = (request.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${FLASH_COOKIE}=`))?.slice(FLASH_COOKIE.length + 1);
  if (!raw) return undefined;
  try {
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const f = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as Flash;
    return {
      ...(typeof f.problem === "string" ? { problem: f.problem.slice(0, 300) } : {}),
      ...(typeof f.typed === "string" ? { typed: f.typed.slice(0, 40) } : {}),
      ...(typeof f.said === "string" ? { said: f.said.slice(0, 300) } : {}),
    };
  } catch {
    return undefined;
  }
}

const flashCookie = (flash: Flash | undefined): string =>
  flash && Object.keys(flash).length
    ? `${FLASH_COOKIE}=${encodeFlash(flash)}; Path=${BUDGETS_PATH}; Max-Age=300; HttpOnly; Secure; SameSite=Lax`
    : `${FLASH_COOKIE}=; Path=${BUDGETS_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export const NOT_A_BUDGET = "Type a budget in dollars, more than $0, for example 30.";

// GET shows the page, or its <main> as JSON; POST sets or changes the
// budget, then answers in place (JSON) or redirects back to the page.
// Scoped to the signed-in user throughout.
export async function handleBudgets(request: Request, db: D1Database, userId: string, now: Date, reader: KeyReader): Promise<Response> {
  const url = new URL(request.url);
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
  const show = async (view: View, flash: Flash, extra: { focus?: string; status?: number; clearFlash?: boolean } = {}): Promise<Response> => {
    const state = await readState(db, userId, view, flash, now, reader);
    if (wantsJson) {
      return new Response(JSON.stringify({ main: renderMain(state), ...(extra.focus ? { focus: extra.focus } : {}) }), {
        status: extra.status ?? 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    if (extra.clearFlash) headers.append("set-cookie", flashCookie(undefined));
    return new Response(renderBudgetsPage(state), { status: extra.status ?? 200, headers });
  };

  if (request.method === "GET") {
    const flash = wantsJson ? undefined : readFlash(request);
    return show(parseView(url.searchParams), flash ?? {}, { clearFlash: flash !== undefined });
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  // A form posted from another site is refused.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return new Response(null, { status: 403 });
  const form = await request.formData();
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };
  const view: View = { applicationsADay: parseApplicationsADay(field("per_day")) };
  // In place, the page as it is now; without the script, a redirect to it,
  // with the flash in its cookie.
  const done = (flash: Flash, focus: string, status = 200): Promise<Response> | Response => {
    if (wantsJson) return show(view, flash, { focus, status });
    const headers = new Headers({ location: `${url.origin}${viewHref(view)}${flash.problem ? "#amount" : ""}` });
    headers.append("set-cookie", flashCookie(flash));
    return new Response(null, { status: 303, headers });
  };

  if (!(await readConnection(db, userId, PROVIDER))) return done({ problem: "Connect OpenRouter first. The budget limits its calls." }, "connect", 400);
  switch (field("do")) {
    case "accept": {
      // The suggestion as the server works it out now, at the volume posted.
      const basis = await readSuggestionBasis(db, userId);
      if (!basis) return done({ problem: "There is no suggestion yet. Type your own budget." }, "amount", 400);
      const { monthlyUsd } = suggest(basis, view.applicationsADay);
      await setBudget(db, userId, PROVIDER, monthlyUsd, "accepted", now);
      return done({ said: `Budget set: ${budgetText(monthlyUsd)} a month.` }, "next");
    }
    case "set": {
      const typed = field("amount").trim();
      const amount = parseBudget(typed);
      if (amount === undefined) return done({ problem: NOT_A_BUDGET, typed: typed.slice(0, 40) }, "amount", 400);
      await setBudget(db, userId, PROVIDER, amount, "typed", now);
      return done({ said: `Budget set: ${budgetText(amount)} a month.` }, "next");
    }
  }
  return done({ problem: "There is nothing to do here." }, "amount", 400);
}
