// Stand-ins for the two lists with the Maker filter (models/maker-filter.ts),
// as their scripts see them: Models › Usage's Per model box (the search, the
// filter, the count, the chips, the rows and the "No model matches" row), and
// Models › Setup › Providers' model table (its search, the filter, its count,
// the chips and the rows). Each element answers the exact
// selectors the scripts ask it; an event goes to its target's own listeners,
// then to the document's, as it bubbles in a browser. What the scripts write
// as HTML (the maker list, the chips) is read back from innerHTML.
import { FIND_JS } from "../src/models/usage-page";
import { PAGE_SCRIPT } from "../src/providers/page-script";
import { runScript, type Sent } from "./script-dom";

type Listener = (e: FakeEvent) => void;
interface FakeEvent { type: string; key?: string; target: Node; defaultPrevented: boolean; preventDefault: () => void }

export interface Node {
  attrs: Record<string, string>;
  id: string;
  parent?: Node;
  hidden: boolean;
  value: string;
  checked: boolean;
  textContent: string;
  innerHTML: string;
  focused: number;
  scrollTop: number;
  listeners: Record<string, Listener[]>;
  classList: { toggle: (c: string, on?: boolean) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  getAttribute: (n: string) => string | null;
  setAttribute: (n: string, v: string) => void;
  hasAttribute: (n: string) => boolean;
  addEventListener: (type: string, fn: Listener) => void;
  focus: () => void;
  // "[attr]" or ".class"; the scripts ask nothing else of a target.
  matches: (sel: string) => boolean;
  closest: (sel: string) => Node | null;
  querySelector: (sel: string) => Node | null;
  querySelectorAll: (sel: string) => Node[];
  q: Record<string, Node>;
  qa: Record<string, Node[]>;
}

export function node(attrs: Record<string, string> = {}, parent?: Node): Node {
  const classes = new Set((attrs.class ?? "").split(" ").filter(Boolean));
  const n: Node = {
    attrs: { ...attrs },
    id: attrs.id ?? "",
    ...(parent ? { parent } : {}),
    hidden: "hidden" in attrs,
    value: attrs.value ?? "",
    checked: false,
    textContent: "",
    innerHTML: "",
    focused: 0,
    scrollTop: 0,
    listeners: {},
    classList: {
      toggle: (c, on) => { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); },
      remove: (c) => { classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    getAttribute: (k) => n.attrs[k] ?? null,
    setAttribute: (k, v) => { n.attrs[k] = v; },
    hasAttribute: (k) => k in n.attrs,
    addEventListener: (type, fn) => { (n.listeners[type] ??= []).push(fn); },
    focus: () => { n.focused++; },
    matches: (sel) => (sel.startsWith(".") ? classes.has(sel.slice(1)) : sel.slice(1, -1) in n.attrs),
    closest: (sel) => { for (let at: Node | undefined = n; at; at = at.parent) if (at.matches(sel)) return at; return null; },
    querySelector: (sel) => n.q[sel] ?? null,
    querySelectorAll: (sel) => n.qa[sel] ?? [],
    q: {},
    qa: {},
  };
  return n;
}

// The filter's own elements under `scope`, as MAKER_FILTER_HTML and
// MAKER_CHIPS_HTML lay them out.
function makerNodes(scope: Node) {
  const filter = node({ class: "maker", "data-maker-filter": "" }, scope);
  const toggle = node({ class: "maker-btn", "data-maker-toggle": "", "aria-expanded": "false" }, filter);
  const badge = node({ class: "n" }, toggle);
  const pop = node({ class: "pop" }, filter);
  const makerFind = node({ "data-maker-find": "" }, pop);
  const list = node({ "data-maker-list": "" }, pop);
  const foot = node({ class: "pop-foot" }, pop);
  const popClear = node({ "data-maker-clear": "" }, foot);
  const done = node({ "data-maker-done": "" }, foot);
  const chips = node({ class: "chips", "data-maker-chips": "" }, scope);
  Object.assign(scope.q, { "[data-maker-filter]": filter, "[data-maker-chips]": chips });
  Object.assign(filter.q, { "[data-maker-toggle]": toggle, "[data-maker-find]": makerFind, "[data-maker-list]": list });
  toggle.q[".n"] = badge;
  return { filter, toggle, badge, makerFind, list, popClear, done, chips };
}

// Runs `script` on `document`, and the ways a test acts on the filter.
function drive(script: string, document: Record<string, unknown>, m: ReturnType<typeof makerNodes>) {
  const docListeners: Record<string, Listener[]> = {};
  document.addEventListener = (type: string, fn: Listener) => { (docListeners[type] ??= []).push(fn); };
  const sent: Sent = [];
  runScript(script, document, "https://cos.example.com/chief-of-staff/models", sent, { window: { fetch: () => { sent.push("fetch"); }, history: {}, addEventListener: () => {} } });
  // An event at `target`: its own listeners, then the document's.
  const dispatch = (type: string, target: Node, key?: string): FakeEvent => {
    const e: FakeEvent = { type, target, ...(key ? { key } : {}), defaultPrevented: false, preventDefault: () => { e.defaultPrevented = true; } };
    for (const fn of target.listeners[type] ?? []) fn(e);
    for (const fn of docListeners[type] ?? []) fn(e);
    return e;
  };
  // The maker list as the script wrote it: each maker's key, name, count and tick.
  const listed = () => [...m.list.innerHTML.matchAll(/value="([^"]*)"( checked)?>([^<]*)<span class="c num">(\d+)<\/span>/g)].map((x) => ({ key: x[1], name: x[3], n: Number(x[4]), checked: Boolean(x[2]) }));
  const chipKeys = () => [...m.chips.innerHTML.matchAll(/data-chip="([^"]*)"/g)].map((x) => x[1]);
  // Ticking or unticking a maker's box in the open list.
  const tick = (key: string, on = true) => { const box = node({ "data-maker-key": "", value: key }, m.list); box.checked = on; dispatch("change", box); };
  // A click on a chip the script wrote, or on its Clear makers.
  const removeChip = (key: string) => dispatch("click", node({ class: "chip", "data-chip": key }, m.chips));
  const clearMakers = () => dispatch("click", node({ class: "mf-link", "data-maker-clear": "" }, m.chips));
  return { ...m, sent, dispatch, listed, chipKeys, tick, removeChip, clearMakers, outside: node() };
}

export interface ListRow { text: string; maker: string; makerName: string }

// Usage's Per model box for `rows`, its script run on it.
export function perModelBox(rows: ListRow[]) {
  const find = node({ "data-find": "by-models", "data-noun": "models", hidden: "" });
  const input = node({ type: "search" }, find);
  const x = node({ "data-clear-q": "", hidden: "" }, find);
  const count = node({ "data-count": "" }, find);
  const m = makerNodes(find);
  Object.assign(find.q, { ".search input": input, "[data-count]": count, "[data-clear-q]": x });
  const scroller = node();
  scroller.scrollTop = 240;
  const table = Object.assign(node({}, scroller), { parentNode: scroller });
  const trs = rows.map((r) => Object.assign(node({ "data-find-text": r.text, "data-maker": r.maker, "data-maker-name": r.makerName }, table), { hidden: false }));
  const none = node({ "data-no-match": "", hidden: "" }, table);
  const said = node({}, none);
  const fromMakers = node({ hidden: "" }, none);
  const clear = node({ "data-clear": "" }, none);
  Object.assign(none.q, { "[data-said]": said, "[data-said-makers]": fromMakers, "[data-clear]": clear });
  table.qa["tr[data-find-text]"] = trs;
  table.q["tr[data-no-match]"] = none;
  const d = drive(FIND_JS, { querySelectorAll: (q: string) => (q === "[data-find]" ? [find] : []), getElementById: (id: string) => (id === "by-models" ? table : null) }, m);
  const type = (v: string) => { input.value = v; d.dispatch("input", input); };
  const shown = () => trs.flatMap((r, i) => (r.hidden ? [] : [i]));
  return { ...d, find, input, x, count, scroller, trs, none, said, fromMakers, clear, type, shown };
}

// Providers' model table for `rows`, its page script run on it.
export function providersTable(rows: ListRow[]) {
  const main = node({ id: "screen" });
  const q = node({ id: "pick-q", type: "search" }, main);
  const count = node({ id: "pick-count" }, main);
  const m = makerNodes(main);
  const box = node({ id: "tbl-box" }, main);
  const list = node({ id: "pick-list" }, box);
  const lis = rows.map((r) => Object.assign(node({ class: "row", "data-hay": r.text, "data-state": "pending", "data-maker": r.maker, "data-maker-name": r.makerName }, list), { hidden: false }));
  main.qa["#pick-list > li.row"] = lis;
  const byId: Record<string, Node> = { screen: main, "pick-q": q, "pick-count": count, "tbl-box": box, "pick-list": list };
  // "No model matches": the row the script adds when none shows.
  const added: Node[] = [];
  Object.assign(list, { appendChild: (n: Node) => { added.push(n); } });
  const d = drive(PAGE_SCRIPT, { getElementById: (id: string) => byId[id] ?? null, createElement: () => node(), activeElement: null, visibilityState: "visible", readyState: "complete" }, m);
  const type = (v: string) => { q.value = v; d.dispatch("input", q); };
  const shown = () => lis.flatMap((r, i) => (r.hidden ? [] : [i]));
  return { ...d, main, q, count, lis, added, type, shown };
}
