import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { changesData, pendingMigrations } from "../src/release/migration-rules";

describe("pending migrations", () => {
  it("are the .sql files D1 has not applied, in order", () => {
    expect(pendingMigrations(["0002_b.sql", "0000_a.sql", "0001_c.sql", "README.md"], ["0000_a.sql"])).toEqual(["0001_c.sql", "0002_b.sql"]);
    expect(pendingMigrations(["0000_a.sql"], ["0000_a.sql"])).toEqual([]);
  });

  it("include every .sql file wrangler applies, whatever its name", () => {
    expect(pendingMigrations(["0006_Fix.sql", "0005_a.sql", "fix-up.sql", ".draft.sql"], ["0005_a.sql"])).toEqual(["0006_Fix.sql", "fix-up.sql"]);
  });
});

describe("a migration that changes or removes data", () => {
  it("is anything but adding tables, indexes, views, columns and rows", () => {
    expect(changesData("CREATE TABLE t (a TEXT);\nCREATE INDEX i ON t (a);\n-- DROP TABLE t; is only a comment")).toBe(false);
    expect(changesData("ALTER TABLE t ADD COLUMN b INTEGER NOT NULL DEFAULT 0; INSERT INTO t (a) VALUES ('x');")).toBe(false);
    expect(changesData("INSERT INTO t (a) VALUES ('x') ON CONFLICT (a) DO NOTHING")).toBe(false);
    for (const sql of [
      "DROP TABLE t",
      "ALTER TABLE t DROP COLUMN a",
      "ALTER TABLE t RENAME TO u",
      "UPDATE t SET a = 1",
      "DELETE FROM t",
      "INSERT OR REPLACE INTO t VALUES (1)",
      "REPLACE INTO t VALUES (1)",
      "INSERT INTO t (a, b) VALUES ('x', 1) ON CONFLICT (a) DO UPDATE SET b = excluded.b",
      "insert into t (a) select a from u on conflict do\n  update set a = excluded.a",
      "CREATE TABLE u (a); /* then */ DROP TABLE t",
    ]) {
      expect(changesData(sql), sql).toBe(true);
    }
  });

  it("is, among the migrations shipped so far, only the one that rebuilds the price alerts table", () => {
    expect(env.TEST_MIGRATIONS.filter((m) => changesData(m.queries.join(";\n"))).map((m) => m.name)).toEqual([
      "0006_add_price_missing_alert.sql",
    ]);
  });
});
