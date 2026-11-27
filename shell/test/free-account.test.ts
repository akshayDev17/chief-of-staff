// A $0 OpenRouter account, end to end (the owner, 2026-11-27: "can i for now
// w.r.t. openrouter use only the free models ... because i think i dont need
// to put in any money for the entire COS --> openrouter testing flow"). The
// account's /models/user list is the captured fixture, free and paid entries
// both, with Google's Lyria music model listed at $0 a token; OpenRouter
// refuses every paid model with 402 and answers the free one. Connect makes
// no call; the account line says the account never bought credits; the free
// model is labelled Free and passes when chosen; a paid one says it needs
// credit, with Add credits; the music model is never offered or tested; Test
// all models says the paid ones need credit; and a free model is usable for
// every task in one step.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleTaskModels } from "../src/models/picker-page";
import { routeTask, TASKS } from "../src/models/tasks";
import { readTestAll, runQueuedTests } from "../src/models/test-all";
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
const handle = async (request: Request) =>
  handleProviders(request, { db: env.DB, plugins: await plugins(), readPlugins: plugins, secrets: vaultSecrets(env.DB, ENV), userId, viewer: "owner", appOrigin: ORIGIN, now: NOW, fetcher });
const post = (path: string, fields: Record<string, string> = {}) =>
  handle(new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields), headers: { origin: ORIGIN } }));
const get = (path = "") => handle(new Request(`${BASE}${path}`));
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

// One model's entry in the listbox.
const entry = (html: string, id: string): string => {
  const at = html.indexOf(`data-model="${id}"`);
  return at < 0 ? "" : html.slice(at, html.indexOf("</li>", at));
};

const chatModels = () => fetcher.sent.filter((s) => s.url.endsWith("/chat/completions")).map((s) => (s.body as { model: string }).model);

beforeEach(async () => {
  fetcher = fakeFetch();
  await refreshPrices({ db: env.DB, fetcher, now: new Date("2026-11-27T06:00:00Z") });
  userId = (await userFor("owner-sub")).id;
});

const FREE_TIER_KEY = () => keyReply({ is_free_tier: true, limit: 10, limit_remaining: 10, free_model_daily_requests: { used: 17, limit: 50, remaining: 33 } });

describe("a $0 OpenRouter account", () => {
  it("connects with no call made, and says the account never bought credits", async () => {
    expect((await connect({ chat: chatAsZeroAccount, currentKey: FREE_TIER_KEY })).status).toBe(303);
    expect(chatModels()).toEqual([]);
    const html = await (await get()).text();
    expect(html).toContain("<strong>OpenRouter account:</strong> never bought credits");
    expect(html).toContain("33 of 50 free-model requests left today.");
    // The free model carries the Free label; the music model is listed but cannot be chosen.
    expect(entry(html, FREE)).toContain('<span class="pill free">Free</span>');
    expect(entry(html, "openai/gpt-6-luna")).not.toContain("pill free");
    expect(html).toContain(`data-model="${MUSIC}" aria-selected="false" aria-disabled="true"`);
    expect(html).toContain("it also gives audio, images or video, priced beyond its token rates");
    expect(html).not.toContain(`<option value="${MUSIC}"`);
    expect(html).toContain("Free models work without credit. OpenRouter allows free models 20 requests a minute, and 50 a day");
    expect(html).toContain("https://openrouter.ai/settings/privacy");
  });

  it("passes the free model when it is chosen, and says a paid one needs credit, with Add credits first", async () => {
    await connect({ chat: chatAsZeroAccount, currentKey: FREE_TIER_KEY });
    const free = await post("/openrouter/choose", { model: FREE });
    expect(await free.text()).toContain(`<strong>${FREE} passed.</strong>`);
    const paidModel = MODELS.data.find((m) => !isTrulyFreeTextModel(m) && Number(m.pricing.prompt) > 0 && !m.id.startsWith("~") && m.id !== "anthropic/claude-sonnet-5.5")!.id;
    const paid = await (await post("/openrouter/choose", { model: paidModel })).text();
    expect(paid).toContain(`<strong>Needs credit on OpenRouter.</strong> <span class="small">${paidModel}</span>`);
    // The one action leads; OpenRouter's own words are in the collapsed details.
    expect(paid).toMatch(/<div class="row"><a class="btn small" href="https:\/\/openrouter.ai\/settings\/credits"[^>]*>Add credits<\/a><\/div>\n<details class="more"><summary>Details<\/summary><p class="tc-reply">OpenRouter replied: 402/);
    expect(paid).not.toContain("cheapest free model");
    // The music model is never sent.
    const music = await post("/openrouter/choose", { model: MUSIC });
    expect(music.status).toBe(400);
    expect(chatModels()).toEqual([FREE, paidModel]);
  });

  it("never tests the music model in Test all models: the free one works, the paid ones need credit; the free one is added and used for every task in one step", async () => {
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
    const page = await (await get("?tests=fails")).text();
    expect(page).toContain("needs credit");

    // Add the free model from the results; it is the only passed model.
    expect((await post("/openrouter/add-tested", { model: FREE })).status).toBe(200);
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
    const html = await (await post("/openrouter/choose", { model: FREE })).text();
    expect(html).toContain("<strong>OpenRouter asked for credit even for this free model.</strong>");
    expect(html).not.toContain("cheapest free model");
  });
});
