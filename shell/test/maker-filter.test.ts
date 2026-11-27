// The Maker filter, one module (models/maker-filter.ts) shared by Models ›
// Setup › Providers' model table and Models › Usage's Per model box: makers
// named from the provider's own model names, with counts, a find box, chips
// that remove, and the page's search narrowing with it; all in the page, with
// no request, no reload and the address unchanged; hidden without scripts.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MAKER_CHIPS_HTML, MAKER_FILTER_HTML, makerKey, nameMakers } from "../src/models/maker-filter";
import { BOX_ROWS, handleUsage } from "../src/models/usage-page";
import { PROVIDERS_PATH } from "../src/paths";
import { CATALOG_VERSION } from "../src/prices/openrouter";
import { writeSnapshot } from "../src/prices/store";
import { handleProviders } from "../src/providers/page";
import { writeConnection } from "../src/proxy/connections";
import { writeLedgerRow } from "../src/proxy/ledger";
import { fakeFetch, ISSUED_KEY, keyReply } from "./fake-sources";
import { perModelBox, providersTable, type ListRow } from "./maker-dom";
import { seedPrices, testPlugin, testSecrets, userFor } from "./test-plugin";

const NOW = new Date("2026-11-27T10:41:00Z");
const ORIGIN = "https://cos.example.com";
let userId: string;

beforeEach(async () => {
  await seedPrices();
  userId = (await userFor("maker-sub")).id;
});

describe("each maker's name", () => {
  it("comes from the provider's own model names, the first in the list's order, never from a list in the app", () => {
    const names = nameMakers([
      { id: "zeta-labs/one", name: "Zeta Labs: One" },
      { id: "zeta-labs/two", name: "Zeta: Two" },
      { id: "mistralai/plain", name: "Plain" },
      { id: "mistralai/named", name: "Mistral: Named" },
      { id: "undi95/remm", name: "ReMM SLERP 13B" },
      { id: "no-slash" },
    ]);
    expect(Object.fromEntries(names)).toEqual({ "zeta-labs": "Zeta Labs", mistralai: "Mistral", undi95: "undi95", "no-slash": "no-slash" });
  });

  it("is the provider's own name for its own models, when none of them names it", () => {
    expect(nameMakers([{ id: "openrouter/auto", name: "Auto Router" }], { key: "openrouter", name: "OpenRouter" }).get("openrouter")).toBe("OpenRouter");
    expect(nameMakers([{ id: "openrouter/auto", name: "OpenRouter: Auto" }], { key: "openrouter", name: "Named elsewhere" }).get("openrouter")).toBe("OpenRouter");
    expect(makerKey("meta-llama/llama-3.1-8b")).toBe("meta-llama");
  });
});

// A month with `n` models from three makers, then `more`, each called once, named by the live list.
async function usagePage(n: number, more: Array<{ id: string; name: string }> = []): Promise<string> {
  const models = [...Array.from({ length: n }, (_, i) => ({ id: `maker-${i % 3}/model-${i}`, name: `Maker ${i % 3}: Model ${i}` })), ...more].map((m) => ({ ...m, tools: true }));
  await writeSnapshot(env.DB, { takenAt: "2026-11-27T07:00:00Z", status: "good", results: [], rows: [], catalog: { version: CATALOG_VERSION, readAt: "2026-11-27T07:00:00.000Z", models } });
  await writeConnection(env.DB, userId, testPlugin(), { method: "oauth_pkce", key_hash: "b".repeat(64) }, NOW);
  await testSecrets().put(userId, "openrouter", "key", ISSUED_KEY, NOW);
  for (const [i, m] of models.entries()) {
    await writeLedgerRow(env.DB, {
      userId, at: NOW, task: "cover_letter", site: "none", provider: "openrouter", model: m.id, region: "global", pluginVersion: "test", status: 200,
      inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, outputTokens: 1, longPrompt: false, durationMs: 1,
      costUsd: 0.01 * (i + 1), costSource: "reported", costedConservatively: {},
    });
  }
  const response = await handleUsage({ db: env.DB, userId, now: NOW, secrets: testSecrets(), plugins: { openrouter: testPlugin() }, fetcher: fakeFetch({ currentKey: () => keyReply({ usage_monthly: 0 }) }) });
  return response.text();
}

describe("the same filter on both pages", () => {
  it("sits in Providers' toolbar, with the chips under it, and every row carries its maker", async () => {
    await writeConnection(env.DB, userId, testPlugin(), { method: "oauth_pkce", key_hash: "a".repeat(64) }, NOW);
    const plugins = { openrouter: testPlugin() };
    const res = await handleProviders(new Request(`${ORIGIN}${PROVIDERS_PATH}`), {
      db: env.DB, plugins, readPlugins: async () => plugins, secrets: testSecrets(), userId, viewer: "owner", appOrigin: ORIGIN, now: NOW, fetcher: fakeFetch(),
    });
    const html = await res.text();
    const toolbar = html.match(/<div class="toolbar">[\s\S]*?<div data-part="err">/)![0];
    expect(toolbar).toContain(MAKER_FILTER_HTML);
    expect(toolbar).toContain(MAKER_CHIPS_HTML);
    // The provider's own router, named by none of its models: the plugin's own name.
    expect(html).toContain('data-id="openrouter/auto" data-maker="openrouter" data-maker-name="Test openrouter"');
    expect(html).toContain('data-id="test-luna" data-maker="test-luna" data-maker-name="test-luna"');
  });

  it("sits beside Usage's Per model search over ten rows, hidden until the script runs, rows named as the live list names their makers", async () => {
    const html = await usagePage(BOX_ROWS + 2);
    const find = html.match(/<div class="find" data-find="by-models" data-noun="models" hidden>[\s\S]*?\n<\/div>/)![0];
    expect(find).toContain(MAKER_FILTER_HTML);
    expect(find).toContain(MAKER_CHIPS_HTML);
    expect(html).toContain('data-maker="maker-2" data-maker-name="Maker 2"');
    expect(html).toContain('<tfoot><tr><th scope="row"><span data-foot-label>This month</span>');
  });

  it("names OpenRouter's own models on Usage as Providers does: by the plug-in's own name", async () => {
    const html = await usagePage(BOX_ROWS + 2, [{ id: "openrouter/auto", name: "Auto Router" }]);
    expect(html).toContain('data-maker="openrouter" data-maker-name="Test openrouter"');
  });

  it("is not on Usage for ten rows or fewer, with no search either", async () => {
    const html = await usagePage(BOX_ROWS);
    const body = html.slice(html.indexOf("<body>"), html.indexOf("<script>"));
    expect(body).toContain('data-maker="maker-0"');
    expect(body).not.toContain("data-maker-filter");
    expect(body).not.toContain("data-find=");
  });
});

const ROWS: ListRow[] = [
  { text: "anthropic: claude opus anthropic/claude-opus anthropic", maker: "anthropic", makerName: "Anthropic" },
  { text: "openai: gpt-4o openai/gpt-4o openai", maker: "openai", makerName: "OpenAI" },
  { text: "anthropic: claude haiku anthropic/claude-haiku anthropic", maker: "anthropic", makerName: "Anthropic" },
  { text: "meta: llama 3 meta-llama/llama-3 meta llama", maker: "meta-llama", makerName: "Meta" },
  // OpenRouter names this ID part "Meta" too: one maker with the row above.
  { text: "meta: muse spark meta/muse-spark meta", maker: "meta", makerName: "Meta" },
];

// Both pages' scripts, on the same rows: the filter behaves the same on each.
const PAGES = [
  ["Models › Usage", () => perModelBox(ROWS)],
  ["Models › Setup › Providers", () => providersTable(ROWS)],
] as const;

describe.each(PAGES)("on %s, the Maker filter", (_, open) => {
  it("lists each maker by name, A to Z, with its count of rows, ID parts named alike as one, and finds one by its name or ID part", () => {
    const p = open();
    p.dispatch("click", p.toggle);
    expect(p.filter.classList.contains("open")).toBe(true);
    expect(p.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(p.makerFind.focused).toBe(1);
    expect(p.listed()).toEqual([
      { key: "Anthropic", name: "Anthropic", n: 2, checked: false },
      { key: "Meta", name: "Meta", n: 2, checked: false },
      { key: "OpenAI", name: "OpenAI", n: 1, checked: false },
    ]);
    p.makerFind.value = "llama";
    p.dispatch("input", p.makerFind);
    expect(p.listed().map((m) => m.name)).toEqual(["Meta"]);
    p.makerFind.value = "zzz";
    p.dispatch("input", p.makerFind);
    expect(p.list.innerHTML).toBe('<li class="none">No maker matches “zzz”.</li>');
    expect(p.sent).toEqual([]);
  });

  it("shows only the chosen makers' rows, each chosen maker a chip, the button counting them", () => {
    const p = open();
    p.dispatch("click", p.toggle);
    p.tick("Anthropic");
    expect(p.shown()).toEqual([0, 2]);
    expect(p.chipKeys()).toEqual(["Anthropic"]);
    expect(p.chips.classList.contains("on")).toBe(true);
    expect(p.chips.innerHTML).toContain('aria-label="Remove Anthropic">Anthropic<svg');
    expect(p.badge.textContent).toBe("1");
    expect(p.toggle.getAttribute("aria-label")).toBe("Maker, 1 chosen");
    expect(p.toggle.classList.contains("on")).toBe(true);
    // The open list keeps its place: the box just ticked stays as it is.
    expect(p.listed().find((m) => m.key === "Anthropic")?.checked).toBe(false);
    p.tick("OpenAI");
    expect(p.shown()).toEqual([0, 1, 2]);
    expect(p.chipKeys()).toEqual(["Anthropic", "OpenAI"]);
    expect(p.chips.innerHTML).toContain("Clear makers");
    p.tick("Anthropic", false);
    expect(p.shown()).toEqual([1]);
    // Reopened, it ticks the chosen ones.
    p.dispatch("click", p.done);
    expect(p.filter.classList.contains("open")).toBe(false);
    expect(p.toggle.focused).toBe(1);
    p.dispatch("click", p.toggle);
    expect(p.listed().filter((m) => m.checked).map((m) => m.key)).toEqual(["OpenAI"]);
    expect(p.sent).toEqual([]);
  });

  it("narrows with the page's search: a row shows only when both let it", () => {
    const p = open();
    p.dispatch("click", p.toggle);
    p.tick("Anthropic");
    p.type("haiku");
    expect(p.shown()).toEqual([2]);
    p.type("gpt");
    expect(p.shown()).toEqual([]);
    p.type("");
    expect(p.shown()).toEqual([0, 2]);
    expect(p.sent).toEqual([]);
  });

  it("drops a maker when its chip is removed, and all of them with Clear makers or the list's Clear", () => {
    const p = open();
    p.dispatch("click", p.toggle);
    p.tick("Anthropic");
    p.tick("Meta");
    p.removeChip("Anthropic");
    expect(p.chipKeys()).toEqual(["Meta"]);
    expect(p.shown()).toEqual([3, 4]);
    expect(p.toggle.focused).toBe(1);
    p.tick("OpenAI");
    p.clearMakers();
    expect(p.chipKeys()).toEqual([]);
    expect(p.chips.classList.contains("on")).toBe(false);
    expect(p.badge.textContent).toBe("");
    expect(p.toggle.getAttribute("aria-label")).toBe("Maker");
    expect(p.shown()).toEqual([0, 1, 2, 3, 4]);
    p.tick("OpenAI");
    p.dispatch("click", p.popClear);
    expect(p.shown()).toEqual([0, 1, 2, 3, 4]);
    expect(p.sent).toEqual([]);
  });

  it("closes on Escape or a click outside it, focus back on Maker", () => {
    const p = open();
    p.dispatch("click", p.toggle);
    p.dispatch("keydown", p.makerFind, "Escape");
    expect(p.filter.classList.contains("open")).toBe(false);
    expect(p.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(p.toggle.focused).toBe(1);
    p.dispatch("click", p.toggle);
    p.dispatch("click", p.outside);
    expect(p.filter.classList.contains("open")).toBe(false);
    expect(p.sent).toEqual([]);
  });
});

describe("with the page's own controls", () => {
  it("on Usage: the count says how many show, and Clear under “No model matches” clears the makers and the search", () => {
    const p = perModelBox(ROWS);
    p.dispatch("click", p.toggle);
    p.tick("Anthropic");
    expect(p.count.textContent).toBe("2 of 5 models");
    p.type("gpt");
    expect(p.none.hidden).toBe(false);
    expect(p.said.textContent).toBe("gpt");
    expect(p.fromMakers.hidden).toBe(false);
    p.dispatch("click", p.clear);
    expect(p.shown()).toEqual([0, 1, 2, 3, 4]);
    expect(p.chipKeys()).toEqual([]);
    expect(p.count.textContent).toBe("5 models");
    expect(p.input.value).toBe("");
  });

  it("on Usage: the search's own Escape clears only the search, and leaves the makers and the open list", () => {
    const p = perModelBox(ROWS);
    p.dispatch("click", p.toggle);
    p.tick("Anthropic");
    p.type("opus");
    expect(p.dispatch("keydown", p.input, "Escape").defaultPrevented).toBe(true);
    expect(p.shown()).toEqual([0, 2]);
    expect(p.filter.classList.contains("open")).toBe(true);
  });

  it("on Usage: while a search or the makers narrow the rows, the month's total reads “All models this month”", () => {
    const p = perModelBox(ROWS);
    expect(p.footLabel.textContent).toBe("This month");
    p.dispatch("click", p.toggle);
    p.tick("Anthropic");
    expect(p.footLabel.textContent).toBe("All models this month");
    p.dispatch("click", p.clear);
    expect(p.footLabel.textContent).toBe("This month");
    p.type("haiku");
    expect(p.footLabel.textContent).toBe("All models this month");
    p.dispatch("keydown", p.input, "Escape");
    expect(p.footLabel.textContent).toBe("This month");
    p.type("gpt");
    p.dispatch("click", p.x);
    expect(p.footLabel.textContent).toBe("This month");
    expect(p.sent).toEqual([]);
  });

  it("on Providers: the count says how many show, and the search's Escape clears only the search", () => {
    const p = providersTable(ROWS);
    p.dispatch("click", p.toggle);
    p.tick("Anthropic");
    expect(p.count.innerHTML).toBe('<b class="num">2</b> of 5');
    p.type("gpt");
    expect(p.added.at(-1)?.innerHTML).toContain("No model matches “gpt” from the makers you picked.");
    expect(p.dispatch("keydown", p.q, "Escape").defaultPrevented).toBe(true);
    expect(p.shown()).toEqual([0, 2]);
    expect(p.filter.classList.contains("open")).toBe(true);
    expect(p.sent).toEqual([]);
  });
});
