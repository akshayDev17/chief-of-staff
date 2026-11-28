// A small stand-in for the browser's DOM, just the elements and calls the
// pages' own scripts use, so a test can run a script and fire its events.
// Every way a script could send a request or load a page is recorded: a
// form's submit, each location call, fetch, XMLHttpRequest and sendBeacon.
type Listener = (e: { key?: string; target?: unknown; preventDefault: () => void }) => void;

export function element(attrs: Record<string, string> = {}) {
  const listeners: Record<string, Listener[]> = {};
  const classes = new Set<string>();
  return {
    attrs: { ...attrs },
    hidden: true,
    disabled: false,
    name: "",
    value: "",
    textContent: "",
    id: attrs.id ?? "",
    focused: 0,
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), has: (c: string) => classes.has(c) },
    getAttribute(n: string) { return this.attrs[n] ?? null; },
    setAttribute(n: string, v: string) { this.attrs[n] = v; },
    removeAttribute(n: string) { delete this.attrs[n]; },
    addEventListener(type: string, fn: Listener) { (listeners[type] ??= []).push(fn); },
    focus() { this.focused++; },
    scrollIntoView() {},
    fire(type: string, key?: string) {
      let prevented = false;
      for (const fn of listeners[type] ?? []) fn({ key, target: this, preventDefault: () => { prevented = true; } });
      return prevented;
    },
  };
}

// What a script sent or loaded: "submit", "reload", "replace <url>",
// "assign <url>", "fetch <url>", "xhr", "beacon <url>".
export type Sent = string[];

// Runs `script` with the given document, at `href`, and every recorder.
// `extra.fetch` answers a fetch after it is recorded.
export function runScript(script: string, document: unknown, href: string, sent: Sent, extra: { window?: unknown; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}): void {
  const url = new URL(href);
  const location = {
    href: url.href,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    reload: () => sent.push("reload"),
    replace: (u: string) => sent.push(`replace ${u}`),
    assign: (u: string) => sent.push(`assign ${u}`),
  };
  const fetch = (u: unknown, init?: RequestInit) => { sent.push(`fetch ${String(u)}`); return extra.fetch ? extra.fetch(String(u), init) : Promise.resolve(new Response()); };
  const XMLHttpRequest = function () { sent.push("xhr"); };
  const navigator = { sendBeacon: (u: string) => { sent.push(`beacon ${u}`); return true; } };
  const window = extra.window ?? { addEventListener: () => {} };
  new Function("document", "location", "window", "fetch", "XMLHttpRequest", "navigator", script)(document, location, window, fetch, XMLHttpRequest, navigator);
}

// The inline scripts of a rendered page, in order: the page's own output.
export const pageScripts = (html: string): string => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");

// Runs the `on<event>` attribute of the element with `id` in a rendered page,
// as a browser runs an inline handler, with `self` as `this`.
export function fireInline(html: string, id: string, event: string, self: unknown): void {
  const tag = html.match(new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`no element #${id} in the page`);
  const handler = tag.match(new RegExp(`\\bon${event}="([^"]*)"`))?.[1];
  if (handler) new Function("event", handler.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")).call(self, { type: event });
}
