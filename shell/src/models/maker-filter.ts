// The Maker filter, the one every model list with one shares: Models › Setup
// › Providers' model table (providers/page.ts) and Models › Usage's Per model
// box (models/usage-page.ts).
//
//   makerKey(id) -> string                       a model ID's maker part
//   nameMakers(models, own?) -> Map<key, name>   each maker's display name
//   makerRowAttrs(id, name) -> string             what a row carries for it
//   MAKER_FILTER_HTML, MAKER_CHIPS_HTML           its markup
//   MAKER_FILTER_CSS, MAKER_FILTER_JS             its look and its script
//
// A maker is the part of a model ID before its "/". Its display name is the
// one the provider's own model names give it ("Anthropic: Claude …" names
// "anthropic" Anthropic), the first such name in the list's order; a maker
// none of its models names keeps its ID part, but for the provider's own
// models, which carry the provider's name. The app holds no list of makers.
//
// The script: Maker opens the makers in the list, each with its number of
// rows, and a find box of its own (a maker's name or ID part). Makers are
// listed by name: two ID parts the provider names alike (OpenRouter names
// both meta/… and meta-llama/… "Meta") are one maker; each chosen maker shows as a chip under
// the toolbar, and removing it drops it from the filter. It narrows the rows
// together with the page's search: a row shows only when both let it. None of
// it sends a request, reloads the page or changes its address. Without
// scripts the filter stays hidden, and the list holds every row.

import { esc } from "../prices/page";

export const makerKey = (id: string): string => id.split("/")[0]!;

// `own`: the provider whose list it is, named as it names itself.
export function nameMakers(models: Array<{ id: string; name?: string }>, own?: { key: string; name: string }): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of models) {
    const key = makerKey(m.id);
    const named = m.name?.includes(": ") ? m.name.split(": ")[0]!.trim() : undefined;
    if (named && !names.has(key)) names.set(key, named);
  }
  for (const m of models) {
    const key = makerKey(m.id);
    if (!names.has(key)) names.set(key, key === own?.key ? own.name : key);
  }
  return names;
}

// `name`: the maker's display name, from nameMakers.
export const makerRowAttrs = (id: string, name: string): string => ` data-maker="${esc(makerKey(id))}" data-maker-name="${esc(name)}"`;

const CHEVRON = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>';

// The button and its list, for the page's toolbar; the script fills the list.
// `data-k="maker"` keeps focus on it across a page's swaps.
export const MAKER_FILTER_HTML = `<div class="maker" data-maker-filter><button type="button" class="maker-btn" aria-haspopup="true" aria-expanded="false" data-maker-toggle data-k="maker">Maker <span class="n"></span>${CHEVRON}</button><div class="pop" role="dialog" aria-label="Filter by maker"><input type="search" name="maker-find" placeholder="Find a maker" aria-label="Find a maker" data-maker-find autocomplete="off"><ul data-maker-list></ul><div class="pop-foot"><button type="button" class="mf-link" data-maker-clear>Clear</button><button type="button" class="mf-done" data-maker-done>Done</button></div></div></div>`;

// Where the chosen makers show, under the toolbar.
export const MAKER_CHIPS_HTML = `<div class="chips" data-maker-chips></div>`;

// On the page's own tokens: --surface, --raised, --active, --chip-hover,
// --border, --rule, --control, --control-hover, --text, --muted, --accent,
// --shadow, --radius-control, --radius-card, --control-h, --fs-small, --t.
export const MAKER_FILTER_CSS = `
.maker { position: relative; }
.maker button, .maker input, .chips button { font: inherit; }
.maker-btn, .mf-done { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: var(--control-h); padding: 0 14px; border-radius: var(--radius-control); border: 1px solid var(--control); background: var(--surface); color: var(--text); font-size: 14px; line-height: 1.2; white-space: nowrap; cursor: pointer; transition: border-color var(--t), transform 120ms; }
.maker-btn:hover, .mf-done:hover { border-color: var(--control-hover); }
.maker-btn:active, .mf-done:active { transform: translateY(1px); }
.mf-done { min-height: 32px; padding: 0 12px; font-size: 13px; }
.mf-link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; text-underline-offset: 2px; font-size: inherit; cursor: pointer; }
.maker-btn:focus-visible, .mf-done:focus-visible, .mf-link:focus-visible, .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.maker-btn .n { font-family: var(--figures, inherit); font-variant-numeric: tabular-nums; background: var(--text); color: var(--surface); border-radius: 999px; min-width: 20px; height: 20px; padding: 0 6px; font-size: 12px; display: none; align-items: center; justify-content: center; }
.maker-btn.on .n { display: inline-flex; }
.maker-btn svg { width: 12px; height: 12px; color: var(--muted); }
.pop { position: absolute; z-index: 30; top: calc(100% + 6px); left: 0; width: 300px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card); box-shadow: 0 10px 28px var(--shadow); padding: 10px; display: none; } /* taste-skill-ignore: a menu that floats */
.maker.open .pop { display: block; }
.pop input[type="search"] { width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--control); border-radius: var(--radius-control); font-size: 14px; background: var(--surface); color: var(--text); }
.pop input[type="search"]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); } /* taste-skill-ignore: focus ring */
.pop ul { list-style: none; padding: 0; max-height: 280px; overflow-y: auto; margin: 8px -4px 0; }
.pop li label { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 4px; cursor: pointer; font-size: 14px; }
.pop li label:hover { background: var(--raised); }
.pop li input { width: 16px; height: 16px; accent-color: var(--accent); margin: 0; flex: none; }
.pop li .c { margin-left: auto; color: var(--muted); font-size: var(--fs-small); font-variant-numeric: tabular-nums; }
.pop .none { padding: 10px 8px; color: var(--muted); font-size: var(--fs-small); }
.pop .pop-foot { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--rule); margin-top: 8px; padding-top: 8px; font-size: var(--fs-small); }
.chips { display: none; flex-wrap: wrap; align-items: center; gap: 6px; }
.chips.on { display: flex; }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 6px 0 10px; border-radius: 999px; background: var(--active); color: var(--text); border: 0; font-size: 13px; cursor: pointer; }
.chip svg { width: 10px; height: 10px; color: var(--muted); }
.chip:hover { background: var(--chip-hover); }
.chips .mf-link { font-size: 13px; }
@media (max-width: 640px) { .pop { width: min(300px, calc(100vw - 32px)); } }
`;

// makerFilter(o) -> { matches(row), chosen(), render(keepList), clear() }
//   o.scope    the element holding [data-maker-filter] and [data-maker-chips];
//              they are looked up on each use, so a page may replace them
//   o.rows()   the list's rows, each with data-maker and data-maker-name
//   o.changed  called when the chosen makers change
// A page calls render(true) after it changes its rows: it drops a chosen
// maker no row has any more. A page whose own Escape handling calls
// preventDefault registers it first, so one Escape does one thing.
export const MAKER_FILTER_JS = String.raw`
function makerFilter(o) {
  var chosen = [];
  var X = '<svg viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg>';
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function root() { return o.scope.querySelector("[data-maker-filter]"); }
  function toggle() { var r = root(); return r && r.querySelector("[data-maker-toggle]"); }
  function nameOf(row) { return row.getAttribute("data-maker-name") || row.getAttribute("data-maker"); }
  // Each maker by its name: its ID parts and its number of rows.
  function counts() {
    var by = {}, order = [];
    Array.prototype.forEach.call(o.rows(), function (row) {
      var k = nameOf(row), id = row.getAttribute("data-maker");
      if (!by[k]) { by[k] = { name: k, ids: [], n: 0 }; order.push(k); }
      if (by[k].ids.indexOf(id) === -1) by[k].ids.push(id);
      by[k].n++;
    });
    order.sort(function (a, b) { return a.localeCompare(b); });
    return { by: by, order: order };
  }
  function found(m, f) { return !f || m.name.toLowerCase().indexOf(f) !== -1 || m.ids.some(function (id) { return id.indexOf(f) !== -1; }); }
  // keepList: leave the open list as it is, so a box just ticked keeps its place.
  function render(keepList) {
    var r = root();
    if (!r) return;
    var mk = counts();
    chosen = chosen.filter(function (k) { return mk.by[k]; });
    var find = r.querySelector("[data-maker-find]"), list = r.querySelector("[data-maker-list]"), f = find.value.toLowerCase();
    if (!keepList || !list.hasAttribute("data-filled")) {
      list.innerHTML = mk.order.filter(function (k) { return found(mk.by[k], f); }).map(function (k) {
        return '<li><label><input type="checkbox" name="maker" data-maker-key value="' + esc(k) + '"' + (chosen.indexOf(k) !== -1 ? " checked" : "") + ">" + esc(mk.by[k].name) + '<span class="c num">' + mk.by[k].n + "</span></label></li>";
      }).join("") || '<li class="none">No maker matches “' + esc(find.value) + '”.</li>';
      list.setAttribute("data-filled", "");
    }
    var btn = toggle();
    btn.classList.toggle("on", chosen.length > 0);
    btn.querySelector(".n").textContent = chosen.length ? String(chosen.length) : "";
    btn.setAttribute("aria-label", chosen.length ? "Maker, " + chosen.length + " chosen" : "Maker");
    var chips = o.scope.querySelector("[data-maker-chips]");
    if (!chips) return;
    chips.classList.toggle("on", chosen.length > 0);
    chips.innerHTML = chosen.map(function (k) { return '<button type="button" class="chip" data-chip="' + esc(k) + '" aria-label="Remove ' + esc(mk.by[k].name) + '">' + esc(mk.by[k].name) + X + "</button>"; }).join("") +
      (chosen.length > 1 ? '<button type="button" class="mf-link" data-maker-clear>Clear makers</button>' : "");
  }
  function close() {
    var r = root();
    if (r && r.classList.contains("open")) { r.classList.remove("open"); toggle().setAttribute("aria-expanded", "false"); }
  }
  function focusToggle() { var b = toggle(); if (b) b.focus(); }
  function choose(next) { chosen = next; render(); o.changed(); }
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest) return;
    if (!t.closest("[data-maker-filter]")) close();
    if (!t.closest("[data-maker-filter]") && !t.closest("[data-maker-chips]")) return;
    if (t.closest("[data-maker-toggle]")) {
      var r = root(), open = !r.classList.contains("open");
      close();
      r.classList.toggle("open", open);
      toggle().setAttribute("aria-expanded", String(open));
      if (open) { var find = r.querySelector("[data-maker-find]"); find.value = ""; render(); find.focus(); }
      return;
    }
    if (t.closest("[data-maker-done]")) { close(); focusToggle(); return; }
    if (t.closest("[data-maker-clear]")) { choose([]); return; }
    var chip = t.closest("[data-chip]");
    if (chip) { var key = chip.getAttribute("data-chip"); choose(chosen.filter(function (x) { return x !== key; })); focusToggle(); }
  });
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!t.matches || !t.matches("[data-maker-key]")) return;
    var v = t.value;
    if (t.checked) { if (chosen.indexOf(v) === -1) chosen.push(v); } else chosen = chosen.filter(function (x) { return x !== v; });
    render(true);
    o.changed();
  });
  document.addEventListener("input", function (e) { if (e.target.matches && e.target.matches("[data-maker-find]")) render(); });
  document.addEventListener("keydown", function (e) {
    var r = root();
    if (e.key !== "Escape" || e.defaultPrevented || !r || !r.classList.contains("open")) return;
    close();
    focusToggle();
  });
  return {
    matches: function (row) { return !chosen.length || chosen.indexOf(nameOf(row)) !== -1; },
    chosen: function () { return chosen.slice(); },
    render: render,
    clear: function () { chosen = []; render(); },
  };
}
`;
