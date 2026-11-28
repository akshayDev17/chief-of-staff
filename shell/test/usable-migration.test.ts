// Migration 0013 carries every test already made into model_latest_tests, so
// the models tasks use today stay usable: each model's newest of its latest
// Test all models result and the passed test it was added with. And it saves
// the route every task with no saved choice took until now, a user's one
// added model unless free, as that task's accepted choice.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { changesData } from "../src/release/migration-rules";
import { readLatestTests } from "../src/models/latest-tests";
import { routeTask, TASKS } from "../src/models/tasks";
import { writeSnapshot } from "../src/prices/store";
import { seedPrices, TEST_CATALOG, testPlugin, userFor } from "./test-plugin";

const migration = env.TEST_MIGRATIONS.find((m) => m.name === "0013_models_one_table.sql")!;
const carryOver = migration.queries.find((q) => q.includes("INSERT INTO model_latest_tests"))!;
const onlyModelRoutes = migration.queries.find((q) => q.includes("INSERT INTO task_routes"))!;
let userId: string;

const passed = (at: string) => JSON.stringify({ at, location: "global", status: 200, costUsd: 0.000001 });

beforeEach(async () => {
  await seedPrices();
  userId = (await userFor("owner-sub")).id;
});

describe("migration 0013", () => {
  it("only adds: tables, columns and rows", () => {
    expect(carryOver).toBeDefined();
    expect(onlyModelRoutes).toBeDefined();
    expect(changesData(migration.queries.join(";\n"))).toBe(false);
  });

  it("carries each model's newest test over, and every model a task uses stays usable", async () => {
    await env.DB.batch([
      // Added with a passed test, no run since.
      env.DB.prepare("INSERT INTO user_models (user_id, provider, model, location, added_at, test_result) VALUES (?, 'openrouter', 'test-luna', 'global', ?, ?)").bind(userId, "2026-11-27T08:00:00Z", passed("2026-11-27T08:00:00.000Z")),
      // Added, then refused as busy in a later run: no verdict on it.
      env.DB.prepare("INSERT INTO user_models (user_id, provider, model, location, added_at, test_result) VALUES (?, 'openrouter', 'test-mini', 'global', ?, ?)").bind(userId, "2026-11-27T08:00:00Z", passed("2026-11-27T08:00:00.000Z")),
      // Added with no test recorded: nothing to carry.
      env.DB.prepare("INSERT INTO user_models (user_id, provider, model, location, added_at) VALUES (?, 'openrouter', 'test-sonnet', 'global', ?)").bind(userId, "2026-11-27T08:00:00Z"),
      env.DB.prepare("INSERT INTO model_test_runs (id, user_id, provider, started_at, finished_at, model_count, estimate_usd) VALUES (1, ?, 'openrouter', ?, ?, 2, 0)").bind(userId, "2026-11-27T09:49:00Z", "2026-11-27T09:59:00Z"),
      env.DB.prepare("INSERT INTO model_tests (run_id, user_id, provider, model, state, result, tested_at) VALUES (1, ?, 'openrouter', 'test-mini', 'failed', ?, ?)").bind(userId, JSON.stringify({ reason: "busy", text: "Busy." }), "2026-11-27T09:50:00Z"),
      // A run's pass on a model never added.
      env.DB.prepare("INSERT INTO model_tests (run_id, user_id, provider, model, state, result, tested_at) VALUES (1, ?, 'openrouter', 'test-sonnet', 'passed', ?, ?)").bind(userId, JSON.stringify({ text: "Works now.", test: JSON.parse(passed("2026-11-27T09:51:00.000Z")) }), "2026-11-27T09:51:00Z"),
      env.DB.prepare("INSERT INTO task_routes (user_id, task, main_provider, main_model, set_how, set_at) VALUES (?, 'match', 'openrouter', 'test-luna', 'changed', ?)").bind(userId, "2026-11-27T08:05:00Z"),
    ]);
    await env.DB.prepare(carryOver).run();
    const latest = await readLatestTests(env.DB, userId, "openrouter");
    expect([...latest.values()].map((t) => [t.model, t.state, t.testedAt])).toEqual([
      ["test-luna", "passed", "2026-11-27T08:00:00.000Z"],
      ["test-mini", "passed", "2026-11-27T08:00:00.000Z"],
      ["test-sonnet", "passed", "2026-11-27T09:51:00Z"],
    ].sort());
    expect(latest.get("test-luna")!.result).toMatchObject({ text: "Works now.", test: { status: 200 } });
    // The task's saved choice is untouched and still answers.
    expect(await routeTask(env.DB, { openrouter: testPlugin() }, userId, "match")).toMatchObject({ main: { model: "test-luna" } });
    const { n } = (await env.DB.prepare("SELECT count(*) AS n FROM task_routes").first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it("carries a run's failure only when it is the model's verdict", async () => {
    const add = (user: string, model: string) =>
      env.DB.prepare("INSERT INTO user_models (user_id, provider, model, location, added_at, test_result) VALUES (?, 'openrouter', ?, 'global', ?, ?)").bind(user, model, "2026-11-27T08:00:00Z", passed("2026-11-27T08:00:00.000Z"));
    const failure = (run: number, user: string, model: string, result: object) =>
      env.DB.prepare("INSERT INTO model_tests (run_id, user_id, provider, model, state, result, tested_at) VALUES (?, ?, 'openrouter', ?, 'failed', ?, ?)").bind(run, user, model, JSON.stringify(result), "2026-11-27T09:50:00Z");
    const users = await Promise.all(["a", "b", "c"].map(async (s) => (await userFor(`${s}-sub`)).id));
    const run = (id: number, user: string) =>
      env.DB.prepare("INSERT INTO model_test_runs (id, user_id, provider, started_at, finished_at, model_count, estimate_usd) VALUES (?, ?, 'openrouter', ?, ?, 3, 0)").bind(id, user, "2026-11-27T09:49:00Z", "2026-11-27T09:59:00Z");
    const notVerdicts = [
      { reason: "busy", text: "Busy." }, { reason: "no_credits", text: "Needs credit." }, { reason: "not_set_up", text: "No key." },
      { reason: "budget_spent", text: "Spent." }, { reason: "not_connected", text: "Not connected." }, { reason: "app_not_configured", text: "Setup." },
      { reason: "no_reply", text: "The test could not run." }, { text: "No reason." },
    ];
    const statements = [...users.map((u, i) => run(i + 1, u))];
    // Each kind of refusal on its own user's added model.
    const owners = await Promise.all(notVerdicts.map(async (_, i) => (await userFor(`nv-${i}-sub`)).id));
    owners.forEach((u, i) => statements.push(run(10 + i, u), add(u, "test-luna"), failure(10 + i, u, "test-luna", notVerdicts[i]!)));
    // Verdicts: OpenRouter's own refusal, and no reply where OpenRouter answered with status 0.
    statements.push(add(users[0]!, "test-luna"), failure(1, users[0]!, "test-luna", { reason: "no_such_model", text: "No such model.", reply: { status: 404 } }));
    statements.push(add(users[1]!, "test-luna"), failure(2, users[1]!, "test-luna", { reason: "no_reply", text: "No answer.", reply: { status: 0 } }));
    // A refusal on a model never added carries nothing.
    statements.push(failure(3, users[2]!, "test-mini", { reason: "busy", text: "Busy." }));
    await env.DB.batch(statements);
    await env.DB.prepare(carryOver).run();
    for (const u of owners) {
      expect((await readLatestTests(env.DB, u, "openrouter")).get("test-luna")).toMatchObject({ state: "passed", testedAt: "2026-11-27T08:00:00.000Z" });
    }
    for (const u of users.slice(0, 2)) expect((await readLatestTests(env.DB, u, "openrouter")).get("test-luna")?.state).toBe("failed");
    expect((await readLatestTests(env.DB, users[2]!, "openrouter")).size).toBe(0);
  });

  it("saves each user's one added model as every task's accepted choice where the task has none, and keeps every existing row", async () => {
    await writeSnapshot(env.DB, {
      takenAt: "2026-11-27T07:00:00Z", status: "good", results: [],
      catalog: { ...TEST_CATALOG, models: [...TEST_CATALOG.models, { id: "test-free:free", name: "Test Free", tools: true, free: true }] },
      rows: [],
    });
    const one = userId;
    const two = (await userFor("two-sub")).id;
    const free = (await userFor("free-sub")).id;
    const gone = (await userFor("gone-sub")).id;
    const add = (user: string, model: string, provider = "openrouter") =>
      env.DB.prepare("INSERT INTO user_models (user_id, provider, model, location, added_at) VALUES (?, ?, ?, 'global', ?)").bind(user, provider, model, "2026-11-27T08:00:00Z");
    await env.DB.batch([
      add(one, "test-luna"),
      add(two, "test-luna"),
      add(two, "test-mini"),
      add(free, "test-free:free"),
      // A model at a removed provider does not count: the one OpenRouter model is the user's only one.
      add(gone, "test-mini"),
      add(gone, "anthropic.claude", "bedrock"),
      env.DB.prepare("INSERT INTO task_routes (user_id, task, main_provider, main_model, fallback_provider, fallback_model, set_how, set_at) VALUES (?, 'score', 'openrouter', 'test-sonnet', 'openrouter', 'test-mini', 'changed', ?)").bind(one, "2026-11-27T08:05:00Z"),
    ]);
    const before = (await env.DB.prepare("SELECT * FROM task_routes").all()).results;
    await env.DB.prepare(onlyModelRoutes).run();
    const { results } = await env.DB.prepare("SELECT user_id, task, main_provider, main_model, fallback_provider, fallback_model, set_how, set_at FROM task_routes ORDER BY user_id, task").all<Record<string, string | null>>();
    for (const row of before) expect(results).toContainEqual(row);
    const routesOf = (user: string) => results.filter((r) => r.user_id === user);
    const saved = (user: string, model: string) =>
      TASKS.filter((t) => t.id !== "score" || user !== one).map((t) => expect.objectContaining({ task: t.id, main_provider: "openrouter", main_model: model, fallback_provider: null, fallback_model: null, set_how: "accepted" }));
    expect(routesOf(one).filter((r) => r.set_how === "accepted")).toEqual(expect.arrayContaining(saved(one, "test-luna")));
    expect(routesOf(one)).toHaveLength(TASKS.length);
    expect(routesOf(one).find((r) => r.task === "score")).toMatchObject({ main_model: "test-sonnet", set_how: "changed" });
    expect(routesOf(gone)).toEqual(expect.arrayContaining(saved(gone, "test-mini")));
    expect(routesOf(gone)).toHaveLength(TASKS.length);
    expect(routesOf(two)).toEqual([]);
    expect(routesOf(free)).toEqual([]);
    for (const r of routesOf(one)) expect(Number.isNaN(Date.parse(r.set_at!))).toBe(false);
    // Running it again adds nothing.
    await env.DB.prepare(onlyModelRoutes).run();
    const { n } = (await env.DB.prepare("SELECT count(*) AS n FROM task_routes").first<{ n: number }>())!;
    expect(n).toBe(2 * TASKS.length);
  });
});
