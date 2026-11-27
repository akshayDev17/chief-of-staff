import { afterEach, describe, expect, it, vi } from "vitest";
import { MODELS_JS } from "../src/providers/models-panel";

// Runs the page's own listbox script against a small stand-in for the
// browser's DOM: just the elements and calls the script uses.
type Listener = (e: { key?: string; target?: unknown; preventDefault: () => void }) => void;

function element(attrs: Record<string, string> = {}) {
  const listeners: Record<string, Listener[]> = {};
  const classes = new Set<string>();
  return {
    attrs: { ...attrs },
    hidden: true,
    name: "",
    value: "",
    textContent: "",
    id: attrs.id ?? "",
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), has: (c: string) => classes.has(c) },
    getAttribute(n: string) { return this.attrs[n] ?? null; },
    setAttribute(n: string, v: string) { this.attrs[n] = v; },
    removeAttribute(n: string) { delete this.attrs[n]; },
    addEventListener(type: string, fn: Listener) { (listeners[type] ??= []).push(fn); },
    focus() {},
    scrollIntoView() {},
    fire(type: string, key?: string) {
      let prevented = false;
      for (const fn of listeners[type] ?? []) fn({ key, target: this, preventDefault: () => { prevented = true; } });
      return prevented;
    },
  };
}

function page(models: string[]) {
  const options = models.map((m, i) => element({ id: `opt-${i}`, "data-model": m, "aria-selected": "false" }));
  const button = element();
  const list = Object.assign(element(), { querySelectorAll: () => options });
  const input = element();
  const submitted: string[] = [];
  const parts: Record<string, unknown> = { ".lb-btn": button, "[role=listbox]": list, "[data-model-input]": input };
  const form = Object.assign(element(), {
    querySelector: (s: string) => parts[s] ?? null,
    contains: () => true,
    submit: () => { submitted.push(input.value); },
  });
  const document = Object.assign(element(), { querySelectorAll: () => [form] });
  new Function("document", MODELS_JS)(document);
  return { button, list, input, options, submitted };
}

const MODELS = ["Claude Haiku 4.5", "Claude Opus 4.7", "Claude Sonnet 5.5", "Nova 2.0 Lite"];

describe("the model listbox's keyboard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("treats a space typed in the middle of a name as part of the name, so typing \"claude s\" moves to Claude Sonnet 5.5 and chooses nothing", () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const p = page(MODELS);
    p.button.fire("click");
    for (const key of "claude s") {
      now += 100;
      p.list.fire("keydown", key);
    }
    expect(p.submitted).toEqual([]);
    expect(p.input.value).toBe("");
    expect(p.list.getAttribute("aria-activedescendant")).toBe("opt-2");

    p.list.fire("keydown", "Enter");
    expect(p.submitted).toEqual(["Claude Sonnet 5.5"]);
    expect(p.input.name).toBe("model");
  });

  it("still chooses the highlighted model with a space once no name is being typed", () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const p = page(MODELS);
    p.button.fire("click");
    p.list.fire("keydown", "n");
    expect(p.list.getAttribute("aria-activedescendant")).toBe("opt-3");
    now += 701;
    p.list.fire("keydown", " ");
    expect(p.submitted).toEqual(["Nova 2.0 Lite"]);
  });
});
