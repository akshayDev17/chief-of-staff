import { afterEach, describe, expect, it, vi } from "vitest";
import { MODELS_JS } from "../src/providers/models-panel";

// Runs the page's own listbox script against a small stand-in for the
// browser's DOM: just the elements and calls the script uses. The stand-in
// form records every submit, and the stand-in location every navigation, so
// a test can check that choosing a model sends nothing.
type Listener = (e: { key?: string; target?: unknown; preventDefault: () => void }) => void;

function element(attrs: Record<string, string> = {}) {
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

// The page with a value already in the hidden field, as a reload restores it.
const pageWith = (models: string[], value: string) => page(models, "", value);

function page(models: string[], hash = "", restoredValue = "") {
  const options = models.map((m, i) => element({ id: `opt-${i}`, "data-model": m, "aria-selected": "false" }));
  const button = element();
  const list = Object.assign(element(), { querySelectorAll: () => options });
  const input = Object.assign(element(), { value: restoredValue });
  const test = Object.assign(element(), { disabled: true, textContent: "Test" });
  const section = element({ id: "test" });
  const submitted: string[] = [];
  const navigated: string[] = [];
  const parts: Record<string, unknown> = { ".lb-btn": button, "[role=listbox]": list, "[data-model-input]": input, "[data-test-button]": test };
  const form = Object.assign(element(), {
    querySelector: (s: string) => parts[s] ?? null,
    contains: () => true,
    submit: () => { submitted.push(input.value); },
  });
  const document = Object.assign(element(), {
    querySelectorAll: (s: string) => (s === "form[data-listbox]" ? [form] : s === "[data-model-input]" ? [input] : []),
    querySelector: () => null,
    getElementById: (id: string) => (id === "test" ? section : null),
  });
  const loaded: Array<() => void> = [];
  const window = { addEventListener: (type: string, fn: () => void) => { if (type === "load") loaded.push(fn); } };
  const location = {
    hash,
    reload: () => navigated.push("reload"),
    assign: (u: string) => navigated.push(u),
  };
  new Function("document", "location", "window", MODELS_JS)(document, location, window);
  return { button, list, input, test, options, section, form, submitted, navigated, load: () => loaded.forEach((fn) => fn()) };
}

const MODELS = ["Claude Haiku 4.5", "Claude Opus 4.7", "Claude Sonnet 5.5", "Nova 2.0 Lite"];

describe("choosing a model", () => {
  it("sends nothing and loads nothing: it fills the form and turns the disabled Test button into Test with <model>?", () => {
    const p = page(MODELS);
    expect(p.test.hidden).toBe(false);
    expect(p.test.disabled).toBe(true);
    expect(p.button.textContent).toBe("");
    p.button.fire("click");
    p.options[2]!.fire("click");
    expect(p.submitted).toEqual([]);
    expect(p.navigated).toEqual([]);
    expect(p.input.value).toBe("Claude Sonnet 5.5");
    expect(p.button.textContent).toBe("Claude Sonnet 5.5");
    expect(p.test.disabled).toBe(false);
    expect(p.test.textContent).toBe("Test with Claude Sonnet 5.5?");
    // The next action takes focus.
    expect(p.test.focused).toBe(1);
    // Choosing another only changes the label.
    p.button.fire("click");
    p.options[0]!.fire("click");
    expect(p.test.textContent).toBe("Test with Claude Haiku 4.5?");
    expect(p.submitted).toEqual([]);
  });

  it("lets the Test button send the form, and only once a model is chosen", () => {
    const p = page(MODELS);
    // A submit with nothing chosen is stopped and opens the list.
    expect(p.form.fire("submit")).toBe(true);
    expect(p.list.hidden).toBe(false);
    p.options[1]!.fire("click");
    expect(p.form.fire("submit")).toBe(false);
    expect(p.test.disabled).toBe(true);
    expect(p.test.textContent).toBe("Testing Claude Opus 4.7…");
  });

  it("highlights the section and focuses the dropdown when the page opens at #test", () => {
    vi.useFakeTimers();
    const at = page(MODELS, "#test");
    expect(at.section.classList.has("arrived")).toBe(true);
    // Focus moves once the page has loaded and the browser has moved to the anchor itself.
    vi.runAllTimers();
    expect(at.button.focused).toBe(0);
    at.load();
    vi.runAllTimers();
    vi.useRealTimers();
    expect(at.button.focused).toBe(1);
    const elsewhere = page(MODELS);
    expect(elsewhere.section.classList.has("arrived")).toBe(false);
    expect(elsewhere.button.focused).toBe(0);
  });
});

describe("a model the browser restored on reload", () => {
  it("shows as chosen, with Test with <model>? ready, and an unknown one is dropped", () => {
    const restored = pageWith(MODELS, "Claude Opus 4.7");
    expect(restored.button.textContent).toBe("Claude Opus 4.7");
    expect(restored.test.disabled).toBe(false);
    expect(restored.test.textContent).toBe("Test with Claude Opus 4.7?");
    const gone = pageWith(MODELS, "gone/model");
    expect(gone.input.value).toBe("");
    expect(gone.test.disabled).toBe(true);
  });
});

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
    expect(p.input.value).toBe("");
    expect(p.list.getAttribute("aria-activedescendant")).toBe("opt-2");

    p.list.fire("keydown", "Enter");
    expect(p.input.value).toBe("Claude Sonnet 5.5");
    expect(p.input.name).toBe("model");
    expect(p.submitted).toEqual([]);
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
    expect(p.input.value).toBe("Nova 2.0 Lite");
    expect(p.submitted).toEqual([]);
  });
});
