// A $0 OpenRouter account, end to end (the owner, 2026-11-27: "can i for now
// w.r.t. openrouter use only the free models ... because i think i dont need
// to put in any money for the entire COS --> openrouter testing flow"). The
// account's /models/user list is the captured fixture, free and paid entries
// both, with Google's Lyria music model listed at $0 a token; OpenRouter
// refuses every paid model with 402 and answers the free one. Connect makes
// no call; the account line says the account never bought credits; the free
// model is labelled Free and passes its test; a paid one says it needs
// credit, with Add credits; the music model is never tested; Test all models
// says the paid ones need credit; and the free model that passed is usable
// for every task in one step.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { handleTaskModels } from "../src/models/picker-page";
import { routeTask, TASKS } from "../src/models/tasks";
import { FRESH_LIST_WAIT, readTestAll, runQueuedTests } from "../src/models/test-all";
import { refreshPrices } from "../src/prices/refresh";
import { readCurrentCatalog } from "../src/prices/store";
import { isTrulyFreeTextModel } from "../src/prices/openrouter";
import { providerPlugins } from "../src/providers/index";
import { handleProviders } from "../src/providers/page";
import { vaultSecrets } from "../src/providers/secrets";
import { fakeFetch, keyReply, MODELS, type Overrides, type Sent } from "./fake-sources";
import { userFor, VAULT_KEY } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
const ORIGIN = "https://cos.example.com";
const BASE = `${ORIGIN}/chief-of-staff/models/setup/providers`;
const TASKS_URL = `${ORIGIN}/chief-of-staff/models/setup/tasks`;
const ENV = { APP_ORIGIN: ORIGIN, VAULT_KEY };

// The fixture's one free entry, found by the app's own rule, never named.
const FREE = MODELS.data.find((m) => isTrulyFreeTextModel(m))!.id;
// The captured music model: "0" a token, but it gives audio and is charged per clip.
const MUSIC = MODELS.data.find((m) => m.architecture.output_modalities.includes("audio"))!.id;
const isFreeModel = (id: string) => id === FREE;

const NO_CREDIT = { error: { code: 402, message: "Insufficient credits. This account never purchased credits. Make sure your key is on the correct account or org, and if so, purchase more at https://openrouter.ai/settings/credits" } };
const chatAsZeroAccount = (s: Sent) => {
  const model = (s.body as { model: string }).model;
  return isFreeModel(model)
    ? Response.json({ id: "gen-free-1", model, choices: [{ message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 12, completion_tokens: 1, cost: 0 } })
    : Response.json(NO_CREDIT, { status: 402 });
};

let userId: string;
let fetcher: ReturnType<typeof fakeFetch>;

const plugins = async () => providerPlugins(ENV, vaultSecrets(env.DB, ENV), await readCurrentCatalog(env.DB), fetcher);
const handle = async (request: Request, now = NOW) =>
  handleProviders(request, { db: env.DB, plugins: await plugins(), readPlugins: plugins, secrets: vaultSecrets(env.DB, ENV), userId, viewer: "owner", appOrigin: ORIGIN, now, fetcher });
const post = (path: string, fields: Record<string, string> = {}, json = false) =>
  handle(new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers: { origin: ORIGIN, ...(json ? { accept: "application/json" } : {}) } }));
const tested = async (model: string) => ((await (await post("/openrouter/test", { model }, true)).json()) as { main: string }).main;
const get = (path = "", now = NOW) => handle(new Request(`${BASE}${path}`), now);
const tasks = async (path = "", fields?: Record<string, string>) =>
  handleTaskModels(
    fields ? new Request(`${TASKS_URL}${path}`, { method: "POST", body: new URLSearchParams(fields), headers: { origin: ORIGIN } }) : new Request(`${TASKS_URL}${path}`),
    { db: env.DB, plugins: await plugins(), userId, viewer: "owner", now: NOW },
  );

async function connect(overrides: Overrides): Promise<Response> {
  fetcher = fakeFetch(overrides);
  const auth = new URL((await post("/openrouter/connect")).headers.get("location")!);
  return get(`/openrouter/consented?code=code-1&state=${auth.searchParams.get("state")}`);
}

// One model's row in the table.
const entry = (html: string, id: string): string => {
  const at = html.indexOf(`<li class="row" id="`);
  const start = html.indexOf(`data-id="${id}"`, at);
  return start < 0 ? "" : html.slice(html.lastIndexOf("<li", start), html.indexOf("</li>", start));
};

const after = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const modelListReads = () => fetcher.sent.filter((s) => s.url === "https://openrouter.ai/api/v1/models").length;

// The current list as the previous Worker stored it: no version, the music
// model callable, and no model marked free.
async function storeOldCatalog(): Promise<{ models: Array<{ id: string; blocked?: string; free?: true }> }> {
  const stored = (await env.DB.prepare("SELECT snapshot_id, catalog FROM openrouter_catalogs ORDER BY snapshot_id DESC LIMIT 1").first<{ snapshot_id: number; catalog: string }>())!;
  const old = JSON.parse(stored.catalog) as { version?: number; models: Array<{ id: string; blocked?: string; free?: true }> };
  delete old.version;
  for (const m of old.models) delete m.free;
  // The old rules listed the music model as callable.
  old.models.push({ id: MUSIC });
  await env.DB.prepare("UPDATE openrouter_catalogs SET catalog = ? WHERE snapshot_id = ?").bind(JSON.stringify(old), stored.snapshot_id).run();
  return old;
}

const chatModels = () => fetcher.sent.filter((s) => s.url.endsWith("/chat/completions")).map((s) => (s.body as { model: string }).model);

beforeEach(async () => {
  fetcher = fakeFetch();
  await refreshPrices({ db: env.DB, fetcher, now: new Date("2026-11-27T06:00:00Z") });
  userId = (await userFor("owner-sub")).id;
});

afterEach(() => vi.restoreAllMocks());

// The every-minute cron, with OpenRouter answered by `f`.
const minuteCron = (at: Date, f: typeof fetch) => {
  vi.spyOn(globalThis, "fetch").mockImplementation(f);
  return worker.scheduled({ cron: "* * * * *", scheduledTime: at.getTime(), noRetry: () => {} } as ScheduledController, { ...ENV, DB: env.DB });
};

const FREE_TIER_KEY = () => keyReply({ is_free_tier: true, limit: 10, limit_remaining: 10, free_model_daily_requests: { used: 17, limit: 50, remaining: 33 } });

describe("a $0 OpenRouter account", () => {
  it("connects with no call made, and says the account never bought credits", async () => {
    expect((await connect({ chat: chatAsZeroAccount, currentKey: FREE_TIER_KEY })).status).toBe(303);
    expect(chatModels()).toEqual([]);
    const html = await (await get()).text();
    expect(html).toContain("<strong>Account:</strong> never bought credits");
    // The free model carries the Free label; the music model is listed but cannot be tested.
    expect(entry(html, FREE)).toContain('<span class="pill free">Free</span>');
    expect(entry(html, "openai/gpt-6-luna")).not.toContain("pill free");
    // Never testable, so never shown; About this list counts it.
    expect(entry(html, MUSIC)).toBe("");
    expect(html).toContain("1 models that give audio, images or video, give no text, or list no price.");
    expect(html).toContain("Free models work without credit. OpenRouter allows free models 20 requests a minute, and 50 a day");
    expect(html).toContain("https://openrouter.ai/settings/privacy");
  });

  it("keeps a list that predates the free and text-only rules in use and reads nothing by itself; queued tests wait for Refresh model list, then run without the music model", async () => {
    await connect({ chat: chatAsZeroAccount, currentKey: FREE_TIER_KEY });
    expect((await post("/openrouter/test-all")).status).toBe(303);
    // A run queued before the deploy, on a list that let the music model through.
    const run = (await readTestAll(env.DB, userId, "openrouter"))!;
    await env.DB.prepare("INSERT INTO model_tests (run_id, user_id, provider, model, state) VALUES (?, ?, 'openrouter', ?, 'queued')").bind(run.id, userId, MUSIC).run();
    await storeOldCatalog();
    const queued = async () => (await readTestAll(env.DB, userId, "openrouter"))!.tests.filter((t) => t.state === "queued").length;
    const before = await queued();

    fetcher = fakeFetch({ chat: chatAsZeroAccount, currentKey: FREE_TIER_KEY });
    for (const seconds of [0, 60, 20 * 60]) await minuteCron(after(seconds), fetcher);
    expect((await tasks()).status).toBe(200);
    const html = await (await get("", after(20 * 60))).text();
    expect(html).toContain("Waiting for a fresh model list.");
    expect(FRESH_LIST_WAIT).toMatch(/^Waiting for a fresh model list/);
    expect(modelListReads()).toBe(0);
    expect(chatModels()).toEqual([]);
    expect(await queued()).toBe(before);
    expect((await readCurrentCatalog(env.DB))!.version).toBeUndefined();

    expect((await post("/openrouter/refresh")).status).toBe(303);
    expect(modelListReads()).toBe(1);
    expect((await readCurrentCatalog(env.DB))!.models.find((m) => m.id === MUSIC)).toBeUndefined();
    for (let minute = 21; (await queued()) > 0 && minute < 50; minute++) await minuteCron(after(minute * 60), fetcher);
    expect(modelListReads()).toBe(1);
    const done = (await readTestAll(env.DB, userId, "openrouter"))!;
    expect(done.done).toBe(done.tests.length);
    expect(chatModels()).not.toContain(MUSIC);
    expect(chatModels()).toContain(FREE);
    expect(done.tests.find((t) => t.model === MUSIC)).toMatchObject({ state: "failed", result: { reason: "cannot_call" } });
    expect(done.tests.find((t) => t.model === FREE)).toMatchObject({ state: "passed" });
  });

  it("passes the free model when it is tested, and says a paid one needs credit, with Add credits first", async () => {
    await connect({ chat: chatAsZeroAccount, currentKey: FREE_TIER_KEY });
    const free = entry(await tested(FREE), FREE);
    expect(free).toMatch(/<strong>[^<]+ passed\.<\/strong> Tasks can use it\./);
    const paidModel = MODELS.data.find((m) => !isTrulyFreeTextModel(m) && Number(m.pricing.prompt) > 0 && !m.id.startsWith("~") && !m.id.endsWith(":batch") && m.id !== "anthropic/claude-sonnet-5.5")!.id;
    const paid = entry(await tested(paidModel), paidModel);
    expect(paid).toContain('<span class="pill warn">Needs credit</span>');
    // The one action leads; OpenRouter's own words are in the collapsed details.
    expect(paid).toMatch(/<strong>Needs credit on OpenRouter\.<\/strong><\/span><button type="button" class="link hide" data-hide="[^"]+">Hide<\/button><\/p><div class="acts"><a class="btn small outline ext" href="https:\/\/openrouter.ai\/settings\/credits"[^>]*>Add credits<\/a><\/div><details><summary>Details<\/summary><p>OpenRouter replied: 402/);
    expect(paid).not.toContain("cheapest free model");
    // The music model is never sent.
    await tested(MUSIC);
    expect(chatModels()).toEqual([FREE, paidModel]);
  });

  it("never tests the music model in Test all models: the free one works, the paid ones need credit; the free one is usable for every task in one step", async () => {
    await connect({ chat: chatAsZeroAccount, currentKey: FREE_TIER_KEY });
    expect((await post("/openrouter/test-all")).status).toBe(303);
    await runQueuedTests(env.DB, await plugins(), NOW);
    const run = (await readTestAll(env.DB, userId, "openrouter"))!;
    expect(run.done).toBe(run.modelCount);
    expect(run.tests.map((t) => t.model)).not.toContain(MUSIC);
    expect(chatModels()).not.toContain(MUSIC);
    const free = run.tests.find((t) => t.model === FREE)!;
    expect(free.state).toBe("passed");
    const paid = run.tests.filter((t) => t.model !== FREE);
    expect(paid.length).toBeGreaterThan(0);
    for (const t of paid) expect(t).toMatchObject({ state: "failed", result: { reason: "no_credits", text: "Needs credit on OpenRouter." } });
    const page = await (await get()).text();
    expect(entry(page, paid[0]!.model)).toContain('<span class="pill warn">Needs credit</span>');
    expect(entry(page, FREE)).toContain('data-state="works"');
    expect(entry(page, FREE)).not.toContain('class="pill ok"');

    // The free model passed, so it is usable: no Add.
    const picker = await (await tasks()).text();
    expect(picker).toContain("Your models that passed are all free, so the app proposes none");
    expect(picker).toContain("Use my free models for every task");
    const used = await tasks("/use-free", {});
    expect(used.status).toBe(200);
    expect(await used.text()).toContain(`Every task now uses ${FREE}`);
    for (const task of TASKS) expect(await routeTask(env.DB, userId, task.id)).toMatchObject({ main: { model: FREE } });
  });

  it("says a 402 on a free model plainly, never as a paid model's", async () => {
    await connect({ chat: () => Response.json(NO_CREDIT, { status: 402 }), currentKey: FREE_TIER_KEY });
    const html = entry(await tested(FREE), FREE);
    expect(html).toContain("<strong>OpenRouter asked for credit even for this free model.</strong>");
    expect(html).not.toContain("cheapest free model");
  });
});
