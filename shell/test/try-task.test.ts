// Try it on Model for each task, end to end through the real OpenRouter
// plug-in against a stand-in OpenRouter (the owner, 2026-11-28: "the
// pipeline that each task will eventually have to subscribe to and use is
// the one being tested"): a spent budget sends no model request; an answer is one
// ledger row naming the model that answered, with OpenRouter's own tokens
// and cost; a failed main model gets exactly one retry on the fallback and
// is marked Failed when used; a router's call carries its price cap; and the
// task's saved choice is never written. Every model is picked from the
// fixture's list by the app's own rules, never named.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleTaskModels } from "../src/models/picker-page";
import { readLatestTests } from "../src/models/latest-tests";
import { savePriceCap } from "../src/models/price-caps";
import { changeTasks, modelKey, offeredFor, readTaskRoutes, taskById, TASKS, type Offered } from "../src/models/tasks";
import { tryTask, TRY_MAX_TOKENS } from "../src/models/try-task";
import { TASK_MODELS_PATH } from "../src/paths";
import { refreshPrices } from "../src/prices/refresh";
import { readCurrentCatalog } from "../src/prices/store";
import { providerPlugins } from "../src/providers/index";
import { handleProviders } from "../src/providers/page";
import { vaultSecrets } from "../src/providers/secrets";
import { setBudget } from "../src/proxy/budgets";
import { writeLedgerRow } from "../src/proxy/ledger";
import { chatReply, fakeFetch, type Sent } from "./fake-sources";
import { userFor, VAULT_KEY } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
const ORIGIN = "https://cos.example.com";
const ENV = { APP_ORIGIN: ORIGIN, VAULT_KEY };

let userId: string;
let fetcher: ReturnType<typeof fakeFetch>;
// Chat Completions as the stand-in answers it; a test swaps it.
let chat: (s: Sent) => Response | Promise<Response>;

const plugins = async () => providerPlugins(ENV, vaultSecrets(env.DB, ENV), await readCurrentCatalog(env.DB), fetcher);
const chatSent = () => fetcher.sent.filter((s) => s.url.endsWith("/chat/completions"));
const chatModels = () => chatSent().map((s) => (s.body as { model: string }).model);
const ledger = async () =>
  (await env.DB.prepare("SELECT task, model, fallback, input_tokens, cached_input_tokens, output_tokens, cost_usd, cost_source, provider_call_id FROM model_calls WHERE user_id = ? ORDER BY id").bind(userId).all()).results;
const saved = async () => (await env.DB.prepare("SELECT * FROM task_routes WHERE user_id = ? ORDER BY task").bind(userId).all()).results;
const tryIt = async (task = "match") => tryTask(env.DB, await plugins(), userId, task, () => NOW);
const noEndpoints = () => Response.json({ error: { code: 404, message: "No endpoints found matching your data policy" } }, { status: 404 });

// The two cheapest paid Ready models of Matching questions' strength, by the app's own rule.
let main: Offered;
let fallback: Offered;

beforeEach(async () => {
  chat = (s) => chatReply({ model: (s.body as { model: string }).model, id: "gen-try-1", choices: [{ message: { role: "assistant", content: "Used SQL daily for 4 years" } }] }, { prompt_tokens: 61, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 5 }, cost: 0.0000123 });
  fetcher = fakeFetch({ chat: (s) => chat(s) });
  await refreshPrices({ db: env.DB, fetcher, now: new Date("2026-11-27T06:00:00Z") });
  userId = (await userFor("owner-sub")).id;
  // Connect OpenRouter as a user does: the consent page, then back.
  const handle = async (request: Request) =>
    handleProviders(request, { db: env.DB, plugins: await plugins(), readPlugins: plugins, secrets: vaultSecrets(env.DB, ENV), userId, viewer: "owner", appOrigin: ORIGIN, now: NOW, fetcher });
  const base = `${ORIGIN}/chief-of-staff/models/setup/providers`;
  const auth = new URL((await handle(new Request(`${base}/openrouter/connect`, { method: "POST", headers: { origin: ORIGIN }, body: new URLSearchParams() }))).headers.get("location")!);
  await handle(new Request(`${base}/openrouter/consented?code=code-1&state=${auth.searchParams.get("state")}`));
  const { offered } = await readTaskRoutes(env.DB, await plugins(), userId);
  [main, fallback] = offeredFor(taskById("match")!, offered).filter((m) => !m.free) as [Offered, Offered];
  expect(main && fallback).toBeTruthy();
  expect(await changeTasks(env.DB, await plugins(), userId, [{ task: "match", main: modelKey(main), fallback: modelKey(fallback) }], NOW)).toBeUndefined();
  await setBudget(env.DB, userId, "openrouter", 5, "typed", NOW);
  fetcher.sent.length = 0;
});

describe("Try it", () => {
  it("refuses a spent budget, or none set, with no request to the model", async () => {
    await writeLedgerRow(env.DB, {
      userId, at: NOW, task: "score", site: "none", provider: "openrouter", model: main.model, region: "global", pluginVersion: "x", status: 200,
      inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, outputTokens: 1, longPrompt: false, durationMs: 1, costUsd: 5, costSource: "reported", costedConservatively: {},
    });
    expect(await tryIt()).toMatchObject({ kind: "refused", reason: "This month's budget is spent. Calls resume 1 December.", action: { label: "Raise the budget" }, failed: [] });
    expect(chatSent()).toEqual([]);
    await env.DB.prepare("DELETE FROM provider_budgets WHERE user_id = ?").bind(userId).run();
    expect(await tryIt()).toMatchObject({ kind: "refused", reason: "Set a monthly budget for OpenRouter first.", action: { label: "Set a budget" }, failed: [] });
    expect(chatSent()).toEqual([]);
  });

  it("sends the task's sample prompt to its saved main model only, and writes one usage row naming the model that answered, with OpenRouter's own tokens and cost", async () => {
    const before = await saved();
    const out = await tryIt();
    expect(out).toMatchObject({
      kind: "answered", role: "main", model: { model: main.model }, text: "Used SQL daily for 4 years",
      usage: { input: 56, cachedInput: 5, output: 9 }, costUsd: 0.0000123, costReported: true, callId: "gen-try-1",
      month: { spentUsd: 0.0000123, budgetUsd: 5 },
    });
    expect(chatModels()).toEqual([main.model]);
    expect(chatSent()[0]!.body).toMatchObject({ messages: [{ role: "user", content: taskById("match")!.sample }], max_tokens: TRY_MAX_TOKENS });
    expect(await ledger()).toEqual([
      { task: "match", model: main.model, fallback: 0, input_tokens: 56, cached_input_tokens: 5, output_tokens: 9, cost_usd: 0.0000123, cost_source: "reported", provider_call_id: "gen-try-1" },
    ]);
    expect(await saved()).toEqual(before);
  });

  it("retries a failed main model once on the fallback and marks the main Failed when used; a fallback that fails too stops there", async () => {
    chat = (s) => ((s.body as { model: string }).model === main.model ? noEndpoints() : chatReply({ model: (s.body as { model: string }).model }));
    const out = await tryIt();
    expect(out).toMatchObject({ kind: "answered", role: "fallback", model: { model: fallback.model }, mainFailed: { model: main.model, marked: true } });
    expect(chatModels()).toEqual([main.model, fallback.model]);
    expect((await ledger()).map((r) => [r.model, r.fallback])).toEqual([[main.model, 0], [fallback.model, 1]]);
    expect((await readLatestTests(env.DB, userId, "openrouter")).get(main.model)).toMatchObject({ state: "failed", result: { used: true, reply: { status: 404 } } });

    fetcher.sent.length = 0;
    chat = () => noEndpoints();
    const both = await tryIt();
    expect(both).toMatchObject({ kind: "refused", failed: [{ model: main.model, marked: true }, { model: fallback.model, marked: true }] });
    expect(chatModels()).toEqual([main.model, fallback.model]);
  });

  it("says both when the main fails and the fallback is then refused before sending, with the fallback's fix", async () => {
    // Another call spends the month's budget while the main model's is out.
    chat = async () => {
      await writeLedgerRow(env.DB, {
        userId, at: NOW, task: "score", site: "none", provider: "openrouter", model: main.model, region: "global", pluginVersion: "x", status: 200,
        inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, outputTokens: 1, longPrompt: false, durationMs: 1, costUsd: 5, costSource: "reported", costedConservatively: {},
      });
      return noEndpoints();
    };
    const spent = "This month's budget is spent. Calls resume 1 December.";
    expect(await tryIt()).toMatchObject({
      kind: "refused", reason: spent, action: { label: "Raise the budget" },
      failed: [{ role: "main", model: main.model, marked: true }, { role: "fallback", model: fallback.model, reason: spent, marked: false }],
    });
    expect(chatModels()).toEqual([main.model]);

    // As shown under the row: each model by its role, the main's mark, the fallback's fix.
    await env.DB.prepare("DELETE FROM model_calls WHERE user_id = ?").bind(userId).run();
    const res = await handleTaskModels(
      new Request(`${ORIGIN}${TASK_MODELS_PATH}/try`, { method: "POST", headers: { origin: ORIGIN, accept: "application/json" }, body: new URLSearchParams([["task", "match"]]) }),
      { db: env.DB, plugins: await plugins(), userId, viewer: "owner", now: NOW },
    );
    const { tried } = (await res.json()) as { tried: string };
    expect(tried).toContain("<strong>Not answered.</strong> Main model and fallback both failed.");
    expect(tried).toContain(`<li>Main model ${main.name}: `);
    expect(tried).toContain(`Marked Failed when used.</li><li>Fallback ${fallback.name}: This month&#39;s budget is spent. Calls resume 1 December.</li>`);
    expect(tried).toContain(">Raise the budget</a>");
  });

  it("carries a router's price cap on its call", async () => {
    const p = await plugins();
    const router = (await readCurrentCatalog(env.DB))!.models.find((m) => p.openrouter!.connect.isRouter?.(m.id))!.id;
    await savePriceCap(env.DB, userId, "openrouter", router, { input: 0.3, output: 1.2 }, NOW);
    await env.DB.prepare("UPDATE task_routes SET main_model = ?, fallback_model = NULL, fallback_provider = NULL WHERE user_id = ? AND task = 'match'").bind(router, userId).run();
    chat = () => chatReply({ model: "picked/by-the-router" });
    expect(await tryIt()).toMatchObject({ kind: "answered", role: "main", model: { model: router }, picked: "picked/by-the-router" });
    expect(chatSent().map((s) => s.body)).toEqual([
      expect.objectContaining({ model: router, provider: expect.objectContaining({ max_price: { prompt: "0.3", completion: "1.2", request: "0", image: "0", audio: "0" } }) }),
    ]);
  });

  it("shows its result under the row in place, or on the page without the script, and never writes the task's saved choices", async () => {
    const before = await saved();
    const post = async (json: boolean, task = "match") =>
      handleTaskModels(
        new Request(`${ORIGIN}${TASK_MODELS_PATH}/try`, { method: "POST", headers: { origin: ORIGIN, ...(json ? { accept: "application/json" } : {}) }, body: new URLSearchParams([["task", task], ["main.match", modelKey(fallback)], ["fallback.match", ""]]) }),
        { db: env.DB, plugins: await plugins(), userId, viewer: "owner", now: NOW },
      );
    const inPlace = (await (await post(true)).json()) as { task: string; tried: string };
    expect(inPlace.task).toBe("match");
    expect(inPlace.tried).toContain(`<strong>${main.name}</strong> answered · main model`);
    expect(inPlace.tried).toContain('<p class="tr-reply">Used SQL daily for 4 years</p>');
    expect(inPlace.tried).toContain("<dt>Input</dt><dd class=\"num\">56</dd>");
    expect(inPlace.tried).toContain("<dt>Cost</dt><dd class=\"num\">$0.0000123</dd>");
    expect(inPlace.tried).toContain("This month under $0.01 of your $5 budget");
    // Without the script: the whole page, the result under its own row only.
    const page = await (await post(false)).text();
    const row = (id: string) => page.slice(page.indexOf(`<li class="task" id="task-${id}"`), page.indexOf("</form></li>", page.indexOf(`<li class="task" id="task-${id}"`)));
    expect(row("match")).toContain('<div class="try-out" id="try-match" aria-live="polite"><div class="result ok tr" role="status">');
    expect(row("match")).toContain('formaction="/chief-of-staff/models/setup/tasks/try" data-try');
    // A task with no saved model has no Try it.
    expect(row("score")).not.toContain("data-try");
    // The fields the row's form carries are never saved by Try it.
    expect(await saved()).toEqual(before);
    expect(chatModels()).toEqual([main.model, main.model]);
  });

  it("has a short fixed sample prompt for every task, naming no model", async () => {
    const ids = (await readCurrentCatalog(env.DB))!.models.map((m) => m.id);
    for (const t of TASKS) {
      expect(t.sample.length).toBeGreaterThan(20);
      expect(t.sample.length).toBeLessThan(240);
      expect(ids.some((id) => t.sample.includes(id))).toBe(false);
    }
  });
});
