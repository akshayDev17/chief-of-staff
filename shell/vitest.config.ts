import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Every test file starts from a fresh local D1 with migrations/ applied in
// order, the same files `wrangler d1 migrations apply` runs. FILES is a
// local R2 bucket for the per-user file convention (src/files.ts); the
// deployed Worker has no bucket yet.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations }, r2Buckets: ["FILES"] },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
