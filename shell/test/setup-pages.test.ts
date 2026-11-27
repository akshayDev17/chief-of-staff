// The three Models › Setup screens together: the Next chain follows the tab
// order exactly (the owner, 2026-11-27), and no dropdown on them sends a
// request or loads a page when it changes (the owner, 2026-11-27: "upon
// changing a model in the dropdwon, i believe some request is sent"): each
// page's own script runs against a stand-in DOM (script-dom.ts) that records
// every submit, navigation and request (mini-dom.ts builds the DOM from the
// page's own HTML). Budgets has no dropdown; Providers has none either, and
// its filters are buttons outside any form.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleTaskModels } from "../src/models/picker-page";
import { AFTER_SETUP_TABS, SETUP_TABS } from "../src/models/setup-tabs";
import { handleProviders } from "../src/providers/page";
import { handleBudgets } from "../src/proxy/budgets-page";
import { writeConnection } from "../src/proxy/connections";
import { BUDGETS_PATH, PROVIDERS_PATH, TASK_MODELS_PATH } from "../src/paths";
import { fakeFetch } from "./fake-sources";
import { documentOf } from "./mini-dom";
import { element, fireInline, pageScripts, runScript, type Sent } from "./script-dom";
import { renderPriceTablePage } from "../src/prices/page";
import { currentSnapshot, readSnapshotRows, recentAlerts } from "../src/prices/store";
import { recordTest, seedPrices, testPlugin, testSecrets, userFor } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
const ORIGIN = "https://cos.example.com";
let userId: string;

beforeEach(async () => {
  await seedPrices();
  userId = (await userFor("owner-sub")).id;
  await writeConnection(env.DB, userId, testPlugin(), { method: "oauth_pkce", key_hash: "a".repeat(64) }, NOW);
  for (const model of ["test-luna", "test-mini"]) await recordTest(userId, model);
});

// Every screen, rendered for a connected user with two usable models, so each
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
    // Each screen shows the same tabs, in order, itself marked current.
    for (const t of SETUP_TABS) {
      const line = html[t.href]!.match(/<nav class="(?:small setup-tabs|tabs)"[^>]*>(.*?)<\/nav>/)![1]!;
      expect([...line.matchAll(/<(?:a|span|strong)\b[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(SETUP_TABS.map((x) => x.label));
      expect(line).toMatch(new RegExp(`aria-current="page">${t.label}<`));
    }
  });

  it("has no dropdown on Providers: search, Maker and the strip are buttons and a search box outside any form", async () => {
    const html = (await screens())[PROVIDERS_PATH]!;
    expect(html).not.toContain("<select");
    const toolbar = html.match(/<div class="toolbar">[\s\S]*?<div class="chips"/)![0];
    expect(toolbar).not.toContain("<form");
    expect(toolbar).toContain('<input type="search" id="pick-q"');
    const strip = html.match(/<div class="strip-wrap" data-part="strip">[\s\S]*?<\/div>\n<div class="list-head"/)![0];
    expect(strip).not.toContain("<form");
    expect([...strip.matchAll(/<button type="button" class="cell" data-filter="(\w+)"/g)].map((m) => m[1])).toEqual(["works", "fails", "pending"]);
  });

  it("sends nothing and loads nothing when a task's model is chosen, and Save sends the changed rows once, in place", async () => {
    const html = (await screens())[TASK_MODELS_PATH]!;
    const doc = documentOf(html);
    const sent: Sent = [];
    let posted: FormData | undefined;
    const answer = '<div data-part="banner"><div class="banner ok" role="status" tabindex="-1">Saved: Matching questions.</div></div><div class="savebar" id="savebar" hidden><p class="sb-n"></p><p class="sb-err"></p></div>';
    runScript(pageScripts(html), doc, `${ORIGIN}${TASK_MODELS_PATH}`, sent, {
      window: { addEventListener: () => {}, FormData },
      fetch: async (_url, init) => { posted = init?.body as FormData; return Response.json({ main: answer }); },
    });
    // Matching questions is proposed test-luna, with test-mini as its fallback.
    const main = doc.getElementById("main-match")!, fallback = doc.getElementById("fallback-match")!;
    expect([main.value, fallback.value]).toEqual(["openrouter|test-luna", "openrouter|test-mini"]);
    const open = doc.getElementById("pb-main-match")!;
    doc.fire("click", open);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    // Choosing its fallback as the main model swaps the two.
    doc.fire("click", doc.querySelector('#pl-main-match li[data-value="openrouter|test-mini"]')!);
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect([main.value, fallback.value]).toEqual(["openrouter|test-mini", "openrouter|test-luna"]);
    expect(open.textContent).toContain("Test Mini");
    // The fallback list hides the main model.
    expect(doc.querySelector('#pl-fallback-match li[data-value="openrouter|test-mini"]')!.hidden).toBe(true);
    const bar = doc.getElementById("savebar")!;
    expect([bar.hidden, bar.querySelector(".sb-n")!.textContent]).toEqual([false, "1 task changed"]);
    // Save is now the one solid blue button.
    expect(doc.querySelectorAll(".btn.primary").map((b) => b.textContent)).toEqual(["Save"]);
    expect(sent).toEqual([]);
    // Undo puts every row back; choosing again marks it again.
    doc.fire("click", bar.querySelector("[data-undo]")!);
    expect([main.value, fallback.value, bar.hidden]).toEqual(["openrouter|test-luna", "openrouter|test-mini", true]);
    expect(doc.querySelectorAll(".btn.primary").map((b) => b.textContent)).toEqual(["Accept all with one tap", "Save"]);
    doc.fire("click", open);
    doc.fire("keydown", doc.querySelector("#pl-main-match")!, "ArrowDown");
    doc.fire("keydown", doc.querySelector("#pl-main-match")!, "Enter");
    expect(main.value).toBe("openrouter|test-mini");
    expect(sent).toEqual([]);
    doc.fire("click", bar.querySelector("[data-save]")!);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([`fetch ${TASK_MODELS_PATH}/change`]);
    expect([...posted!.entries()]).toEqual([["task", "match"], ["main.match", "openrouter|test-mini"], ["fallback.match", "openrouter|test-luna"]]);
    expect(doc.getElementById("screen")!.textContent).toContain("Saved: Matching questions.");
    // The swapped-in page's bar says it too, where the user is looking.
    expect(doc.getElementById("savebar")!.hidden).toBe(false);
    expect(doc.getElementById("savebar")!.querySelector(".sb-n")!.textContent).toBe("Saved: Matching questions.");
  });

  it("opens Providers showing one strength's models not tested yet when the address asks, as an empty strength's link does, with Show all", async () => {
    const html = (await screens())[PROVIDERS_PATH]!;
    // Every row carries its strength chip.
    expect(html).toMatch(/<li class="row" id="m-test-luna"[^>]* data-state="works" data-strength="Smallest"/);
    expect(html).toMatch(/<li class="row" id="m-test-sonnet"[^>]* data-state="pending" data-strength="Strongest"/);
    const doc = documentOf(html);
    const sent: Sent = [];
    const win = { addEventListener: () => {}, fetch: () => {}, history: {}, setTimeout: () => 0, clearTimeout: () => {} };
    runScript(pageScripts(html), doc, `${ORIGIN}${PROVIDERS_PATH}?provider=openrouter&strength=Strongest&show=pending#test`, sent, { window: win });
    const shown = () => doc.querySelectorAll("#pick-list > li.row").filter((li) => !li.hidden).map((li) => li.getAttribute("data-id"));
    expect(shown()).toEqual(["test-sonnet"]);
    expect(doc.getElementById("pick-count")!.textContent).toBe("1 Strongest models not tested yet · Show all");
    doc.fire("click", doc.querySelector("[data-show-all]")!);
    expect(shown().length).toBe(doc.querySelectorAll("#pick-list li.row").length);
    expect(sent).toEqual([]);
  });

  it("sends nothing and loads nothing when Admin · Price table's sort select changes; its Sort button sends the form", async () => {
    const snapshot = (await currentSnapshot(env.DB))!;
    const html = renderPriceTablePage({ snapshot, rows: await readSnapshotRows(env.DB, snapshot.id), alerts: await recentAlerts(env.DB), sort: { column: "provider", dir: "asc" } });
    const sent: Sent = [];
    const form = { submit: () => sent.push("submit"), requestSubmit: () => sent.push("submit") };
    const select = Object.assign(element({ id: "price-sort" }), { form, value: "input-desc" });
    runScript(pageScripts(html), { querySelectorAll: () => [], querySelector: () => null, getElementById: (id: string) => (id === "price-sort" ? select : null) }, `${ORIGIN}/chief-of-staff/admin/prices`, sent);
    select.fire("change");
    fireInline(html, "price-sort", "change", select);
    fireInline(html, "price-sort", "input", select);
    expect(sent).toEqual([]);
    const sortForm = html.match(/<form class="sort-by" method="get">[\s\S]*?<\/form>/)![0];
    expect(sortForm).toMatch(/<button type="submit"[^>]*>Sort<\/button>/);
    expect(sortForm).not.toContain("<noscript>");
  });
});
