// A small DOM built from a rendered page's own HTML, enough for a page script
// that finds its elements with selectors and listens on the document: the
// elements, their attributes and text, selectors (lists, descendants, tags,
// classes, attributes and :not), the properties a script sets, and the calls
// that swap parts of a page in place (a <template>'s content, replaceWith,
// replaceChildren, cloneNode, remove, appendChild). Tests run
// the page's real script against it (script-dom.ts runScript) and fire events
// on its real elements.

const VOID = new Set(["meta", "link", "input", "br", "img", "hr", "source"]);
const RAW = new Set(["script", "style"]);

const decode = (s: string): string => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

type Listener = (e: { type: string; target: unknown; key?: string; preventDefault: () => void }) => void;

export class El {
  tag: string;
  attrs: Record<string, string> = {};
  children: El[] = [];
  parent: El | null = null;
  text = "";
  focused = 0;
  scrollTop = 0;
  offsetTop = 0;
  offsetHeight = 40;
  clientHeight = 300;
  private listeners: Record<string, Listener[]> = {};
  constructor(tag: string) {
    this.tag = tag;
  }
  get id(): string { return this.attrs.id ?? ""; }
  get tagName(): string { return this.tag.toUpperCase(); }
  get action(): string { return this.attrs.action ?? ""; }
  // A <template>'s content: its own children, moved out by whoever takes them.
  get content(): El { return this; }
  get name(): string { return this.attrs.name ?? ""; }
  get className(): string { return this.attrs.class ?? ""; }
  set className(v: string) { this.attrs.class = v; }
  get hidden(): boolean { return "hidden" in this.attrs; }
  set hidden(v: boolean) { if (v) this.attrs.hidden = ""; else delete this.attrs.hidden; }
  get disabled(): boolean { return "disabled" in this.attrs; }
  set disabled(v: boolean) { if (v) this.attrs.disabled = ""; else delete this.attrs.disabled; }
  get firstChild(): El | null { return this.children[0] ?? null; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this.children = []; this.text = v; }
  get options(): El[] { return this.all("option"); }
  get value(): string {
    if (this.tag === "select") {
      const opts = this.options;
      const on = opts.find((o) => "selected" in o.attrs) ?? opts[0];
      return on ? (on.attrs.value ?? on.textContent) : "";
    }
    return this.attrs.value ?? "";
  }
  set value(v: string) {
    if (this.tag === "select") for (const o of this.options) { if (o.attrs.value === v) o.attrs.selected = ""; else delete o.attrs.selected; }
    else this.attrs.value = v;
  }
  get classList() {
    const list = () => (this.attrs.class ?? "").split(/\s+/).filter(Boolean);
    const set = (c: string[]) => { this.attrs.class = c.join(" "); };
    return {
      contains: (c: string) => list().includes(c),
      add: (c: string) => { if (!list().includes(c)) set([...list(), c]); },
      remove: (c: string) => set(list().filter((x) => x !== c)),
      toggle: (c: string, on?: boolean) => { const want = on ?? !list().includes(c); if (want) set([...list().filter((x) => x !== c), c]); else set(list().filter((x) => x !== c)); return want; },
    };
  }
  getAttribute(n: string): string | null { return n in this.attrs ? this.attrs[n]! : null; }
  setAttribute(n: string, v: string) { this.attrs[n] = String(v); }
  removeAttribute(n: string) { delete this.attrs[n]; }
  hasAttribute(n: string): boolean { return n in this.attrs; }
  toggleAttribute(n: string, on?: boolean): boolean { const want = on ?? !(n in this.attrs); if (want) this.attrs[n] = ""; else delete this.attrs[n]; return want; }
  focus() { this.focused++; activeElement = this; }
  scrollIntoView() {}
  // The nodes `n` stands for: a template's content gives its children.
  private static nodesOf(n: El): El[] { return n.tag === "template" ? [...n.children] : [n]; }
  private static detach(n: El) { if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n); n.parent = null; }
  replaceWith(n: El) {
    const parent = this.parent;
    if (!parent) return;
    const nodes = El.nodesOf(n);
    nodes.forEach(El.detach);
    const at = parent.children.indexOf(this);
    parent.children.splice(at, 1, ...nodes);
    for (const c of nodes) c.parent = parent;
    this.parent = null;
  }
  replaceChildren(...ns: El[]) {
    const nodes = ns.flatMap(El.nodesOf);
    nodes.forEach(El.detach);
    for (const c of this.children) c.parent = null;
    this.text = "";
    this.children = nodes;
    for (const c of nodes) c.parent = this;
  }
  appendChild(n: El): El { El.detach(n); n.parent = this; this.children.push(n); return n; }
  remove() { El.detach(this); }
  cloneNode(): El { const copy = parse(this.outerHTML).children[0]!; copy.parent = null; return copy; }
  insertAdjacentHTML(where: string, html: string) {
    if (where !== "beforebegin" || !this.parent) return;
    const nodes = parse(html).children;
    const at = this.parent.children.indexOf(this);
    this.parent.children.splice(at, 0, ...nodes);
    for (const c of nodes) c.parent = this.parent;
  }
  contains(other: unknown): boolean { for (let e = other as El | null; e; e = e.parent) if (e === this) return true; return false; }
  matches(sel: string): boolean { return matches(this, sel); }
  closest(sel: string): El | null { for (let e: El | null = this; e; e = e.parent) if (matches(e, sel)) return e; return null; }
  all(sel: string): El[] { const out: El[] = []; const walk = (e: El) => { for (const c of e.children) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(sel: string): El[] { return this.all(sel); }
  querySelector(sel: string): El | null { return this.all(sel)[0] ?? null; }
  get innerHTML(): string { return this.text + this.children.map((c) => c.outerHTML).join(""); }
  set innerHTML(html: string) { this.text = ""; this.children = []; for (const c of parse(html).children) { c.parent = this; this.children.push(c); } }
  get outerHTML(): string {
    if (this.tag === "#text") return this.text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const attrs = Object.entries(this.attrs).map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)).join("");
    return VOID.has(this.tag) ? `<${this.tag}${attrs}>` : `<${this.tag}${attrs}>${this.innerHTML}</${this.tag}>`;
  }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
  // Fires `type` at `target`, as a browser bubbles it up to this element.
  fire(type: string, target: El, key?: string): boolean {
    let prevented = false;
    for (const fn of this.listeners[type] ?? []) fn({ type, target, key, preventDefault: () => { prevented = true; } });
    return prevented;
  }
}

let activeElement: El | null = null;

// ---------- selectors: a, b · a b · tag.class#id[attr][attr="v"]:not(x) ----------
function matches(e: El, sel: string): boolean {
  return splitTop(sel, ",").some((one) => {
    const tokens = one.trim().replace(/\s*>\s*/g, " > ").split(/\s+(?![^[]*\])(?![^(]*\))/);
    return matchChain(e, tokens);
  });
}
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
// `tokens`: compounds with ">" between a child and its parent, a space
// between a descendant and its ancestor; matched from the right.
function matchChain(e: El, tokens: string[]): boolean {
  if (!matchCompound(e, tokens[tokens.length - 1]!)) return false;
  const rest = tokens.slice(0, -1);
  if (!rest.length) return true;
  if (rest[rest.length - 1] === ">") return e.parent !== null && matchChain(e.parent, rest.slice(0, -1));
  for (let p = e.parent; p; p = p.parent) if (matchChain(p, rest)) return true;
  return false;
}
function matchCompound(e: El, c: string): boolean {
  const re = /^[a-z0-9-]+|\.[\w-]+|#[\w-]+|\[([\w-]+)(?:="([^"]*)"|=([\w-]+))?\]|:not\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  let used = 0;
  while ((m = re.exec(c))) {
    used += m[0].length;
    const t = m[0];
    if (t.startsWith(".")) { if (!e.classList.contains(t.slice(1))) return false; }
    else if (t.startsWith("#")) { if (e.id !== t.slice(1)) return false; }
    else if (t.startsWith("[")) { const want = m[2] ?? m[3]; if (!(m[1]! in e.attrs) || (want !== undefined && e.attrs[m[1]!] !== want)) return false; }
    else if (t.startsWith(":not")) { if (matches(e, m[4]!)) return false; }
    else if (e.tag !== t.toLowerCase()) return false;
  }
  if (used !== c.length) throw new Error(`mini-dom: unsupported selector "${c}"`);
  return true;
}

// ---------- HTML ----------
export function parse(html: string): El {
  const root = new El("#root");
  let at = root;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) { for (let e: El | null = at; e; e = e.parent) if (e.tag === m[1].toLowerCase()) { at = e.parent ?? root; break; } continue; }
    if (m[2]) {
      const el = new El(m[2].toLowerCase());
      for (const a of (m[3] ?? "").matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) el.attrs[a[1]!] = decode(a[2] ?? "");
      el.parent = at;
      at.children.push(el);
      if (RAW.has(el.tag)) {
        const end = html.indexOf(`</${el.tag}>`, re.lastIndex);
        el.text = html.slice(re.lastIndex, end);
        re.lastIndex = end + el.tag.length + 3;
      } else if (!VOID.has(el.tag)) at = el;
      continue;
    }
    if (m[4] && m[4].trim()) {
      const t = new El("#text");
      t.text = decode(m[4]);
      t.parent = at;
      at.children.push(t);
    }
  }
  return root;
}

// A document over `html`: the root element, getElementById, and listeners.
export function documentOf(html: string) {
  const root = parse(html);
  const doc = new El("#document");
  doc.children = root.children;
  for (const c of doc.children) c.parent = doc;
  const htmlEl = doc.querySelector("html") ?? doc;
  return Object.assign(doc, {
    documentElement: htmlEl,
    getElementById: (id: string) => doc.querySelector(`#${id}`),
    createElement: (tag: string) => new El(tag),
    get activeElement() { return activeElement; },
  });
}
