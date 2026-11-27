// The model list on a provider's Connect screen (design-v3 1.5), shown
// below a passed Connect, in place of the separate Add a model page.
//
//   modelsSection(input) -> HTML        the list, its result, Bedrock's Refresh
//
// One dropdown lists every chat model the provider sells at a listed price
// (models/add.ts listOffer). Each entry shows its input and output list
// price per million tokens, where the app calls it, and its strength as a
// coloured label worked out from the input price (prices/tiers.ts):
// Smallest, Middle, Strongest. A native <select> cannot colour its entries,
// so the dropdown is the ARIA "select-only combobox" pattern: a button that
// opens a listbox of options, driven by the keyboard (arrows, Home, End,
// type-ahead, Enter or Space to choose, Escape to close) and by touch, with
// a plain <select> for a browser without scripts. Choosing a model runs its
// test call once, right there (models/add.ts addModel): it passes and the
// model is the user's for tasks, or the plain reason shows under the list.
// Nothing is tested up front, so no Marketplace product is subscribed to
// that the user did not choose. A model with no price yet, or one the app
// cannot call, is listed but cannot be chosen. Friend screens say "Admin"
// for the owner and never "deployment name" (design-v3 1.6).

import { esc, nbDate } from "../prices/page";
import { SOURCES } from "../prices/sources";
import type { Tier } from "../prices/tiers";
import { PROVIDERS_PATH } from "../paths";
import { refusalFix, refusalText, type AddOutcome, type OfferRow, type TestResult } from "../models/add";
import type { ProviderPlugin } from "../proxy/plugin";
import { accessNotes, type AccountCheck } from "./bedrock-account";

export interface ModelsSectionInput {
  plugin: ProviderPlugin;
  viewer: "owner" | "friend";
  rows: OfferRow[];
  outcome?: AddOutcome;
  // Bedrock only: the last Refresh model list, and when the model list was read.
  accountCheck?: AccountCheck;
  catalogReadAt?: string;
  formatCost: (usd: number) => string;
}

const action = (provider: string, verb: string): string => `${PROVIDERS_PATH}/${provider}/${verb}`;
const hhmm = (iso: string): string => `${iso.slice(11, 16)} UTC`;
const slug = (model: string): string => model.replace(/[^A-Za-z0-9]+/g, "-");

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

// Why an entry cannot be chosen, or undefined when it can.
function blocked(row: OfferRow, plugin: ProviderPlugin): string | undefined {
  if (!row.price) {
    return plugin.provider === "foundry" && /^claude\b/i.test(row.model)
      ? "no price yet: waiting for the maintainers' reading of its listing"
      : `no price yet: not in ${SOURCES[plugin.priceSource[0]!].label.split(",")[0]!} yet`;
  }
  if (!row.callable) return `not offered yet: ${plugin.connect.notCallableReason(row.model)}`;
  return undefined;
}

function entryNotes(row: OfferRow, input: ModelsSectionInput): string[] {
  const notes: string[] = [];
  if (row.added) notes.push(`added${row.added.test ? `, test passed ${row.added.test.at.slice(0, 10)}` : ""}`);
  // Foundry calls the model by the deployment name: the user's own once
  // added, else the suggested one, the model's ID.
  if (row.deployment !== undefined && row.callable) {
    const label = input.viewer === "friend" ? "Foundry's name" : "deployment name";
    notes.push(row.added?.deployment ? `${label} ${row.added.deployment}` : `suggested ${label} ${row.deployment}`);
  }
  if (row.noToolUse) notes.push(`no tool use (${row.noToolUse}); for tasks that need no tools`);
  if (row.price?.stale) notes.push("last good price: its source failed at the latest refresh");
  return [...notes, ...accessNotes(row.model, input.accountCheck)];
}

function option(row: OfferRow, input: ModelsSectionInput): string {
  const { plugin } = input;
  const why = blocked(row, plugin);
  const p = row.price;
  const where = p ? ` · ${esc(plugin.connect.locationLabel(row.location, row.model))}, chosen by ${row.locationSetBy === "user" ? "you" : "the app"}` : "";
  const price = p
    ? `<span class="lb-price">${usd(p.input)} in · ${usd(p.output)} out per million tokens${where}</span><span class="lb-src small muted" title="${esc(SOURCES[p.source].label)}">${esc(SOURCES[p.source].label.split(",")[0]!)}, read ${nbDate(p.dateRead)}</span>`
    : `<span class="lb-price"><span class="pill warn">no price yet</span></span>`;
  const tier = row.tier ? `<span class="tier ${tierClass[row.tier]}">${row.tier}</span>` : "";
  // With no price, the price line already says "no price yet".
  const whyNote = why && !p ? why.replace(/^no price yet: /, "") : why;
  const notes = [...entryNotes(row, input), ...(whyNote ? [whyNote] : [])];
  const noteHtml = notes.length ? `<span class="lb-notes small">${notes.map((n) => esc(n)).join(" · ")}</span>` : "";
  return `<li role="option" id="opt-${plugin.provider}-${esc(slug(row.model))}" data-model="${esc(row.model)}" aria-selected="false"${why ? ' aria-disabled="true"' : ""}${row.added ? ' class="added"' : ""}>
<span class="lb-head"><span class="lb-name">${esc(row.model)}</span>${tier}${row.added ? '<span class="pill ok">added</span>' : ""}</span>
${price}${noteHtml}</li>`;
}

function replyLine(plugin: ProviderPlugin, status: number, parts: Array<string | undefined>): string {
  const shown = [status === 200 ? "200 OK" : String(status), ...parts].filter(Boolean).map((p) => esc(p!));
  return `<p class="tc-reply">${esc(plugin.connect.guide.short)} replied: ${shown.join(" · ")}</p>`;
}

function outcomeBox(input: ModelsSectionInput): string {
  const { plugin } = input;
  const o = input.outcome;
  if (!o) return "";
  if (o.kind === "added") {
    const t = o.model.test!;
    const named = t.repliedModel ? `reply names ${t.repliedModel}` : undefined;
    const spent = [tokens(t.usage), input.formatCost(t.costUsd)].filter(Boolean).join(" · ");
    return `<div class="tc tc-ok" role="status"><p class="tc-verdict"><strong>${esc(o.model.model)} added.</strong> Its test call ran once and passed.</p>
${replyLine(plugin, t.status, [`${t.modelId} (${plugin.connect.locationLabel(t.location, o.model.model)})`, named, t.text ? `“${t.text}”` : undefined])}
<p class="tc-fix small">${esc(spent)}. It is now one of your models for each task.</p></div>`;
  }
  const r = o.reply;
  const reply = r
    ? replyLine(plugin, r.status, r.repliedModel ? [`model ${r.repliedModel}`] : [r.errorName, r.message ? `“${r.message}”` : undefined])
    : o.note
      ? `<p class="tc-reply">${esc(o.note)}</p>`
      : "";
  const links = (o.links ?? [])
    .map((l) => `<a class="btn small secondary" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`)
    .join("");
  const help =
    input.viewer === "friend"
      ? `<form method="post" action="${action(plugin.provider, "model-help")}"><input type="hidden" name="model" value="${esc(o.model)}"><input type="hidden" name="reason" value="${esc(o.reason)}"><button type="submit" class="btn small help-btn">Ask Admin for help</button></form>`
      : "";
  const fix = refusalFix(o, plugin);
  return `<div class="tc tc-bad" role="alert"><p class="tc-verdict"><strong>${esc(refusalText(o, plugin, input.viewer))}</strong></p>
${reply}
${fix ? `<p class="tc-fix small">${esc(fix)}</p>` : ""}
${links || help ? `<div class="row">${links}${help}</div>` : ""}</div>`;
}

function refreshLine(input: ModelsSectionInput): string {
  if (input.plugin.provider !== "bedrock") return "";
  const c = input.accountCheck;
  const read = input.catalogReadAt ? `Bedrock's model list read ${hhmm(input.catalogReadAt)} on ${nbDate(input.catalogReadAt.slice(0, 10))}` : "Bedrock's model list not read yet";
  const checked = c ? ` · your AWS account checked ${hhmm(c.checkedAt)}` : "";
  const notes = [c?.catalogError, c?.note].filter(Boolean).map((n) => `<p class="small muted">${esc(n!)}</p>`).join("");
  return `<form class="row" method="post" action="${action("bedrock", "refresh")}" style="margin:6px 0">
<button type="submit" class="btn small ghost">Refresh model list</button><span class="small muted">${read}${checked}. Refresh reads the list again now and checks, in your own AWS account, each Marketplace model's terms and Anthropic's form.</span>
</form>${notes}`;
}

export function modelsSection(input: ModelsSectionInput): string {
  const { plugin, viewer } = input;
  const p = plugin.provider;
  const name = plugin.connect.guide.name;
  const list = `${p}-models`;
  const intro = `<p class="small">Every chat model ${esc(name)} sells at a listed price, of every model family. Choose one and its test call runs once, right here; when it passes, the model is yours for each task. Strength comes from the input price: <span class="tier tier-s">Smallest</span> under $0.50 per million tokens, <span class="tier tier-m">Middle</span> $0.50 to under $2.50, <span class="tier tier-l">Strongest</span> $2.50 and up.</p>`;
  if (!input.rows.length) {
    return `<section class="models" aria-labelledby="${p}-models-h"><h3 id="${p}-models-h">Your models at ${esc(name)}</h3>${intro}${refreshLine(input)}
<p class="small muted">The price table lists no chat model at ${esc(name)} yet.</p></section>`;
  }
  const deployment = plugin.connect.deploymentName
    ? `<label class="small" for="${p}-deployment">${esc(viewer === "friend" ? "Foundry's name for the model" : "Deployment name")} <span class="muted">(leave empty for the suggested name, the model's ID)</span></label>
<input class="f mono" id="${p}-deployment" name="deployment" value="" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}" autocomplete="off" spellcheck="false" style="max-width:24em">`
    : "";
  const choosable = input.rows.filter((r) => !blocked(r, plugin));
  const fallback = `<noscript><div class="row"><select class="f" name="model" aria-label="Model">${choosable.map((r) => `<option value="${esc(r.model)}">${esc(r.model)}${r.price ? ` · ${usd(r.price.input)} in · ${usd(r.price.output)} out` : ""}${r.tier ? ` · ${r.tier}` : ""}</option>`).join("")}</select><button type="submit" class="btn small">Choose and test</button></div></noscript>`;
  return `<section class="models" aria-labelledby="${p}-models-h">
<h3 id="${p}-models-h">Your models at ${esc(name)}</h3>
${intro}
${refreshLine(input)}
${outcomeBox(input)}
<form method="post" action="${action(p, "choose")}" class="choose" data-listbox>
<input type="hidden" data-model-input value="">
${deployment}
<span class="small" id="${list}-label"><strong>Choose a model</strong></span>
<div class="lb-wrap">
<button type="button" class="lb-btn" id="${list}-button" aria-haspopup="listbox" aria-expanded="false" aria-controls="${list}" aria-labelledby="${list}-label ${list}-button" hidden>Choose a model to test</button>
<ul role="listbox" id="${list}" class="lb" aria-labelledby="${list}-label" tabindex="-1" hidden>
${input.rows.map((r) => option(r, input)).join("\n")}
</ul>
</div>
${fallback}
</form>
<p class="small muted" style="margin-top:6px">A model is added only when its test call passes; a reply naming a different model is refused with a plain reason. A model with no price yet cannot be chosen, because the budget stop needs a real price.</p>
</section>`;
}

export const MODELS_CSS = `
.models { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 10px; }
.models h3 { margin: 0 0 4px; font-size: 1rem; }
.tier { display: inline-block; font-size: .72rem; font-weight: 600; line-height: 1.4; padding: 0 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.tier-s { color: var(--tier-s); background: var(--tier-s-soft); }
.tier-m { color: var(--tier-m); background: var(--tier-m-soft); }
.tier-l { color: var(--tier-l); background: var(--tier-l-soft); }
.lb-wrap { position: relative; max-width: 40em; margin-top: 4px; }
.lb-btn { width: 100%; text-align: left; font: inherit; padding: 8px 34px 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--text); cursor: pointer; min-height: 40px; position: relative; }
.lb-btn::after { content: "▾"; position: absolute; right: 12px; top: 50%; transform: translateY(-50%); color: var(--muted); }
.lb-btn:focus-visible, .lb:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.lb { list-style: none; margin: 4px 0 0; padding: 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); max-height: min(60vh, 26em); overflow-y: auto; position: absolute; left: 0; right: 0; z-index: 20; box-shadow: 0 6px 18px rgba(0, 0, 0, .18); }
.lb [role="option"] { display: grid; gap: 2px; padding: 7px 9px; border-radius: 6px; cursor: pointer; border: 2px solid transparent; }
.lb [role="option"] + [role="option"] { margin-top: 2px; }
.lb [role="option"].active { border-color: var(--accent); background: var(--accent-soft); }
.lb [role="option"][aria-disabled="true"] { cursor: not-allowed; opacity: .62; }
.lb-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.lb-name { font-weight: 600; }
.lb-price { font-size: .85rem; font-variant-numeric: tabular-nums; }
.lb-src, .lb-notes { color: var(--muted); overflow-wrap: anywhere; }
@media (max-width: 759px) { .lb-wrap { max-width: none; } .lb { position: static; box-shadow: none; } }
`;

// Light and dark tier colours, each tested at 4.5:1 or more on its soft fill.
export const TIER_VARS = `
:root { --tier-s: #1f6b3a; --tier-s-soft: #e3f3e8; --tier-m: #8a5300; --tier-m-soft: #fbefd9; --tier-l: #6a2c91; --tier-l-soft: #f1e6f8; }
@media (prefers-color-scheme: dark) { :root { --tier-s: #8fd8a8; --tier-s-soft: #17301f; --tier-m: #f2c27a; --tier-m-soft: #352812; --tier-l: #d7b1f0; --tier-l-soft: #2c1d38; } }
`;

// The listbox's behaviour. Without it the <noscript> select is the list.
export const MODELS_JS = `
document.querySelectorAll("form[data-listbox]").forEach(function (form) {
  var button = form.querySelector(".lb-btn"), list = form.querySelector("[role=listbox]"), input = form.querySelector("[data-model-input]");
  if (!button || !list || !input) return;
  var options = Array.prototype.slice.call(list.querySelectorAll("[role=option]"));
  var active = -1, typed = "", typedAt = 0;
  button.hidden = false;
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
    button.textContent = "Testing " + input.value + "…";
    close(true);
    form.submit();
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
    if (!input.value) { e.preventDefault(); open(active); }
  });
  document.addEventListener("click", function (e) { if (!list.hidden && !form.contains(e.target)) close(false); });
});
`;
