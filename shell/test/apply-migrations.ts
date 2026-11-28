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

// Each test starts from empty tables, rows that point at users first.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM model_tests"),
    env.DB.prepare("DELETE FROM model_latest_tests"),
    env.DB.prepare("DELETE FROM model_price_caps"),
    env.DB.prepare("DELETE FROM model_test_runs"),
    env.DB.prepare("DELETE FROM provider_model_lists"),
    env.DB.prepare("DELETE FROM task_routes"),
    env.DB.prepare("DELETE FROM model_price_figures"),
    env.DB.prepare("DELETE FROM strength_lines"),
    env.DB.prepare("DELETE FROM model_price_rows"),
    env.DB.prepare("DELETE FROM openrouter_catalogs"),
    env.DB.prepare("DELETE FROM price_rows"),
    env.DB.prepare("DELETE FROM price_snapshots"),
    env.DB.prepare("DELETE FROM price_alerts"),
    env.DB.prepare("DELETE FROM model_calls"),
    env.DB.prepare("DELETE FROM vault_items"),
    env.DB.prepare("DELETE FROM vault_keys"),
    env.DB.prepare("DELETE FROM provider_connections"),
    env.DB.prepare("DELETE FROM provider_checks"),
    env.DB.prepare("DELETE FROM help_requests"),
    env.DB.prepare("DELETE FROM provider_budgets"),
    env.DB.prepare("DELETE FROM task_models"),
    env.DB.prepare("DELETE FROM user_models"),
    env.DB.prepare("DELETE FROM data_migration_steps"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM sqlite_sequence"),
  ]);
});
