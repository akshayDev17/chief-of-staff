// A $0 OpenRouter account, end to end (the owner, 2026-11-27: "can i for now
// w.r.t. openrouter use only the free models ... because i think i dont need
// to put in any money for the entire COS --> openrouter testing flow"). The
// account's /models/user list is the captured fixture, free and paid entries
// both; OpenRouter refuses every paid model with 402 and answers the free one.
// Connect must pass on the free model, chosen from that live list, the model
// list must show, Test all models must say the paid ones need credit, and a
// free model must be usable for every task in one step.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleTaskModels } from "../src/models/picker-page";
import { routeTask, TASKS } from "../src/models/tasks";
import { readTestAll, runQueuedTests } from "../src/models/test-all";
import { refreshPrices } from "../src/prices/refresh";
import { readCurrentCatalog } from "../src/prices/store";
import { readCheck } from "../src/providers/check";
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

// The fixture's one free entry ($0 in and out), found by its price, never named.
const FREE = MODELS.data.find((m) => Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)!.id;
const isFreeModel = (id: string) => id === FREE;

const NO_CREDIT = { error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits" } };
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

const chatModels = () => fetcher.sent.filter((s) => s.url.endsWith("/chat/completions")).map((s) => (s.body as { model: string }).model);

beforeEach(async () => {
  fetcher = fakeFetch();
  await refreshPrices({ db: env.DB, fetcher, now: new Date("2026-11-27T06:00:00Z") });
  userId = (await userFor("owner-sub")).id;
});

describe("a $0 OpenRouter account", () => {
  it("passes Connect on the cheapest free model when OpenRouter says the account has no credit, and says why", async () => {
    expect((await connect({ chat: chatAsZeroAccount, currentKey: () => keyReply({ is_free_tier: true, free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } }) })).status).toBe(303);
    const check = await readCheck(env.DB, userId, "openrouter");
    expect(check).toMatchObject({ state: "passed", result: { verdict: "passed", model: FREE } });
    // No paid model was tried: the account said it has no credit.
    expect(chatModels()).toEqual([FREE]);
    const html = await (await get()).text();
    expect(html).toContain(`Tested on <strong>${FREE}</strong>: cheapest free model, because your OpenRouter account has no credit.`);
    expect(html).toContain("47 of 50 free-model requests left today");
    // The model list shows below the passed Connect, with OpenRouter's terms for free models.
    expect(html).toContain("Choose a model");
    expect(html).toContain("Free models work without credit. OpenRouter allows free models 20 requests a minute, and 50 a day");
    expect(html).toContain("https://openrouter.ai/settings/privacy");
  });

  it("falls back to the cheapest free model on a 402 when the account's credit cannot be read", async () => {
    await connect({ chat: chatAsZeroAccount, currentKey: () => Response.json({ error: { code: 500, message: "down" } }, { status: 500 }) });
    const check = await readCheck(env.DB, userId, "openrouter");
    expect(check).toMatchObject({ state: "passed", result: { model: FREE } });
    const [paid, free] = chatModels();
    expect(free).toBe(FREE);
    expect(isFreeModel(paid!)).toBe(false);
    expect(check?.result?.why).toBe(`cheapest free model, because OpenRouter refused the cheapest paid model, ${paid}, for lack of credit (402)`);
  });

  it("refuses Connect with a plain reason when the account's model list cannot be read, and never tries a built-in model", async () => {
    await connect({ chat: chatAsZeroAccount, userModels: () => Response.json({ error: { code: 503, message: "unavailable" } }, { status: 503 }) });
    const check = await readCheck(env.DB, userId, "openrouter");
    expect(check?.state).toBe("failed");
    expect(chatModels()).toEqual([]);
    const html = await (await get()).text();
    expect(html).toContain("OpenRouter did not give your account&#39;s model list, so no test model can be chosen from it.");
    expect(html).not.toContain("Choose a model");
  });

  it("tests every model: the free one works, the paid ones need credit on OpenRouter; the free one is added and used for every task in one step", async () => {
    await connect({ chat: chatAsZeroAccount, currentKey: () => keyReply({ is_free_tier: true }) });
    expect((await post("/openrouter/test-all")).status).toBe(303);
    await runQueuedTests(env.DB, await plugins(), NOW);
    const run = (await readTestAll(env.DB, userId, "openrouter"))!;
    expect(run.done).toBe(run.modelCount);
    const free = run.tests.find((t) => t.model === FREE)!;
    expect(free.state).toBe("passed");
    const paid = run.tests.filter((t) => t.model !== FREE);
    expect(paid.length).toBeGreaterThan(0);
    for (const t of paid) expect(t).toMatchObject({ state: "failed", result: { reason: "no_credits", text: "Needs credit on OpenRouter: your account or this key has none left for this paid model." } });
    const page = await (await get("?tests=fails")).text();
    expect(page).toContain("Needs credit on OpenRouter");

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
});
