// Migration 0013 carries every test already made into model_latest_tests, so
// the models tasks use today stay usable: each model's newest of its latest
// Test all models result and the passed test it was added with. And it saves
// the route every task with no saved choice took until now, a user's one
// added model unless free, as that task's accepted choice.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { changesData } from "../src/release/migration-rules";
import { readLatestTests, readUsableModels } from "../src/models/usable";
import { routeTask, TASKS } from "../src/models/tasks";
import { writeSnapshot } from "../src/prices/store";
import { seedPrices, TEST_CATALOG, userFor } from "./test-plugin";

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
      // Added, then failed in a later run.
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
      ["test-mini", "failed", "2026-11-27T09:50:00Z"],
      ["test-sonnet", "passed", "2026-11-27T09:51:00Z"],
    ].sort());
    expect(latest.get("test-luna")!.result).toMatchObject({ text: "Works now.", test: { status: 200 } });
    expect((await readUsableModels(env.DB, userId)).map((m) => m.model)).toEqual(["test-luna", "test-sonnet"]);
    // The task's saved choice is untouched and still answers.
    expect(await routeTask(env.DB, userId, "match")).toMatchObject({ main: { model: "test-luna" } });
    const { n } = (await env.DB.prepare("SELECT count(*) AS n FROM task_routes").first<{ n: number }>())!;
    expect(n).toBe(1);
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
