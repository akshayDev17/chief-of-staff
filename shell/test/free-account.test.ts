// A $0 OpenRouter account, end to end (the owner, 2026-11-27: "can i for now
// w.r.t. openrouter use only the free models ... because i think i dont need
// to put in any money for the entire COS --> openrouter testing flow"). The
// account's /models/user list is the captured fixture, free and paid entries
// both, with Google's Lyria music model listed at $0 a token; OpenRouter
// refuses every paid model with 402 and answers the free one. Connect makes
// no call; the account line says the account never bought credits; the free
// model is labelled Free and is Ready with no test; the paid ones read Needs
// credit, with Add credits; the music model is never listed; a Test of the
// free one passes and of a paid one says it needs credit; and the free model
// takes every task of its strength (Smallest) in one step, with no call made.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTaskModels } from "../src/models/picker-page";
import { routeTask, TASKS } from "../src/models/tasks";
import { readLatestTests } from "../src/models/latest-tests";
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
    expect(html).toContain("1 model that gives audio, images or video, gives no text, or lists no price.");
    expect(html).toContain("Free models work without credit. OpenRouter allows free models 20 requests a minute, and 50 a day");
    expect(html).toContain("https://openrouter.ai/settings/privacy");
  });

  it("keeps a list that predates the free and text-only rules in use and reads nothing by itself, until Refresh model list reads it without the music model", async () => {
    await connect({ chat: chatAsZeroAccount, currentKey: FREE_TIER_KEY });
    await storeOldCatalog();
    fetcher = fakeFetch({ chat: chatAsZeroAccount, currentKey: FREE_TIER_KEY });
    expect((await tasks()).status).toBe(200);
    const html = await (await get()).text();
    expect(html).toContain("This list follows older rules.");
    expect(html).toMatch(/class="btn primary small" data-k="refresh-list"[^>]*>Refresh model list</);
    expect(modelListReads()).toBe(0);
    expect(chatModels()).toEqual([]);
    expect((await readCurrentCatalog(env.DB))!.version).toBeUndefined();
    expect((await post("/openrouter/refresh")).status).toBe(303);
    expect(modelListReads()).toBe(1);
    expect((await readCurrentCatalog(env.DB))!.models.find((m) => m.id === MUSIC)).toBeUndefined();
    expect(chatModels()).toEqual([]);
  });

  it("passes the free model when it is tested, and says a paid one needs credit, with Add credits first", async () => {
    await connect({ chat: chatAsZeroAccount, currentKey: FREE_TIER_KEY });
    const free = entry(await tested(FREE), FREE);
    expect(free).toMatch(/<strong>[^<]+ passed\.<\/strong> It answered just now\./);
    const paidModel = MODELS.data.find((m) => !isTrulyFreeTextModel(m) && Number(m.pricing.prompt) > 0 && !m.id.startsWith("~") && !m.id.endsWith(":batch") && m.id !== "anthropic/claude-sonnet-5.5")!.id;
    const paid = entry(await tested(paidModel), paidModel);
    // A 402 says nothing about the model: no verdict; the row reads Needs credit, as the account line says.
    expect(paid).toContain('data-state="credit"');
    expect((await readLatestTests(env.DB, userId, "openrouter")).has(paidModel)).toBe(false);
    // The one action leads; OpenRouter's own words are in the collapsed details.
    expect(paid).toMatch(/<strong>Needs credit on OpenRouter\.<\/strong><\/span><button type="button" class="link hide" data-hide="[^"]+">Hide<\/button><\/p><div class="acts"><a class="btn small outline ext" href="https:\/\/openrouter.ai\/settings\/credits"[^>]*>Add credits<\/a><\/div><details><summary>Details<\/summary><p>OpenRouter replied: 402/);
    expect(paid).not.toContain("cheapest free model");
    // The music model is never sent.
    await tested(MUSIC);
    expect(chatModels()).toEqual([FREE, paidModel]);
  });

  it("makes the free model Ready and the paid ones Needs credit with no call, and the free one takes every Smallest task in one step", async () => {
    await connect({ chat: chatAsZeroAccount, currentKey: FREE_TIER_KEY });
    const page = await (await get()).text();
    const paid = [...page.matchAll(/<li class="row"[^>]*data-id="([^"]+)"[^>]*data-state="credit"/g)].map((m) => m[1]!);
    expect(paid.length).toBeGreaterThan(0);
    expect(paid).not.toContain(FREE);
    expect(entry(page, paid[0]!)).toContain('<span class="pill warn">Needs credit</span>');
    expect(entry(page, FREE)).toContain('data-state="ready"');
    expect(entry(page, FREE)).not.toContain('class="pill ok"');
    expect(page).toMatch(/data-credit-act>Add credits<\/a>/);
    expect(chatModels()).toEqual([]);

    // The free model is Ready: no Add, no test. It is a Smallest model (its
    // price is $0), so only the Smallest tasks can take it (the owner,
    // 2026-11-27: "when suggested strenght == Smallest --> the dropdown next
    // to it should only contain all passing run models tagged with the
    // smallest chip"); the Middle ones wait for credit.
    const smallest = TASKS.filter((t) => t.tier === "Smallest");
    const picker = await (await tasks()).text();
    expect(picker).toContain("Your Ready models are all free, so none is proposed.");
    expect(picker).toContain(`Use my free models for ${smallest.length} tasks`);
    // Under the lines the fixture's own prices draw, its one Middle model
    // (DeepSeek V4.1 Flash, $0.38 typical) is paid, so it waits for credit.
    expect(picker).toContain("No Middle model is ready yet. Paid ones need credit.</span>");
    // Its rows lead to Add credits, not to the Middle models on Providers.
    expect(picker).toMatch(/href="https:\/\/openrouter\.ai\/settings\/credits"[^>]*>Add credits<\/a>/);
    expect(picker).not.toContain("See Middle models");
    const used = await tasks("/use-free", {});
    expect(used.status).toBe(303);
    expect(used.headers.get("location")).toBe(`${TASKS_URL}?free=${smallest.length}`);
    expect(await (await handleTaskModels(new Request(used.headers.get("location")!), { db: env.DB, plugins: await plugins(), userId, viewer: "owner", now: NOW })).text()).toContain(`${smallest.length} tasks now use your free models.`);
    for (const task of TASKS) {
      if (task.tier === "Smallest") expect(await routeTask(env.DB, await plugins(), userId, task.id)).toMatchObject({ main: { model: FREE } });
      else expect(await routeTask(env.DB, await plugins(), userId, task.id)).toBeUndefined();
    }
    expect(chatModels()).toEqual([]);
  });

  it("says a 402 on a free model plainly, never as a paid model's", async () => {
    await connect({ chat: () => Response.json(NO_CREDIT, { status: 402 }), currentKey: FREE_TIER_KEY });
    const html = entry(await tested(FREE), FREE);
    expect(html).toContain("<strong>OpenRouter asked for credit even for this free model.</strong>");
    expect(html).not.toContain("cheapest free model");
  });
});
