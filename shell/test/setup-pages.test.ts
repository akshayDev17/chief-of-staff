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
import { readStrength } from "../src/prices/strength";
import { handleTaskModels } from "../src/models/picker-page";
import { readTaskRoutes } from "../src/models/tasks";
import { SETUP_TABS } from "../src/models/setup-tabs";
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
  // Connected before the tests recordTest makes (09:00), so they ran on this key.
  await writeConnection(env.DB, userId, testPlugin(), { method: "oauth_pkce", key_hash: "a".repeat(64) }, new Date("2026-11-27T08:00:00Z"));
  for (const model of ["test-luna", "test-mini"]) await recordTest(userId, model);
});

// Every screen, rendered for a connected user with two usable models, so each
// shows its dropdowns.
async function screens(): Promise<Record<string, string>> {
  const plugins = { openrouter: testPlugin() };
  const providers = await handleProviders(new Request(`${ORIGIN}${PROVIDERS_PATH}`), {
    db: env.DB, plugins, readPlugins: async () => plugins, secrets: testSecrets(), userId, viewer: "owner", appOrigin: ORIGIN, now: NOW, fetcher: fakeFetch(),
  });
  const budgets = await handleBudgets(new Request(`${ORIGIN}${BUDGETS_PATH}`), env.DB, userId, NOW, { secrets: testSecrets(), fetcher: fakeFetch(), plugins });
  const tasks = await handleTaskModels(new Request(`${ORIGIN}${TASK_MODELS_PATH}`), { db: env.DB, plugins, userId, viewer: "owner", now: NOW });
  return { [PROVIDERS_PATH]: await providers.text(), [BUDGETS_PATH]: await budgets.text(), [TASK_MODELS_PATH]: await tasks.text() };
}

const nextOf = (html: string): string => html.match(/<(?:a|span) class="[^"]*"(?: href="([^"]+)")?(?: aria-disabled="true")? data-next>([^<]+)</)?.slice(1).join("|") ?? "";

describe("Models › Setup", () => {
  it("has its tabs in the setup checklist's order: providers and models, budgets, the model for each task", () => {
    expect(SETUP_TABS.map((t) => t.label)).toEqual(["Providers and models", "Budgets", "Model for each task"]);
  });

  it("chains each screen's Next to the next tab, and gives the last none while the checklist's next item is not built", async () => {
    const html = await screens();
    const chain = SETUP_TABS.map((t) => nextOf(html[t.href]!));
    expect(chain).toEqual([
      `${SETUP_TABS[1]!.href}|Next: ${SETUP_TABS[1]!.nextName}`,
      `${SETUP_TABS[2]!.href}|Next: ${SETUP_TABS[2]!.nextName}`,
      // The checklist's next item is not built: no button that leads nowhere.
      "",
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
    expect([...strip.matchAll(/<button type="button" class="cell" data-filter="(\w+)"/g)].map((m) => m[1])).toEqual(["ready", "credit", "step"]);
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

  it("keeps a row the user changed as they chose it when Accept all is tapped, saved with the tap in one request", async () => {
    const html = (await screens())[TASK_MODELS_PATH]!;
    const doc = documentOf(html);
    const sent: Sent = [];
    const plugins = { openrouter: testPlugin() };
    // The page's own handler answers the script's request.
    runScript(pageScripts(html), doc, `${ORIGIN}${TASK_MODELS_PATH}`, sent, {
      window: { addEventListener: () => {}, FormData },
      fetch: (url, init) =>
        handleTaskModels(new Request(new URL(url, ORIGIN), { method: init?.method, body: init?.body, headers: { ...(init?.headers as Record<string, string>), origin: ORIGIN } }), { db: env.DB, plugins, userId, viewer: "owner", now: NOW }),
    });
    // Matching questions waits for its proposal, test-luna with test-mini; the user chooses test-mini as its main model.
    expect(doc.querySelector("#task-match .pill:not([title])")!.textContent).toBe("Proposed");
    doc.fire("click", doc.getElementById("pb-main-match")!);
    doc.fire("click", doc.querySelector('#pl-main-match li[data-value="openrouter|test-mini"]')!);
    expect(doc.getElementById("savebar")!.querySelector(".sb-n")!.textContent).toBe("1 task changed");
    const accept = doc.querySelector(`form[action="${TASK_MODELS_PATH}/accept"]`)!;
    expect(doc.fire("submit", accept)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([`fetch ${TASK_MODELS_PATH}/accept`]);
    const { routes } = await readTaskRoutes(env.DB, { openrouter: testPlugin() }, userId);
    const now = (task: string) => { const c = routes.find((r) => r.task.id === task)!.current!; return [c.main.model, c.fallback?.model, c.setHow]; };
    expect(now("match")).toEqual(["test-mini", "test-luna", "changed"]);
    expect(now("extract")).toEqual(["test-luna", "test-mini", "accepted"]);
    expect(now("linkedin_message")).toEqual(["test-luna", "test-mini", "accepted"]);
    // The answer, in place, shows the user's choice and says both.
    expect(doc.getElementById("main-match")!.value).toBe("openrouter|test-mini");
    expect(doc.getElementById("savebar")!.querySelector(".sb-n")!.textContent).toBe("Saved: Matching questions. Accepted: 2 tasks use their proposed models.");
  });

  it("saves nothing when a friend asks Admin for help with a row changed, and keeps the row changed on the page", async () => {
    const plugins = { openrouter: testPlugin() };
    const handle = (req: Request) => handleTaskModels(req, { db: env.DB, plugins, userId, viewer: "friend", now: NOW });
    const html = await (await handle(new Request(`${ORIGIN}${TASK_MODELS_PATH}`))).text();
    const doc = documentOf(html);
    const sent: Sent = [];
    let posted: FormData | undefined;
    runScript(pageScripts(html), doc, `${ORIGIN}${TASK_MODELS_PATH}`, sent, {
      window: { addEventListener: () => {}, FormData },
      fetch: (url, init) => {
        posted = init?.body as FormData;
        return handle(new Request(new URL(url, ORIGIN), { method: init?.method, body: init?.body, headers: { ...(init?.headers as Record<string, string>), origin: ORIGIN } }));
      },
    });
    doc.fire("click", doc.getElementById("pb-main-match")!);
    doc.fire("click", doc.querySelector('#pl-main-match li[data-value="openrouter|test-mini"]')!);
    expect(doc.fire("submit", doc.querySelector(`form[action="${TASK_MODELS_PATH}/help"]`)!)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([`fetch ${TASK_MODELS_PATH}/help`]);
    expect([...posted!.entries()]).toEqual([]);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM task_routes WHERE user_id = ?").bind(userId).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT item FROM help_requests WHERE user_id = ?").bind(userId).all()).results).toEqual([{ item: "Model for each task" }]);
    // The banner says it was sent; the row and its bar are as the user left them.
    expect(doc.querySelector('[data-part="banner"]')!.textContent).toBe("Sent to Admin: this item's name and its reason only.");
    expect(doc.getElementById("main-match")!.value).toBe("openrouter|test-mini");
    expect(doc.getElementById("task-match")!.hasAttribute("data-dirty")).toBe(true);
    const bar = doc.getElementById("savebar")!;
    expect([bar.hidden, bar.querySelector(".sb-n")!.textContent]).toEqual([false, "1 task changed"]);
  });

  it("leaves no button disabled with nothing in flight: a tap while help is waiting sends nothing, and help's answer gives both back", async () => {
    const plugins = { openrouter: testPlugin() };
    const handle = (req: Request) => handleTaskModels(req, { db: env.DB, plugins, userId, viewer: "friend", now: NOW });
    const html = await (await handle(new Request(`${ORIGIN}${TASK_MODELS_PATH}`))).text();
    const doc = documentOf(html);
    const sent: Sent = [];
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    runScript(pageScripts(html), doc, `${ORIGIN}${TASK_MODELS_PATH}`, sent, {
      window: { addEventListener: () => {}, FormData },
      fetch: async (url, init) => {
        if (url.endsWith("/help")) await held;
        return handle(new Request(new URL(url, ORIGIN), { method: init?.method, body: init?.body, headers: { ...(init?.headers as Record<string, string>), origin: ORIGIN } }));
      },
    });
    doc.fire("click", doc.getElementById("pb-main-match")!);
    doc.fire("click", doc.querySelector('#pl-main-match li[data-value="openrouter|test-mini"]')!);
    const button = (action: string) => doc.querySelector(`form[action="${TASK_MODELS_PATH}/${action}"] button`)!;
    doc.fire("submit", doc.querySelector(`form[action="${TASK_MODELS_PATH}/help"]`)!);
    expect(button("help").disabled).toBe(true);
    // Accept, tapped while help waits for its answer, sends nothing and stays tappable.
    doc.fire("submit", doc.querySelector(`form[action="${TASK_MODELS_PATH}/accept"]`)!);
    expect(sent).toEqual([`fetch ${TASK_MODELS_PATH}/help`]);
    expect(button("accept").disabled).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(doc.querySelector('[data-part="banner"]')!.textContent).toBe("Sent to Admin: this item's name and its reason only.");
    expect([button("help").disabled, button("accept").disabled]).toEqual([false, false]);
    // The row is still changed, and Accept now saves it with the tap.
    doc.fire("submit", doc.querySelector(`form[action="${TASK_MODELS_PATH}/accept"]`)!);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([`fetch ${TASK_MODELS_PATH}/help`, `fetch ${TASK_MODELS_PATH}/accept`]);
    const { routes } = await readTaskRoutes(env.DB, { openrouter: testPlugin() }, userId);
    expect(routes.find((r) => r.task.id === "match")!.current!.main.model).toBe("test-mini");
  });

  it("opens Providers showing one strength's models in one state when the address asks, as an empty strength's link does, with Show all", async () => {
    const html = (await screens())[PROVIDERS_PATH]!;
    // Every row carries its strength chip.
    expect(html).toMatch(/<li class="row" id="m-test-luna"[^>]* data-state="ready" data-strength="Smallest"/);
    expect(html).toMatch(/<li class="row" id="m-test-sonnet"[^>]* data-state="ready" data-strength="Strongest"/);
    const doc = documentOf(html);
    const sent: Sent = [];
    const win = { addEventListener: () => {}, fetch: () => {}, history: {}, setTimeout: () => 0, clearTimeout: () => {} };
    runScript(pageScripts(html), doc, `${ORIGIN}${PROVIDERS_PATH}?provider=openrouter&strength=Strongest&show=ready#test`, sent, { window: win });
    const shown = () => doc.querySelectorAll("#pick-list > li.row").filter((li) => !li.hidden).map((li) => li.getAttribute("data-id"));
    expect(shown()).toEqual(["test-sonnet"]);
    expect(doc.getElementById("pick-count")!.textContent).toBe("1 Strongest models ready · Show all");
    doc.fire("click", doc.querySelector("[data-show-all]")!);
    expect(shown().length).toBe(doc.querySelectorAll("#pick-list li.row").length);
    expect(sent).toEqual([]);
  });

  it("sends nothing and loads nothing when Admin · Price table's sort select changes; its Sort button sends the form", async () => {
    const snapshot = (await currentSnapshot(env.DB))!;
    const html = renderPriceTablePage({ snapshot, rows: await readSnapshotRows(env.DB, snapshot.id), alerts: await recentAlerts(env.DB), sort: { column: "provider", dir: "asc" }, strength: await readStrength(env.DB, snapshot) });
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
