// Every D1 row carries the user it belongs to (design-v3 2.4, 11.3): after
// every migration, each table has a `user_id` column, or is one of the
// app's own tables below, which hold no user's data. A new table without a
// `user_id` fails here until it gets one or is added below with its reason.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// The app's own tables: the users themselves, and the price table, which is
// OpenRouter's public list read for everyone.
const APP_WIDE: Record<string, string> = {
  users: "the users themselves; every other user-owned row points at one",
  price_snapshots: "the price table's snapshots, read for every user from OpenRouter's public list",
  price_rows: "the old price table's rows, no longer written (0012)",
  price_alerts: "alerts for the maintainers about the price table",
  bedrock_catalogs: "Bedrock's public model list per snapshot, no longer written (0012)",
  model_price_rows: "the price table's rows",
  openrouter_catalogs: "OpenRouter's public model list per snapshot",
  model_price_figures: "each model's typical price at its OpenRouter hosts, per snapshot",
  strength_lines: "the month's strength lines drawn from the public list",
  price_host_reads: "the hosts still to be read for the current snapshot",
};

// D1's and SQLite's own bookkeeping.
const SYSTEM = (name: string) => name.startsWith("sqlite_") || name.startsWith("_cf_") || name === "d1_migrations";

describe("D1 rows", () => {
  it("each table carries its user, or is one of the app's own", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
    const tables = results.map((r) => r.name).filter((n) => !SYSTEM(n));
    const missing: string[] = [];
    for (const name of tables) {
      const { results: columns } = await env.DB.prepare(`SELECT name FROM pragma_table_info('${name}')`).all<{ name: string }>();
      const hasUser = columns.some((c) => c.name === "user_id");
      if (!hasUser && !(name in APP_WIDE)) missing.push(name);
      // A table on the list that gained a user is no longer app-wide.
      if (hasUser) expect(APP_WIDE, `${name} carries user_id; take it off the app-wide list`).not.toHaveProperty(name);
    }
    expect(missing, "tables with no user_id that are not the app's own").toEqual([]);
    // Every table on the list still exists, so the list cannot go stale.
    expect(Object.keys(APP_WIDE).filter((n) => !tables.includes(n))).toEqual([]);
  });
});
