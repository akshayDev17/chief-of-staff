// The models a user's tasks can use (the owner, 2026-11-27: "quite franky
// remove the add feature altogether"): every model whose latest test passed,
// whichever way it ran (Test on its row, Test all models, Retest failed),
// that the provider's current list still offers the user. A later failed
// test takes the model out; nothing is added or removed by hand.
//
//   latestTestWrite(db, userId, provider, model, state, record, testedAt) -> D1PreparedStatement
//   readLatestTests(db, userId, provider) -> Map<model, LatestTest>
//   readUsableModels(db, userId) -> UsableModel[]
//   readNotUsable(db, userId, models) -> NotUsable[]   why each of them is not usable
//
// "Offers the user": the provider's current model list names the model and
// the app can call it (src/prices/openrouter.ts: not blocked), a router has
// the user's price cap (models/price-caps.ts), and the user's own account
// list, where it has been read, includes it (models/account-list.ts). A model
// that drops out of any of these is not usable, though its pass stays
// recorded, and is usable again once it is back.
//
// A Test all models run that is still testing a model does not change its
// latest test: tasks keep their models while a run goes on.

import type { OpenRouterModel } from "../prices/openrouter";
import { readCurrentCatalog } from "../prices/store";
import { isProvider, type Provider } from "../prices/types";
import type { Link } from "../proxy/plugin";
import { readAccountList, type AccountList } from "./account-list";
import { readPriceCaps, type PriceCap } from "./price-caps";
import type { TestRefusal, TestResult } from "./test-model";

// What a test showed, as stored (model_latest_tests and model_tests): the
// passed call for a pass; the plain reason, the provider's own words, the fix
// and the pages to open for a failure.
export interface TestRecord {
  reason?: TestRefusal;
  text: string;
  reply?: { status: number; errorName?: string; message?: string; repliedModel?: string };
  fix?: string;
  links?: Link[];
  test?: TestResult;
}

export interface LatestTest {
  model: string;
  state: "passed" | "failed";
  testedAt: string;
  result: TestRecord;
}

export interface UsableModel {
  provider: Provider;
  model: string;
  location: string;
  // When its latest test, the one that passed, ran.
  testedAt: string;
  test: TestResult;
}

// The write that makes `record` the model's latest test, unless a newer one
// is there already.
export function latestTestWrite(
  db: D1Database,
  userId: string,
  provider: Provider,
  model: string,
  state: LatestTest["state"],
  record: TestRecord,
  testedAt: Date,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO model_latest_tests (user_id, provider, model, state, result, tested_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (user_id, provider, model) DO UPDATE SET state = excluded.state, result = excluded.result, tested_at = excluded.tested_at
       WHERE excluded.tested_at >= model_latest_tests.tested_at`,
    )
    .bind(userId, provider, model, state, JSON.stringify(record), testedAt.toISOString());
}

export async function readLatestTests(db: D1Database, userId: string, provider: Provider): Promise<Map<string, LatestTest>> {
  const { results } = await db
    .prepare("SELECT model, state, result, tested_at FROM model_latest_tests WHERE user_id = ? AND provider = ?")
    .bind(userId, provider)
    .all<{ model: string; state: LatestTest["state"]; result: string; tested_at: string }>();
  return new Map(results.map((r) => [r.model, { model: r.model, state: r.state, testedAt: r.tested_at, result: JSON.parse(r.result) as TestRecord }]));
}

// Why a model is not usable: its latest test failed; the provider's current
// list no longer names it; the user's own account list leaves it out; a
// router has no price cap; `unknown` for anything else (no passed test, or
// the app cannot call it).
export type NotUsable = "failed" | "not_listed" | "left_out" | "no_cap" | "unknown";

interface OfferChecks {
  listed: Map<string, OpenRouterModel>;
  accounts: Map<Provider, AccountList | undefined>;
  caps: Map<Provider, Map<string, PriceCap>>;
}

async function readOfferChecks(db: D1Database, userId: string, providers: Provider[]): Promise<OfferChecks> {
  const catalog = await readCurrentCatalog(db);
  return {
    listed: new Map((catalog?.models ?? []).map((m) => [m.id, m])),
    accounts: new Map(await Promise.all(providers.map(async (p) => [p, await readAccountList(db, userId, p)] as const))),
    caps: new Map(await Promise.all(providers.map(async (p) => [p, await readPriceCaps(db, userId, p)] as const))),
  };
}

// Why the provider's current list does not offer `model` to the user, or
// undefined when it does.
function notOffered(c: OfferChecks, provider: Provider, model: string): NotUsable | undefined {
  const entry = c.listed.get(model);
  if (!entry) return "not_listed";
  if (entry.blocked) return "unknown";
  if (entry.router && !c.caps.get(provider)?.has(model)) return "no_cap";
  const account = c.accounts.get(provider);
  if (account && !account.models.has(model)) return "left_out";
  return undefined;
}

// The signed-in user's usable models at every provider a plug-in serves,
// ordered by provider and model. Scoped to the user.
export async function readUsableModels(db: D1Database, userId: string): Promise<UsableModel[]> {
  const { results } = await db
    .prepare("SELECT provider, model, result, tested_at FROM model_latest_tests WHERE user_id = ? AND state = 'passed' ORDER BY provider, model")
    .bind(userId)
    .all<{ provider: string; model: string; result: string; tested_at: string }>();
  if (!results.length) return [];
  const checks = await readOfferChecks(db, userId, [...new Set(results.map((r) => r.provider))].filter(isProvider));
  return results.flatMap((r) => {
    if (!isProvider(r.provider) || notOffered(checks, r.provider, r.model)) return [];
    const test = (JSON.parse(r.result) as TestRecord).test;
    if (!test) return [];
    return [{ provider: r.provider, model: r.model, location: test.location, testedAt: r.tested_at, test }];
  });
}

// Why each of `models`, none of them usable, is not usable, in order, by the
// same checks as readUsableModels. Scoped to the user.
export async function readNotUsable(db: D1Database, userId: string, models: Array<{ provider: Provider; model: string }>): Promise<NotUsable[]> {
  if (!models.length) return [];
  const { results } = await db
    .prepare("SELECT provider, model FROM model_latest_tests WHERE user_id = ? AND state = 'failed'")
    .bind(userId)
    .all<{ provider: string; model: string }>();
  const failed = new Set(results.map((r) => `${r.provider}|${r.model}`));
  const checks = await readOfferChecks(db, userId, [...new Set(models.map((m) => m.provider))]);
  return models.map((m) => (failed.has(`${m.provider}|${m.model}`) ? "failed" : (notOffered(checks, m.provider, m.model) ?? "unknown")));
}
