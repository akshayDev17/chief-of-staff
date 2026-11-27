import { afterEach, describe, expect, it, vi } from "vitest";
import { MODELS_JS } from "../src/providers/models-panel";
import { listboxPage } from "./script-dom";

// Runs the page's own listbox script against a small stand-in for the
// browser's DOM (script-dom.ts), which records every submit, navigation and
// request, so a test can check that choosing a model sends nothing.
const PROVIDERS = "https://cos.example.com/chief-of-staff/models/setup/providers";
const page = (models: string[], hash = "") => listboxPage(MODELS_JS, models, { href: `${PROVIDERS}${hash}` });
// The page with a value already in the hidden field, as a reload restores it.
const pageWith = (models: string[], value: string) => listboxPage(MODELS_JS, models, { restoredValue: value });

const MODELS = ["Claude Haiku 4.5", "Claude Opus 4.7", "Claude Sonnet 5.5", "Nova 2.0 Lite"];

describe("choosing a model", () => {
  it("sends nothing and loads nothing: it fills the form and turns the disabled Test button into Test with <model>?", () => {
    const p = page(MODELS);
    expect(p.test.hidden).toBe(false);
    expect(p.test.disabled).toBe(true);
    expect(p.button.textContent).toBe("");
    p.button.fire("click");
    p.options[2]!.fire("click");
    expect(p.sent).toEqual([]);
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
    expect(p.sent).toEqual([]);
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
    expect(p.sent).toEqual([]);
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
    expect(p.sent).toEqual([]);
  });
});

describe("the progress reload while Test all models runs", () => {
  afterEach(() => vi.useRealTimers());
  const RESULTS = "/chief-of-staff/models/setup/providers?provider=openrouter&tests=all#openrouter-test-all";
  const running = (href: string, reloadTo = RESULTS) => listboxPage(MODELS_JS, MODELS, { href, body: { "data-reload-every": "20", "data-reload-to": reloadTo } });

  it("loads the run's GET address from a page a form's POST returned, never sending the form again", () => {
    vi.useFakeTimers();
    const p = running(`${PROVIDERS}/openrouter/choose#test`);
    vi.advanceTimersByTime(19_999);
    expect(p.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(p.sent).toEqual([`replace https://cos.example.com${RESULTS}`]);
  });

  it("reloads a page that is already at its GET address", () => {
    vi.useFakeTimers();
    const p = running(`https://cos.example.com${RESULTS}`);
    vi.advanceTimersByTime(20_000);
    expect(p.sent).toEqual(["reload"]);
  });

  it("waits while a model is chosen or the list is open", () => {
    vi.useFakeTimers();
    const chosen = running(`${PROVIDERS}/openrouter/add-tested`);
    chosen.button.fire("click");
    vi.advanceTimersByTime(20_000);
    expect(chosen.sent).toEqual([]);
    chosen.options[1]!.fire("click");
    vi.advanceTimersByTime(60_000);
    expect(chosen.sent).toEqual([]);
  });
});
