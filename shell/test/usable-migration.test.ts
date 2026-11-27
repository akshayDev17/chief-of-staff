// Migration 0013 carries every test already made into model_latest_tests, so
// the models tasks use today stay usable: each model's newest of its latest
// Test all models result and the passed test it was added with.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { changesData } from "../src/release/migration-rules";
import { readLatestTests, readUsableModels } from "../src/models/usable";
import { routeTask } from "../src/models/tasks";
import { seedPrices, userFor } from "./test-plugin";

const migration = env.TEST_MIGRATIONS.find((m) => m.name === "0013_models_one_table.sql")!;
const carryOver = migration.queries.find((q) => q.includes("INSERT INTO model_latest_tests"))!;
let userId: string;

const passed = (at: string) => JSON.stringify({ at, location: "global", status: 200, costUsd: 0.000001 });

beforeEach(async () => {
  await seedPrices();
  userId = (await userFor("owner-sub")).id;
});

describe("migration 0013", () => {
  it("only adds: tables, columns and rows", () => {
    expect(carryOver).toBeDefined();
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
});
