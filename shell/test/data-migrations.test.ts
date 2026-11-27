import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDataMigration, type DataMigrationJob } from "../src/data-migrations";
import { userFor } from "./test-plugin";

const NOW = new Date("2026-11-25T10:00:00Z");
let users: string[];

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  users = [(await userFor("a-sub")).id, (await userFor("b-sub")).id, (await userFor("c-sub")).id].sort();
});
afterEach(() => vi.restoreAllMocks());

// A two-step backfill: give every user a budget row, then raise it. The
// second step is not idempotent on its own (it adds), so running it twice
// for one user would show.
const job = (ran: string[], failFor?: string): DataMigrationJob => ({
  name: "test-backfill",
  steps: [
    {
      name: "insert",
      async run(db, userId) {
        ran.push(`insert:${userId}`);
        return [
          db.prepare("INSERT INTO provider_budgets (user_id, provider, monthly_usd, set_how, set_at) VALUES (?, 'openrouter', 10, 'typed', ?)")
            .bind(userId, NOW.toISOString()),
        ];
      },
    },
    {
      name: "raise",
      async run(db, userId) {
        if (userId === failFor) throw new Error("interrupted");
        ran.push(`raise:${userId}`);
        return [db.prepare("UPDATE provider_budgets SET monthly_usd = monthly_usd + 5 WHERE user_id = ?").bind(userId)];
      },
    },
  ],
});

const budgets = async () =>
  (await env.DB.prepare("SELECT user_id, monthly_usd FROM provider_budgets ORDER BY user_id").all<{ monthly_usd: number }>()).results.map(
    (r) => r.monthly_usd,
  );

describe("data migrations", () => {
  it("resume after an interruption at the first step not logged, and repeat nothing", async () => {
    const first: string[] = [];
    await expect(runDataMigration(env.DB, job(first, users[1]), () => NOW)).rejects.toThrow("interrupted");
    expect(first).toEqual([`insert:${users[0]}`, `raise:${users[0]}`, `insert:${users[1]}`]);

    const second: string[] = [];
    expect(await runDataMigration(env.DB, job(second), () => NOW)).toEqual({ done: 3, skipped: 3 });
    expect(second).toEqual([`raise:${users[1]}`, `insert:${users[2]}`, `raise:${users[2]}`]);
    expect(await budgets()).toEqual([15, 15, 15]);
  });

  it("are safe to run twice", async () => {
    await runDataMigration(env.DB, job([]), () => NOW);
    const again: string[] = [];
    expect(await runDataMigration(env.DB, job(again), () => NOW)).toEqual({ done: 0, skipped: 6 });
    expect(again).toEqual([]);
    expect(await budgets()).toEqual([15, 15, 15]);
    const { results } = await env.DB.prepare("SELECT count(*) AS n FROM data_migration_steps WHERE job = 'test-backfill'").all<{ n: number }>();
    expect(results[0]!.n).toBe(6);
  });

  it("log each step as it finishes", async () => {
    const log = vi.spyOn(console, "log");
    await runDataMigration(env.DB, job([]), () => NOW);
    expect(log).toHaveBeenCalledWith(`data migration test-backfill: user ${users[0]} step insert done`);
  });

  it("refuse a job with two steps of one name", async () => {
    const twice = { name: "bad", steps: [job([]).steps[0]!, job([]).steps[0]!] };
    await expect(runDataMigration(env.DB, twice)).rejects.toThrow(/two steps with one name/);
  });
});

describe("schema migrations", () => {
  it("all apply, in order, to the fresh test database", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(env.TEST_MIGRATIONS.map((m) => m.name));
    expect(results.length).toBeGreaterThanOrEqual(6);
  });
});
