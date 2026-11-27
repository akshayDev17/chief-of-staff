// The model test on a provider's Connect screen (design-v3 1.5), the
// section the page opens at once the provider has authorized the app.
//
//   modelsSection(input) -> HTML        Test a model, its result, Refresh model list, Test all models
//
// One dropdown lists every model the provider lists (models/add.ts
// listOffer; the owner, 2026-11-27: "i would like to list all models and then
// choose"). It reads "Choose a model" until one is chosen. Choosing sends
// nothing and loads nothing (the owner, 2026-11-27: "upon changing a model in
// the dropdwon, i believe some request is sent"): it only fills the form and
// turns the disabled Test button into "Test with <model>?". That button, a
// real <button>, is the one thing that sends a request: the model's test call
// runs once (models/add.ts addModel), and when it passes the model is the
// user's for tasks. Each entry shows its input and output list price per
// million tokens, a Free label on a free model (prices/openrouter.ts
// isTrulyFreeTextModel) and its strength as a coloured label worked out from
// the input price (prices/tiers.ts): Smallest, Middle, Strongest. A native
// <select> cannot colour its entries, so the dropdown is the ARIA
// "select-only combobox" pattern: a button that opens a listbox of options,
// driven by the keyboard (arrows, Home, End, type-ahead, Enter or Space to
// choose, Escape to close) and by touch, with a plain <select> and its own
// Test button for a browser without scripts. A model the app cannot call,
// one the user's own account leaves out, or one with no price yet is listed
// but cannot be chosen, and says why.
//
// Test all models (models/test-all.ts) runs every model's test call: it shows
// the estimate first and runs only once confirmed, then shows each model's
// result, works now or not, with the plain reason, and the real total. It
// adds nothing: each model that works has an Add button, which adds it with
// that passed test call (models/test-all.ts addTestedModel).
//
// The visible copy is the action lines (the owner, 2026-11-27: the guide
// was far too long); every explanation sits in a collapsed "details".

import { esc, nbDate } from "../prices/page";
import { SOURCES } from "../prices/sources";
import type { Tier } from "../prices/tiers";
import { PROVIDERS_PATH } from "../paths";
import { blockedReason, refusalFix, refusalText, type AddOutcome, type OfferRow, type TestResult } from "../models/add";
import { CONCURRENCY, RUN_GAP_MINUTES, type TestAllPlan, type TestAllRun } from "../models/test-all";
import { TEST_MAX_TOKENS } from "./openrouter";
import type { Link, ProviderPlugin } from "../proxy/plugin";

export type TestsFilter = "all" | "works" | "fails";

// The section's anchor: back from the consent page the user lands here.
export const TEST_ANCHOR = "test";

export interface ModelsSectionInput {
  plugin: ProviderPlugin;
  viewer: "owner" | "friend";
  rows: OfferRow[];
  outcome?: AddOutcome;
  // When the provider's public list was read, and the user's account's.
  catalogReadAt?: string;
  accountReadAt?: string;
  plan: TestAllPlan;
  run?: TestAllRun;
  confirmTestAll: boolean;
  testsFilter: TestsFilter;
  formatCost: (usd: number) => string;
  now: Date;
}

const action = (provider: string, verb: string): string => `${PROVIDERS_PATH}/${provider}/${verb}`;
const hhmm = (iso: string): string => `${iso.slice(11, 16)} UTC`;
const slug = (model: string): string => model.replace(/[^A-Za-z0-9]+/g, "-");
const readOn = (iso: string): string => `${hhmm(iso)} on ${nbDate(iso.slice(0, 10))}`;

// Exact to the vendor's precision, at least two decimals: $0.125, $2.00.
export const usd = (n: number): string => {
  const [whole, frac = ""] = String(Number(n.toPrecision(12))).split(".");
  return `$${whole}.${frac.padEnd(2, "0")}`;
};

const tierClass: Record<Tier, string> = { Smallest: "tier-s", Middle: "tier-m", Strongest: "tier-l" };

const tokens = (u: TestResult["usage"]): string => {
  if (!u) return "";
  const input = u.input + u.cachedInput + u.cacheWrite + u.cacheWrite1h;
  return `${input} input and ${u.output} output tokens`;
};

const more = (summary: string, body: string): string => (body.trim() ? `<details class="more"><summary>${esc(summary)}</summary>${body}</details>` : "");

function entryNotes(row: OfferRow): string[] {
  const notes: string[] = [];
  if (row.added) notes.push(`added${row.added.test ? `, test passed ${row.added.test.at.slice(0, 10)}` : ""}`);
  if (row.noToolUse) notes.push(`no tool use (${row.noToolUse}); for tasks that need no tools`);
  if (row.price?.stale) notes.push("last good price: its source failed at the latest refresh");
  return [...notes, ...row.notes];
}

function option(row: OfferRow, input: ModelsSectionInput): string {
  const { plugin } = input;
  const why = blockedReason(row, plugin);
  const p = row.price;
  const price = p
    ? `<span class="lb-price">${usd(p.input)} in · ${usd(p.output)} out per million tokens</span><span class="lb-src small muted" title="${esc(SOURCES[p.source].label)}">${esc(SOURCES[p.source].label)}, read ${nbDate(p.dateRead)}</span>`
    : `<span class="lb-price"><span class="pill warn">no price yet</span></span>`;
  const tier = row.tier ? `<span class="tier ${tierClass[row.tier]}">${row.tier}</span>` : "";
  const free = row.free ? `<span class="pill free">Free</span>` : "";
  // With no price, the price line already says "no price yet".
  const whyNote = why && !p ? why.replace(/^no price yet: /, "") : why;
  const notes = [...entryNotes(row), ...(whyNote ? [whyNote] : [])];
  const noteHtml = notes.length ? `<span class="lb-notes small">${notes.map((n) => esc(n)).join(" · ")}</span>` : "";
  const name = row.name ? ` <span class="small muted">${esc(row.name)}</span>` : "";
  return `<li role="option" id="opt-${plugin.provider}-${esc(slug(row.model))}" data-model="${esc(row.model)}" aria-selected="false"${why ? ' aria-disabled="true"' : ""}${row.added ? ' class="added"' : ""}>
<span class="lb-head"><span class="lb-name">${esc(row.model)}</span>${name}${free}${tier}${row.added ? '<span class="pill ok">added</span>' : ""}</span>
${price}${noteHtml}</li>`;
}

function replyLine(plugin: ProviderPlugin, status: number, parts: Array<string | undefined>): string {
  const shown = [status === 200 ? "200 OK" : String(status), ...parts].filter(Boolean).map((p) => esc(p!));
  return `<p class="tc-reply">${esc(plugin.connect.guide.short)} replied: ${shown.join(" · ")}</p>`;
}

const linkButton = (l: Link, cls = "btn small secondary"): string => `<a class="${cls}" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`;
const linkButtons = (links: Link[] | undefined): string => (links ?? []).map((l) => linkButton(l)).join("");

// One plain line and the one action; the provider's reply, the fix and the
// other pages are collapsed.
function outcomeBox(input: ModelsSectionInput): string {
  const { plugin } = input;
  const o = input.outcome;
  if (!o) return "";
  if (o.kind === "added") {
    const t = o.model.test!;
    const named = t.repliedModel ? `reply names ${t.repliedModel}` : undefined;
    const spent = [tokens(t.usage), input.formatCost(t.costUsd)].filter(Boolean).join(" · ");
    return `<div class="tc tc-ok" role="status"><p class="tc-verdict"><strong>${esc(o.model.model)} passed.</strong> It's yours for tasks now.</p>
${more("Details", `${replyLine(plugin, t.status, [o.model.model, named, t.text ? `“${t.text}”` : undefined])}<p class="tc-fix small">${esc(spent)}</p>`)}</div>`;
  }
  const r = o.reply;
  const reply = r
    ? replyLine(plugin, r.status, r.repliedModel ? [`model ${r.repliedModel}`] : [r.errorName, r.message ? `“${r.message}”` : undefined])
    : o.note
      ? `<p class="tc-reply">${esc(o.note)}</p>`
      : "";
  const [first, ...rest] = o.links ?? [];
  const help =
    input.viewer === "friend"
      ? `<form method="post" action="${action(plugin.provider, "model-help")}"><input type="hidden" name="model" value="${esc(o.model)}"><input type="hidden" name="reason" value="${esc(o.reason)}"><button type="submit" class="btn small help-btn">Ask Admin for help</button></form>`
      : "";
  const fix = refusalFix(o, plugin);
  const main = first ? linkButton(first, "btn small") : "";
  return `<div class="tc tc-bad" role="alert"><p class="tc-verdict"><strong>${esc(refusalText(o, plugin))}</strong> <span class="small">${esc(o.model)}</span></p>
${main || help ? `<div class="row">${main}${help}</div>` : ""}
${more("Details", `${reply}${fix ? `<p class="tc-fix small">${esc(fix)}</p>` : ""}${rest.length ? `<div class="row">${linkButtons(rest)}</div>` : ""}`)}</div>`;
}

function refreshLine(input: ModelsSectionInput): string {
  const short = input.plugin.connect.guide.short;
  const read = input.catalogReadAt ? `List read ${readOn(input.catalogReadAt)}.` : "List not read yet.";
  return `<form class="row" method="post" action="${action(input.plugin.provider, "refresh")}" style="margin:8px 0 0">
<button type="submit" class="btn small refresh">Refresh model list</button><span class="small muted">${read}</span>
</form>`
    + more(
      "About this list",
      `<ul class="small about">
<li>Every model ${esc(short)} lists is here.</li>
<li>Your account's own list marks the ones it leaves out${input.accountReadAt ? ` (read ${readOn(input.accountReadAt)})` : ""}.</li>
<li>A model is added only when its test call passes.</li>
<li>A model with no price yet cannot be chosen.</li>
<li>Strength comes from the input price per million tokens: <span class="tier tier-s">Smallest</span> under $0.50, <span class="tier tier-m">Middle</span> to $2.50, <span class="tier tier-l">Strongest</span> above.</li>
<li><span class="pill free">Free</span>: gives only text and costs $0 on every price ${esc(short)} lists.</li>
${freeTerms(input)}
</ul>`,
    );
}

function freeTerms(input: ModelsSectionInput): string {
  const terms = input.plugin.connect.freeModelTerms;
  if (!terms || !input.rows.some((r) => r.free)) return "";
  const links = terms.links.map((l) => `<a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`).join(" · ");
  return `<li class="free-terms">Free models work without credit. ${esc(terms.text)} ${links}</li>`;
}

function testAllSection(input: ModelsSectionInput): string {
  const { plugin, plan, run } = input;
  const p = plugin.provider;
  const name = plugin.connect.guide.name;
  const count = plan.models.length;
  const head = `<h4 id="${p}-test-all">Test all models</h4>`;
  let body: string;
  if (run && !run.finishedAt) {
    body = `<div class="tc tc-sw" role="status"><p class="tc-verdict"><strong>Testing… ${run.done} of ${run.modelCount} done.</strong></p>
<p class="tc-fix small">You can leave and come back. This page updates by itself.</p>
${more("How it runs", `<p class="small">${CONCURRENCY} models at a time, a few dozen a minute.</p>`)}</div>`;
  } else if (input.confirmTestAll && !plan.wait) {
    body = `<div class="tc tc-sw" role="alertdialog" aria-labelledby="${p}-confirm-h"><p class="tc-verdict" id="${p}-confirm-h"><strong>Test all ${count} models for about ${esc(input.formatCost(plan.estimateUsd))}?</strong></p>
<p class="small">Billed to your ${esc(name)} account. Nothing is added.</p>
<div class="row"><form method="post" action="${action(p, "test-all")}"><button type="submit" class="btn small">Run the test</button></form><a class="btn small ghost" href="${PROVIDERS_PATH}?provider=${p}#${p}-test-all">Cancel</a></div>
${more("How the estimate is worked out", `<p class="small">Each test call sends a few words and allows at most ${TEST_MAX_TOKENS} reply tokens, at ${esc(name)}'s prices for those tokens plus any fee per call. Add any model that works from the results.</p>`)}</div>`;
  } else {
    const wait = plan.wait ? `<span class="small muted">${esc(plan.wait)}</span>` : `<span class="small muted">${count} models · about ${esc(input.formatCost(plan.estimateUsd))}</span>`;
    const button = plan.wait
      ? `<button type="button" class="btn small secondary" disabled>Test all models</button>`
      : `<a class="btn small secondary" href="${PROVIDERS_PATH}?provider=${p}&test-all=confirm#${p}-test-all">Test all models</a>`;
    body = `<div class="row">${button}${wait}</div>${plan.wait ? "" : more("About Test all models", `<p class="small">It shows which models work for your account now. It asks before it runs, and runs at most once every ${RUN_GAP_MINUTES} minutes.</p>`)}`;
  }
  return `<section class="test-all" aria-labelledby="${p}-test-all">${head}${body}${run ? resultsList(input, run) : ""}</section>`;
}

function addButton(input: ModelsSectionInput, model: string): string {
  if (input.rows.some((r) => r.model === model && r.added)) return ` <span class="pill ok">added</span>`;
  return ` <form class="inline" method="post" action="${action(input.plugin.provider, "add-tested")}#${TEST_ANCHOR}"><input type="hidden" name="model" value="${esc(model)}"><button type="submit" class="btn small">Add</button></form>`;
}

function resultsList(input: ModelsSectionInput, run: TestAllRun): string {
  const p = input.plugin.provider;
  const done = run.tests.filter((t) => t.state === "passed" || t.state === "failed");
  if (!done.length) return "";
  const works = done.filter((t) => t.state === "passed").length;
  const shown = done.filter((t) => input.testsFilter === "all" || (input.testsFilter === "works" ? t.state === "passed" : t.state === "failed"));
  const filter = (f: TestsFilter, label: string) =>
    input.testsFilter === f ? `<strong aria-current="true">${label}</strong>` : `<a href="${PROVIDERS_PATH}?provider=${p}&tests=${f}#${p}-test-all">${label}</a>`;
  const items = shown
    .map((t) => {
      const ok = t.state === "passed";
      if (ok) return `<li><span class="lb-name">${esc(t.model)}</span> <span class="pill ok">works now</span>${addButton(input, t.model)}</li>`;
      const reply = t.result?.reply ? `<span class="tc-reply">${esc([t.result.reply.status, t.result.reply.errorName, t.result.reply.message ? `“${t.result.reply.message}”` : ""].filter(Boolean).join(" · "))}</span>` : "";
      const fix = t.result?.fix ? `<span class="small tc-fix">${esc(t.result.fix)}</span>` : "";
      const links = t.result?.links?.length ? `<span class="row">${linkButtons(t.result.links)}</span>` : "";
      const pill = t.result?.reason === "no_credits" ? "needs credit" : "doesn't work now";
      return `<li><span class="lb-name">${esc(t.model)}</span> <span class="pill warn">${pill}</span> <span class="small">${esc(t.result?.text ?? "")}</span>${more("Details", `${reply}${fix}${links}`)}</li>`;
    })
    .join("");
  const when = run.finishedAt ? `Tested ${readOn(run.startedAt)}` : `Started ${readOn(run.startedAt)}`;
  return `<p class="small" style="margin-top:8px">${when}: ${works} of ${done.length} work now. Cost ${esc(input.formatCost(run.realCostUsd))} (estimated ${esc(input.formatCost(run.estimateUsd))}).</p>
<p class="small">Show: ${filter("all", "All")} · ${filter("works", "Works now")} · ${filter("fails", "Doesn't work")}</p>
<ul class="results small">${items || "<li>None.</li>"}</ul>`;
}

export function modelsSection(input: ModelsSectionInput): string {
  const { plugin } = input;
  const p = plugin.provider;
  const list = `${p}-models`;
  const head = `<h3 id="${p}-models-h">Test a model</h3>
<p class="small">Choose a model, then test it. A passed model is yours for tasks.</p>`;
  if (!input.rows.length) {
    return `<section class="models" id="${TEST_ANCHOR}" tabindex="-1" aria-labelledby="${p}-models-h">${head}
<p class="small muted">No model is listed yet: Refresh model list reads the list now.</p>${refreshLine(input)}</section>`;
  }
  const choosable = input.rows.filter((r) => !blockedReason(r, plugin));
  const label = (r: OfferRow) => `${r.model}${r.free ? " · Free" : r.price ? ` · ${usd(r.price.input)} in · ${usd(r.price.output)} out` : ""}${r.tier ? ` · ${r.tier}` : ""}`;
  const fallback = `<noscript><div class="row"><select class="f" name="model" aria-label="Model"><option value="">Choose a model</option>${choosable.map((r) => `<option value="${esc(r.model)}">${esc(label(r))}</option>`).join("")}</select><button type="submit" class="btn">Test</button></div></noscript>`;
  return `<section class="models" id="${TEST_ANCHOR}" tabindex="-1" aria-labelledby="${p}-models-h">
${head}
${outcomeBox(input)}
<form method="post" action="${action(p, "choose")}#${TEST_ANCHOR}" class="choose" data-listbox>
<input type="hidden" data-model-input value="">
<span class="small" id="${list}-label"><strong>Model</strong> <span class="muted">(${input.rows.length} listed, ${choosable.length} can be chosen)</span></span>
<div class="lb-wrap">
<button type="button" class="lb-btn" id="${list}-button" aria-haspopup="listbox" aria-expanded="false" aria-controls="${list}" aria-labelledby="${list}-label ${list}-button" hidden>Choose a model</button>
<ul role="listbox" id="${list}" class="lb" aria-labelledby="${list}-label" tabindex="-1" hidden>
${input.rows.map((r) => option(r, input)).join("\n")}
</ul>
</div>
<div class="row test-row"><button type="submit" class="btn" data-test-button disabled hidden>Test</button></div>
${fallback}
</form>
${refreshLine(input)}
${testAllSection(input)}
</section>`;
}

export const MODELS_CSS = `
.models { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 10px; scroll-margin-top: 12px; border-radius: 10px; }
.models:target, .models.arrived { animation: arrive 2.4s ease-out 1; outline: 2px solid var(--accent); outline-offset: 6px; }
@keyframes arrive { 0% { background: var(--accent-soft); } 100% { background: transparent; } }
.models:focus { outline: 2px solid var(--accent); outline-offset: 6px; }
.models h3 { margin: 0 0 4px; font-size: 1rem; }
.tier { display: inline-block; font-size: .72rem; font-weight: 600; line-height: 1.4; padding: 0 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.tier-s { color: var(--tier-s); background: var(--tier-s-soft); }
.tier-m { color: var(--tier-m); background: var(--tier-m-soft); }
.tier-l { color: var(--tier-l); background: var(--tier-l-soft); }
.pill.free { background: var(--ok-soft); color: var(--ok); font-weight: 600; }
.lb-wrap { position: relative; max-width: 40em; margin-top: 4px; }
.lb-btn { width: 100%; text-align: left; font: inherit; padding: 8px 34px 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--text); cursor: pointer; min-height: 40px; position: relative; overflow-wrap: anywhere; }
.lb-btn::after { content: "▾"; position: absolute; right: 12px; top: 50%; transform: translateY(-50%); color: var(--muted); }
.lb-btn:focus-visible, .lb:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.lb { list-style: none; margin: 4px 0 0; padding: 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); max-height: min(60vh, 26em); overflow-y: auto; position: absolute; left: 0; right: 0; z-index: 20; box-shadow: 0 6px 18px rgba(0, 0, 0, .18); }
.lb [role="option"] { display: grid; gap: 2px; padding: 7px 9px; border-radius: 6px; cursor: pointer; border: 2px solid transparent; }
.lb [role="option"] + [role="option"] { margin-top: 2px; }
.lb [role="option"].active { border-color: var(--accent); background: var(--accent-soft); }
.lb [role="option"][aria-disabled="true"] { cursor: not-allowed; opacity: .62; }
.lb-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.lb-name { font-weight: 600; overflow-wrap: anywhere; }
.lb-price { font-size: .85rem; font-variant-numeric: tabular-nums; }
.lb-src, .lb-notes { color: var(--muted); overflow-wrap: anywhere; }
.test-row { margin-top: 8px; }
.test-row .btn { overflow-wrap: anywhere; text-align: left; }
ul.about { margin: 0; padding-left: 18px; }
ul.about li + li { margin-top: 2px; }
.test-all { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 10px; }
.test-all h4 { margin: 0 0 4px; font-size: .95rem; }
.results { list-style: none; padding: 0; margin: 6px 0 0; max-height: 26em; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; }
.results li { padding: 5px 9px; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.results li:first-child { border-top: 0; }
.results form.inline { display: inline; }
.results details.more { margin-top: 2px; }
@media (max-width: 759px) { .lb-wrap { max-width: none; } .lb { position: static; box-shadow: none; } }
@media (prefers-reduced-motion: reduce) { .models:target, .models.arrived { animation: none; } }
`;

// Light and dark tier colours, each tested at 4.5:1 or more on its soft fill.
export const TIER_VARS = `
:root { --tier-s: #1f6b3a; --tier-s-soft: #e3f3e8; --tier-m: #8a5300; --tier-m-soft: #fbefd9; --tier-l: #6a2c91; --tier-l-soft: #f1e6f8; }
@media (prefers-color-scheme: dark) { :root { --tier-s: #8fd8a8; --tier-s-soft: #17301f; --tier-m: #f2c27a; --tier-m-soft: #352812; --tier-l: #d7b1f0; --tier-l-soft: #2c1d38; } }
`;

// The listbox's behaviour. Without it the <noscript> select is the list.
// Choosing only fills the form: the Test button sends it. Arriving at
// #test (back from the consent page, or after a test) highlights the
// section and puts focus on the dropdown. While a Test all models run goes
// on, the page reloads every 20 seconds to show its progress, but never
// while a model is chosen or the list is open.
export const MODELS_JS = `
document.querySelectorAll("button[data-enable-at]").forEach(function (b) {
  setTimeout(function () { b.disabled = false; }, Number(b.getAttribute("data-enable-at")) - Date.now());
});
document.querySelectorAll("form[data-listbox]").forEach(function (form) {
  var button = form.querySelector(".lb-btn"), list = form.querySelector("[role=listbox]"), input = form.querySelector("[data-model-input]"), test = form.querySelector("[data-test-button]");
  if (!button || !list || !input || !test) return;
  var options = Array.prototype.slice.call(list.querySelectorAll("[role=option]"));
  var active = -1, typed = "", typedAt = 0;
  button.hidden = false;
  test.hidden = false;
  input.name = "model";
  function open(at) {
    list.hidden = false; button.setAttribute("aria-expanded", "true"); list.focus();
    move(at >= 0 ? at : 0);
  }
  function close(focusButton) {
    list.hidden = true; button.setAttribute("aria-expanded", "false"); list.removeAttribute("aria-activedescendant");
    if (focusButton) button.focus();
  }
  function move(i) {
    if (!options.length) return;
    i = Math.max(0, Math.min(options.length - 1, i));
    if (active >= 0) options[active].classList.remove("active");
    active = i;
    var o = options[i];
    o.classList.add("active");
    list.setAttribute("aria-activedescendant", o.id);
    o.scrollIntoView({ block: "nearest" });
  }
  function choose(i) {
    var o = options[i];
    if (!o || o.getAttribute("aria-disabled") === "true") return;
    options.forEach(function (x) { x.setAttribute("aria-selected", "false"); });
    o.setAttribute("aria-selected", "true");
    input.value = o.getAttribute("data-model");
    button.textContent = input.value;
    test.textContent = "Test with " + input.value + "?";
    test.disabled = false;
    close(false);
    test.focus();
  }
  button.addEventListener("click", function () { list.hidden ? open(active) : close(true); });
  button.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e.key === "ArrowUp" ? options.length - 1 : active); }
  });
  list.addEventListener("keydown", function (e) {
    var page = 8, now = Date.now(), searching = typed !== "" && now - typedAt <= 700;
    if (e.key === "ArrowDown") { e.preventDefault(); move(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(active - 1); }
    else if (e.key === "Home") { e.preventDefault(); move(0); }
    else if (e.key === "End") { e.preventDefault(); move(options.length - 1); }
    else if (e.key === "PageDown") { e.preventDefault(); move(active + page); }
    else if (e.key === "PageUp") { e.preventDefault(); move(active - page); }
    else if (e.key === "Enter" || (e.key === " " && !searching)) { e.preventDefault(); choose(active); }
    else if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "Tab") { close(false); }
    else if (e.key.length === 1) {
      if (e.key === " ") e.preventDefault();
      typed = searching ? typed + e.key.toLowerCase() : e.key.toLowerCase();
      typedAt = now;
      for (var k = 0; k < options.length; k++) {
        if (options[k].getAttribute("data-model").toLowerCase().indexOf(typed) === 0) { move(k); break; }
      }
    }
  });
  options.forEach(function (o, i) {
    o.addEventListener("click", function () { move(i); choose(i); });
  });
  form.addEventListener("submit", function (e) {
    if (!input.value) { e.preventDefault(); open(active); return; }
    test.disabled = true;
    test.textContent = "Testing " + input.value + "…";
  });
  document.addEventListener("click", function (e) { if (!list.hidden && !form.contains(e.target)) close(false); });
  if (location.hash === "#${TEST_ANCHOR}") {
    var section = document.getElementById("${TEST_ANCHOR}");
    if (section) section.classList.add("arrived");
    button.focus({ preventScroll: true });
  }
});
document.querySelectorAll("[data-reload-every]").forEach(function (el) {
  var seconds = Number(el.getAttribute("data-reload-every"));
  function tick() {
    var busy = Array.prototype.some.call(document.querySelectorAll("[data-model-input]"), function (i) { return i.value; })
      || document.querySelector("[role=listbox]:not([hidden])");
    if (busy) { setTimeout(tick, seconds * 1000); return; }
    location.reload();
  }
  setTimeout(tick, seconds * 1000);
});
`;
