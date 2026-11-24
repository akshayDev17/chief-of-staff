import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Each test starts from an empty price table.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM price_rows"),
    env.DB.prepare("DELETE FROM price_snapshots"),
    env.DB.prepare("DELETE FROM price_alerts"),
    env.DB.prepare("DELETE FROM sqlite_sequence"),
  ]);
});
