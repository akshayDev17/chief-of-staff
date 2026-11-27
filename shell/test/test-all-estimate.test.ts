// Test all models' estimate against what a real run cost (2026-11-27: $0.35
// billed against a $0.07 estimate). The fixture is one answered test call
// per model from that run, as OpenRouter reported its cost, with each
// model's public list entry: the per-search fees and the input tokens some
// models bill for a one-line prompt are what the old estimate missed.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { estimateTests, ESTIMATE_INPUT_TOKENS, measuredTestCosts, TEST_ALL_TASK } from "../src/models/test-all";
import { listOffer } from "../src/models/test-model";
import { parseModels } from "../src/prices/openrouter";
import { writeSnapshot } from "../src/prices/store";
import { openrouterPlugin, TEST_MAX_TOKENS } from "../src/providers/openrouter";
import type { SecretStore } from "../src/providers/secrets";
import run from "./fixtures/test-all-costs.json";
import { userFor } from "./test-plugin";

const NOW = new Date("2026-11-27T09:49:00Z");
const none: SecretStore = { put: async () => {}, read: async () => undefined, remove: async () => {} };
const parsed = parseModels({ data: run.models.map((m) => m.listed) }, NOW);
const plugin = openrouterPlugin({ APP_ORIGIN: "https://cos.example.com" }, none, parsed.catalog);
const real = run.models.reduce((sum, m) => sum + m.call.cost_usd, 0);
let userId: string;

beforeEach(async () => {
  userId = (await userFor("owner-sub")).id;
  await writeSnapshot(env.DB, { takenAt: NOW.toISOString(), status: "good", results: [], catalog: parsed.catalog, rows: parsed.rows });
});

const offers = () => listOffer(env.DB, { openrouter: plugin }, userId, "openrouter");

describe("Test all models' estimate", () => {
  it("was far below the run's real cost when it priced only the test's tokens", async () => {
    const tokensOnly = (await offers()).reduce((sum, r) => sum + (ESTIMATE_INPUT_TOKENS * r.price!.input + TEST_MAX_TOKENS * r.price!.output + (r.price!.request ?? 0)) / 1e6, 0);
    expect(real / tokensOnly).toBeGreaterThan(10);
  });

  it("adds one search for each model that searches on its own, before any run", async () => {
    const plan = estimateTests(await offers(), plugin, new Map());
    const searching = run.models.filter((m) => m.listed.supported_parameters.includes("web_search_options") && Number(m.listed.pricing.web_search ?? 0) > 0);
    expect(searching.map((m) => m.listed.id)).toEqual(["perplexity/sonar-deep-research", "perplexity/sonar", "sakana/fugu-ultra-v2"]);
    for (const m of searching) expect(plan.find((p) => p.model === m.listed.id)!.estimateUsd).toBeGreaterThanOrEqual(Number(m.listed.pricing.web_search));
    // Models that charge search only when asked to search are not charged one.
    const astra = plan.find((p) => p.model === "openai/gpt-6-astra-pro")!;
    expect(astra.estimateUsd).toBeLessThan(Number(run.models.find((m) => m.listed.id === "openai/gpt-6-astra-pro")!.listed.pricing.web_search));
  });

  it("is what the last run cost, once every model has a measured test call", async () => {
    await env.DB.batch(
      run.models.map((m, i) =>
        env.DB
          .prepare(
            `INSERT INTO model_calls (user_id, at, task, provider, model, region, plugin_version, status, fallback, input_tokens, output_tokens, duration_ms, cost_usd)
             VALUES (?, ?, ?, 'openrouter', ?, 'global', 'test', 200, 0, ?, ?, 1, ?)`,
          )
          .bind(userId, new Date(NOW.getTime() + i * 1000).toISOString(), TEST_ALL_TASK, m.listed.id, m.call.input_tokens, m.call.output_tokens, m.call.cost_usd),
      ),
    );
    const plan = estimateTests(await offers(), plugin, await measuredTestCosts(env.DB, userId, "openrouter"));
    expect(plan.every((p) => p.measured)).toBe(true);
    expect(plan.reduce((sum, p) => sum + p.estimateUsd, 0)).toBeCloseTo(real, 10);
  });

  it("takes each model's latest answered call, and never a refused one, which cost nothing", async () => {
    const insert = (at: string, status: number, cost: number) =>
      env.DB
        .prepare(
          `INSERT INTO model_calls (user_id, at, task, provider, model, region, plugin_version, status, fallback, duration_ms, cost_usd)
           VALUES (?, ?, ?, 'openrouter', 'perplexity/sonar', 'global', 'test', ?, 0, 1, ?)`,
        )
        .bind(userId, at, TEST_ALL_TASK, status, cost)
        .run();
    await insert("2026-11-27T09:00:00Z", 200, 0.004);
    await insert("2026-11-27T09:30:00Z", 200, 0.00501);
    await insert("2026-11-27T09:40:00Z", 429, 0);
    expect((await measuredTestCosts(env.DB, userId, "openrouter")).get("perplexity/sonar")).toBe(0.00501);
  });
});
