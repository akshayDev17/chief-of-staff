import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleTaskModels } from "../src/models/picker-page";
import { TASK_MODELS_PATH } from "../src/paths";
import { acceptProposals, callTask, changeTask, readTaskRoutes, routeTask, TASKS } from "../src/models/tasks";
import { writeSnapshot } from "../src/prices/store";
import type { PriceRow, Provider } from "../src/prices/types";
import type { Viewer } from "../src/providers/page";
import { setBudget } from "../src/proxy/budgets";
import { writeConnection } from "../src/proxy/connections";
import type { PluginRegistry } from "../src/proxy/plugin";
import { APP_ORIGIN } from "./issuer-fixture";
import { ok, refused, testPlugin, userFor, type TestPlugin } from "./test-plugin";

const NOW = new Date("2026-11-25T10:00:00Z");
const clock = () => NOW;

const row = (provider: Provider, model: string, tokenKind: PriceRow["tokenKind"], usdPerMTok: number): PriceRow => ({
  provider, model, deployment: "global", region: "global", tokenKind, longPrompt: false, batch: false, usdPerMTok,
  source: "maintainer-read", dateRead: "2026-11-24", stale: false, disagreement: false,
});
const priced = (provider: Provider, model: string, input: number) => [row(provider, model, "input", input), row(provider, model, "output", input * 5)];

// Smallest under $0.50, Middle under $2.50, Strongest from $2.50.
const seed = () =>
  writeSnapshot(env.DB, {
    takenAt: "2026-11-24T06:00:00Z",
    status: "good",
    results: [],
    rows: [
      ...priced("bedrock", "haiku", 0.1),
      ...priced("bedrock", "sonnet", 2),
      ...priced("bedrock", "opus", 4),
      ...priced("vertex", "haiku", 0.1),
      ...priced("vertex", "sonnet", 2),
      ...priced("vertex", "flash", 0.3),
    ],
  });

let userId: string;
let bedrock: TestPlugin;
let vertex: TestPlugin;
let plugins: PluginRegistry;

const addModel = (uid: string, provider: Provider, model: string) =>
  env.DB.prepare("INSERT INTO user_models (user_id, provider, model, location, added_at) VALUES (?, ?, ?, 'global', ?)")
    .bind(uid, provider, model, NOW.toISOString())
    .run();

beforeEach(async () => {
  await seed();
  userId = (await userFor("picker-sub")).id;
  bedrock = testPlugin("bedrock");
  vertex = testPlugin("vertex");
  plugins = { bedrock, vertex };
  for (const p of [bedrock, vertex]) {
    await writeConnection(env.DB, userId, p, { account: "123456789012", region: "global" }, NOW);
    await setBudget(env.DB, userId, p.provider, 10, "typed", NOW);
  }
});

const post = (verb: string, fields: Record<string, string> = {}, uid = userId, viewer: Viewer = "owner") =>
  handleTaskModels(
    new Request(`${APP_ORIGIN}${TASK_MODELS_PATH}/${verb}`, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: APP_ORIGIN },
    }),
    { db: env.DB, plugins, userId: uid, viewer, now: NOW },
  );
const open = (uid = userId, viewer: Viewer = "owner") =>
  handleTaskModels(new Request(`${APP_ORIGIN}${TASK_MODELS_PATH}`), { db: env.DB, plugins, userId: uid, viewer, now: NOW });

const named = (r?: { provider: string; model: string }) => (r ? `${r.provider}/${r.model}` : undefined);
const routes = async (uid = userId) =>
  Object.fromEntries((await readTaskRoutes(env.DB, uid)).routes.map((r) => [r.task.id, r]));

describe("the task list", () => {
  it("has the owner's tiers: smallest for matching, extraction and LinkedIn, middle for the rest, none strongest", () => {
    expect(Object.fromEntries(TASKS.map((t) => [t.id, t.tier]))).toEqual({
      match: "Smallest", extract: "Smallest", linkedin_message: "Smallest",
      score: "Middle", fill_form: "Middle", check_form: "Middle", cover_letter: "Middle", free_text: "Middle",
    });
  });
});

describe("proposals", () => {
  it("with no passed model, offers nothing and says to add one", async () => {
    const html = await (await open()).text();
    expect(html).toContain("Add a model first");
    expect(await routeTask(env.DB, userId, "match")).toBeUndefined();
  });

  it("with one passed model, every task uses it, even a Strongest one, with no tap", async () => {
    await addModel(userId, "bedrock", "opus");
    const all = await routes();
    for (const t of TASKS) expect(all[t.id]!.current).toMatchObject({ main: { provider: "bedrock", model: "opus" }, setHow: "only_model" });
    const html = await (await open()).text();
    expect(html).toContain("You have one model that passed, so every task uses it for now.");
    expect(html).toContain("Model now");
    expect(html).not.toContain("Accept all");
  });

  it("with models at two providers, proposes a main and a fallback on the other provider at each task's tier", async () => {
    for (const [p, m] of [["bedrock", "haiku"], ["bedrock", "sonnet"], ["bedrock", "opus"], ["vertex", "flash"], ["vertex", "sonnet"]] as const) await addModel(userId, p, m);
    const all = await routes();
    // Smallest: the cheapest Smallest model, then the other provider's Smallest.
    for (const t of ["match", "extract", "linkedin_message"]) {
      expect([named(all[t]!.proposal?.main), named(all[t]!.proposal?.fallback)]).toEqual(["bedrock/haiku", "vertex/flash"]);
    }
    for (const t of ["score", "fill_form", "check_form", "cover_letter", "free_text"]) {
      expect(all[t]!.proposal?.main.tier).toBe("Middle");
      expect(all[t]!.proposal?.fallback?.tier).toBe("Middle");
      expect(all[t]!.proposal?.fallback?.provider).not.toBe(all[t]!.proposal?.main.provider);
    }
    // Opus is never proposed, and nothing is used before the tap.
    for (const t of TASKS) {
      expect(all[t.id]!.current).toBeUndefined();
      expect([all[t.id]!.proposal?.main.model, all[t.id]!.proposal?.fallback?.model]).not.toContain("opus");
    }
    expect(await routeTask(env.DB, userId, "match")).toBeUndefined();
    const html = await (await open()).text();
    expect(html).toContain("Accept all with one tap");
    expect(html).toContain("haiku · bedrock");
    expect(html).toContain("proposed");
  });

  it("proposes the nearest non-Strongest strength when the user has none of the task's own", async () => {
    await addModel(userId, "bedrock", "haiku");
    await addModel(userId, "vertex", "haiku");
    await addModel(userId, "vertex", "sonnet");
    await addModel(userId, "bedrock", "opus");
    const all = await routes();
    // No Middle at Bedrock: scoring falls back to Bedrock's Smallest, never Opus.
    expect([named(all.score!.proposal?.main), named(all.score!.proposal?.fallback)]).toEqual(["vertex/sonnet", "bedrock/haiku"]);
    const html = await (await open()).text();
    expect(html.split("a Smallest model, since you have no Middle model at another provider yet").length - 1).toBe(5);
    expect(html).not.toContain("since you have no Smallest model");
  });

  it("says plainly when a proposed main model is of the other strength, also once accepted", async () => {
    await addModel(userId, "bedrock", "sonnet");
    await addModel(userId, "vertex", "sonnet");
    const count = (html: string, text: string) => html.split(text).length - 1;
    const before = await (await open()).text();
    // Matching, extraction and LinkedIn: Smallest, and the user has only Middle models.
    expect(count(before, "a Middle model, since you have no Smallest model yet")).toBe(3);
    expect(count(before, "a Middle model, since you have no Smallest model at another provider yet")).toBe(3);
    await acceptProposals(env.DB, userId, NOW);
    expect(count(await (await open()).text(), "a Middle model, since you have no Smallest model yet")).toBe(3);
    // A task the user changed is their own choice, with no note.
    await changeTask(env.DB, userId, "match", "bedrock|sonnet", undefined, NOW);
    expect(count(await (await open()).text(), "a Middle model, since you have no Smallest model yet")).toBe(2);
  });

  it("one tap accepts every proposal, and the proxy then routes each task by it", async () => {
    await addModel(userId, "bedrock", "sonnet");
    await addModel(userId, "vertex", "sonnet");
    const res = await post("accept");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`Accepted: ${TASKS.length} tasks`);
    const route = await routeTask(env.DB, userId, "cover_letter");
    expect([named(route?.main), named(route?.fallback)]).toEqual(["bedrock/sonnet", "vertex/sonnet"]);
    expect(await (await open()).text()).not.toContain("Accept all with one tap");
  });

  it("proposes a fallback added after accepting one provider's models, keeping a changed task and the accepted models until the tap", async () => {
    await addModel(userId, "bedrock", "haiku");
    await addModel(userId, "bedrock", "sonnet");
    await acceptProposals(env.DB, userId, NOW);
    await changeTask(env.DB, userId, "cover_letter", "bedrock|haiku", undefined, NOW);
    expect(await (await open()).text()).toContain("none: add a model at another provider");

    await addModel(userId, "vertex", "flash");
    await addModel(userId, "vertex", "sonnet");
    const all = await routes();
    expect([named(all.match!.proposal?.main), named(all.match!.proposal?.fallback), all.match!.pending]).toEqual(["bedrock/haiku", "vertex/flash", true]);
    expect([named(all.cover_letter!.current?.main), all.cover_letter!.current?.setHow, all.cover_letter!.pending]).toEqual(["bedrock/haiku", "changed", false]);
    // Until the tap, calls keep the accepted models.
    expect(named((await routeTask(env.DB, userId, "match"))?.fallback)).toBeUndefined();
    const html = await (await open()).text();
    expect(html).toContain("Accept all with one tap");
    expect(html).toContain("flash · vertex <span class=\"pill\">proposed</span>");
    expect(html).not.toContain("add a model at another provider");

    expect(await (await post("accept")).text()).toContain(`Accepted: ${TASKS.length - 1} tasks`);
    const match = await routeTask(env.DB, userId, "match");
    expect([named(match?.main), named(match?.fallback)]).toEqual(["bedrock/haiku", "vertex/flash"]);
    const score = await routeTask(env.DB, userId, "score");
    expect([named(score?.main), named(score?.fallback)]).toEqual(["bedrock/sonnet", "vertex/sonnet"]);
    const cover = await routeTask(env.DB, userId, "cover_letter");
    expect([named(cover?.main), named(cover?.fallback)]).toEqual(["bedrock/haiku", undefined]);
    for (const r of Object.values(await routes())) expect(r.pending).toBe(false);
    expect(await (await open()).text()).not.toContain("Accept all with one tap");
  });
});

describe("changing a task", () => {
  beforeEach(async () => {
    await addModel(userId, "bedrock", "haiku");
    await addModel(userId, "bedrock", "opus");
    await addModel(userId, "vertex", "flash");
  });

  it("can set a task to the Strongest model, and the one tap keeps it", async () => {
    const res = await post("change", { task: "cover_letter", main: "bedrock|opus", fallback: "vertex|flash" });
    expect(res.status).toBe(200);
    await acceptProposals(env.DB, userId, NOW);
    const route = await routeTask(env.DB, userId, "cover_letter");
    expect([named(route?.main), named(route?.fallback)]).toEqual(["bedrock/opus", "vertex/flash"]);
    const current = (await routes()).cover_letter!.current;
    expect([current?.main.tier, current?.setHow]).toEqual(["Strongest", "changed"]);
  });

  it("refuses a fallback on the main model's provider, and a model the user has not passed", async () => {
    expect(await changeTask(env.DB, userId, "match", "bedrock|haiku", "bedrock|opus", NOW)).toBe("same_provider");
    expect(await changeTask(env.DB, userId, "match", "vertex|sonnet", undefined, NOW)).toBe("not_your_model");
    expect(await changeTask(env.DB, userId, "nope", "bedrock|haiku", undefined, NOW)).toBe("no_such_task");
    const res = await post("change", { task: "match", main: "bedrock|haiku", fallback: "bedrock|opus" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("The fallback must be on another provider");
  });

  it("can drop the fallback, shown as plain none", async () => {
    const html = await (await post("change", { task: "match", main: "bedrock|haiku", fallback: "" })).text();
    expect(named((await routeTask(env.DB, userId, "match"))?.fallback)).toBeUndefined();
    expect(html).toContain(`<td data-l="Fallback (another provider)">none</td>`);
    expect(html).not.toContain("add a model at another provider");
  });
});

describe("per-user scoping", () => {
  it("offers only the user's own models and keeps each user's choices their own", async () => {
    const other = (await userFor("picker-other")).id;
    await addModel(userId, "bedrock", "haiku");
    await addModel(userId, "vertex", "flash");
    await addModel(other, "bedrock", "opus");
    await acceptProposals(env.DB, userId, NOW);
    // The other user's one model is theirs alone; the owner's picks are not offered.
    expect(named((await routeTask(env.DB, other, "match"))?.main)).toBe("bedrock/opus");
    expect(await changeTask(env.DB, other, "match", "bedrock|haiku", undefined, NOW)).toBe("not_your_model");
    expect(await changeTask(env.DB, userId, "match", "bedrock|opus", undefined, NOW)).toBe("not_your_model");
    const html = await (await open(other)).text();
    expect(html).not.toContain("haiku");
    expect(html).not.toContain("flash");
  });
});

describe("friend screens", () => {
  it("say Admin and offer help, never tier", async () => {
    await addModel(userId, "bedrock", "sonnet");
    const html = await (await open(userId, "friend")).text();
    expect(html).toContain("Ask Admin for help");
    expect(html).not.toMatch(/\btier\b/i);
    expect(html).not.toContain("owner");
    const res = await post("help", {}, userId, "friend");
    expect(await res.text()).toContain("Sent to Admin");
    expect((await post("help")).status).toBe(403);
  });
});

describe("the proxy uses each task's main model and its fallback", () => {
  const ledger = async () =>
    (await env.DB.prepare("SELECT task, provider, model, status, fallback, fallback_reason FROM model_calls WHERE user_id = ? ORDER BY id").bind(userId).all()).results;
  const call = (task = "fill_form") => callTask(env.DB, plugins, { userId, task, request: (m) => ({ prompt: `for ${m.provider}` }) }, clock);

  beforeEach(async () => {
    await addModel(userId, "bedrock", "sonnet");
    await addModel(userId, "vertex", "sonnet");
    await acceptProposals(env.DB, userId, NOW);
  });

  it("answers from the main model when it answers", async () => {
    expect(await call()).toMatchObject({ kind: "answered", provider: "bedrock", model: "sonnet", fallback: false });
    expect(bedrock.calls[0]!.request).toEqual({ prompt: "for bedrock" });
  });

  it("hands a 429 to the fallback, named in its ledger row", async () => {
    bedrock.replies.push(refused(429));
    vertex.replies.push(ok({ input: 100, output: 10 }));
    expect(await call()).toMatchObject({ kind: "answered", provider: "vertex", model: "sonnet", fallback: true });
    expect(vertex.calls[0]!.request).toEqual({ prompt: "for vertex" });
    expect(await ledger()).toEqual([
      { task: "fill_form", provider: "bedrock", model: "sonnet", status: 429, fallback: 0, fallback_reason: null },
      { task: "fill_form", provider: "vertex", model: "sonnet", status: 200, fallback: 1, fallback_reason: "refused" },
    ]);
  });

  it("hands a spent budget to the fallback, named in its ledger row", async () => {
    await setBudget(env.DB, userId, "bedrock", 0.000001, "typed", NOW);
    bedrock.replies.push(ok({ input: 1_000_000, output: 0 }));
    await call();
    const outcome = await call();
    expect(outcome).toMatchObject({ kind: "answered", provider: "vertex", fallback: true });
    expect((await ledger()).at(-1)).toMatchObject({ provider: "vertex", fallback: 1, fallback_reason: "budget_spent" });
  });

  it("refuses a task with no model yet, sending nothing", async () => {
    await env.DB.prepare("DELETE FROM task_models").run();
    expect(await call()).toMatchObject({ kind: "no_model", task: "fill_form" });
    expect(bedrock.calls).toHaveLength(0);
  });
});
