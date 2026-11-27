// The three Models › Setup screens together: the Next chain follows the tab
// order exactly (the owner, 2026-11-27), and no dropdown on them sends a
// request or loads a page when it changes (the owner, 2026-11-27: "upon
// changing a model in the dropdwon, i believe some request is sent"): each
// page's own script runs against a stand-in DOM (script-dom.ts) that records
// every submit, navigation and request. Budgets has no dropdown.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { saveUserModel } from "../src/models/add";
import { handleTaskModels } from "../src/models/picker-page";
import { AFTER_SETUP_TABS, SETUP_TABS } from "../src/models/setup-tabs";
import { handleProviders } from "../src/providers/page";
import { handleBudgets } from "../src/proxy/budgets-page";
import { writeConnection } from "../src/proxy/connections";
import { BUDGETS_PATH, PROVIDERS_PATH, TASK_MODELS_PATH } from "../src/paths";
import { fakeFetch } from "./fake-sources";
import { element, listboxPage, pageScripts, runScript, type Sent } from "./script-dom";
import { seedPrices, testPlugin, testSecrets, userFor } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
const ORIGIN = "https://cos.example.com";
let userId: string;

beforeEach(async () => {
  await seedPrices();
  userId = (await userFor("owner-sub")).id;
  await writeConnection(env.DB, userId, testPlugin(), { method: "oauth_pkce", key_hash: "a".repeat(64) }, NOW);
  for (const model of ["test-luna", "test-mini"]) await saveUserModel(env.DB, userId, { provider: "openrouter", model, location: "global", addedAt: NOW.toISOString() });
});

// Every screen, rendered for a connected user with two passed models, so each
// shows its dropdowns.
async function screens(): Promise<Record<string, string>> {
  const plugins = { openrouter: testPlugin() };
  const providers = await handleProviders(new Request(`${ORIGIN}${PROVIDERS_PATH}`), {
    db: env.DB, plugins, readPlugins: async () => plugins, secrets: testSecrets(), userId, viewer: "owner", appOrigin: ORIGIN, now: NOW, fetcher: fakeFetch(),
  });
  const budgets = await handleBudgets(new Request(`${ORIGIN}${BUDGETS_PATH}`), env.DB, userId, NOW, { secrets: testSecrets(), fetcher: fakeFetch() });
  const tasks = await handleTaskModels(new Request(`${ORIGIN}${TASK_MODELS_PATH}`), { db: env.DB, plugins, userId, viewer: "owner", now: NOW });
  return { [PROVIDERS_PATH]: await providers.text(), [BUDGETS_PATH]: await budgets.text(), [TASK_MODELS_PATH]: await tasks.text() };
}

// One task's provider select and model select, the models grouped by
// provider, as the page renders them; each select's form records a submit.
function pairSelects(byProvider: Record<string, string[]>, provider: string, model: string, sent: Sent) {
  const form = { submit: () => sent.push("submit"), requestSubmit: () => sent.push("submit") };
  const groups = Object.entries(byProvider).map(([p, models]) => {
    const group = Object.assign(element({ "data-provider": p }), { hidden: false, options: [] as Array<{ value: string; parentElement: unknown }> });
    group.options = models.map((value) => ({ value, parentElement: group }));
    return Object.assign(group, { querySelector: (s: string) => (s === "option" ? group.options[0] ?? null : null) });
  });
  const options = groups.flatMap((g) => g.options);
  let selected = options.find((o) => o.value === model);
  const modelSelect = Object.assign(element(), { form, querySelectorAll: (s: string) => (s === "optgroup" ? groups : []) });
  Object.defineProperties(modelSelect, {
    value: { get: () => selected?.value ?? "", set: (v: string) => { selected = options.find((o) => o.value === v); } },
    selectedOptions: { get: () => (selected ? [selected] : []) },
  });
  const providerSelect = Object.assign(element(), { form, value: provider });
  const parts: Record<string, unknown> = { "[data-pair-provider]": providerSelect, "[data-pair-model]": modelSelect };
  const fieldset = { querySelector: (s: string) => parts[s] ?? null };
  return { fieldset, provider: providerSelect, model: modelSelect, shown: () => groups.filter((g) => !g.hidden).map((g) => g.attrs["data-provider"]) };
}

const nextOf = (html: string): string => html.match(/<(?:a|span) class="[^"]*"(?: href="([^"]+)")?(?: aria-disabled="true")? data-next>([^<]+)</)?.slice(1).join("|") ?? "";

describe("Models › Setup", () => {
  it("has its tabs in the setup checklist's order: providers and models, budgets, the model for each task", () => {
    expect(SETUP_TABS.map((t) => t.label)).toEqual(["Providers and models", "Budgets", "Model for each task"]);
  });

  it("chains each screen's Next to the next tab, and the last to the checklist's next item", async () => {
    const html = await screens();
    const chain = SETUP_TABS.map((t) => nextOf(html[t.href]!));
    expect(chain).toEqual([
      `${SETUP_TABS[1]!.href}|Next: ${SETUP_TABS[1]!.nextName}`,
      `${SETUP_TABS[2]!.href}|Next: ${SETUP_TABS[2]!.nextName}`,
      `|Next: ${AFTER_SETUP_TABS.nextName} (not built yet)`,
    ]);
    expect(chain[0]).toBe(`${BUDGETS_PATH}|Next: budgets`);
    expect(chain[1]).toBe(`${TASK_MODELS_PATH}|Next: the model for each task`);
    // Each screen shows the same tab line, itself in bold.
    for (const t of SETUP_TABS) {
      const line = html[t.href]!.match(/<nav class="small setup-tabs"[^>]*>(.*?)<\/nav>/)![1]!;
      expect(line.replace(/<[^>]+>/g, "")).toBe(SETUP_TABS.map((x) => x.label).join(" · "));
      expect(line).toContain(`<strong aria-current="page">${t.label}</strong>`);
    }
  });

  it("sends nothing and loads nothing when the Providers page's model list changes", async () => {
    const html = await screens();
    const p = listboxPage(pageScripts(html[PROVIDERS_PATH]!), ["test-luna", "test-mini"]);
    p.button.fire("click");
    p.options[1]!.fire("click");
    p.button.fire("click");
    p.list.fire("keydown", "ArrowUp");
    p.list.fire("keydown", "Enter");
    expect(p.input.value).toBe("test-luna");
    expect(p.test.textContent).toBe("Test with test-luna?");
    expect(p.sent).toEqual([]);
  });

  it("sends nothing and loads nothing when a task's provider or model select changes, and shows only that provider's models", async () => {
    const html = await screens();
    const sent: Sent = [];
    const pair = pairSelects({ openrouter: ["test-luna", "test-mini"], other: ["other-a", "other-b"] }, "openrouter", "test-mini", sent);
    runScript(pageScripts(html[TASK_MODELS_PATH]!), { querySelectorAll: (s: string) => (s === "[data-pair]" ? [pair.fieldset] : []) }, `${ORIGIN}${TASK_MODELS_PATH}`, sent);
    expect(pair.shown()).toEqual(["openrouter"]);
    expect(pair.model.value).toBe("test-mini");
    pair.provider.value = "other";
    pair.provider.fire("change");
    expect(pair.shown()).toEqual(["other"]);
    expect(pair.model.value).toBe("other-a");
    pair.model.value = "other-b";
    pair.model.fire("change");
    pair.provider.value = "";
    pair.provider.fire("change");
    expect(pair.model.value).toBe("");
    expect(sent).toEqual([]);
  });
});
