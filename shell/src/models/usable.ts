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
//
// A test counts only for the key that ran it: one made before the
// provider's current connection (connected_at, written on each Connect, which
// makes a new key) was made on an earlier key, so its model is not usable
// and its row reads Not tested yet until a test on the current key. A key
// whose account has no credit fails calls that the earlier key's passed.

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
  // Made before the provider's current connection: on an earlier key.
  earlierKey?: true;
}

// A test made at `testedAt` ran on an earlier key than the connection made at
// `connectedAt`. With no connection there is no current key to compare.
export const onEarlierKey = (testedAt: string, connectedAt: string | null | undefined): boolean =>
  Boolean(connectedAt) && Date.parse(testedAt) < Date.parse(connectedAt!);

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

// Each latest test with the provider's current connection, for onEarlierKey.
const LATEST_WITH_KEY = `SELECT t.provider, t.model, t.state, t.result, t.tested_at, c.connected_at FROM model_latest_tests t
  LEFT JOIN provider_connections c ON c.user_id = t.user_id AND c.provider = t.provider WHERE t.user_id = ?`;

interface LatestRecord {
  provider: string;
  model: string;
  state: LatestTest["state"];
  result: string;
  tested_at: string;
  connected_at: string | null;
}

export async function readLatestTests(db: D1Database, userId: string, provider: Provider): Promise<Map<string, LatestTest>> {
  const { results } = await db.prepare(`${LATEST_WITH_KEY} AND t.provider = ?`).bind(userId, provider).all<LatestRecord>();
  return new Map(
    results.map((r) => [
      r.model,
      { model: r.model, state: r.state, testedAt: r.tested_at, result: JSON.parse(r.result) as TestRecord, ...(onEarlierKey(r.tested_at, r.connected_at) ? { earlierKey: true as const } : {}) },
    ]),
  );
}

// Why a model is not usable: its latest test failed; the provider's current
// list no longer names it; the user's own account list leaves it out; a
// router has no price cap; its latest test ran on an earlier key; `unknown`
// for anything else (no passed test, or the app cannot call it).
export type NotUsable = "failed" | "not_listed" | "left_out" | "no_cap" | "earlier_key" | "unknown";

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
// ordered by provider and model: passed on the current key and offered.
// Scoped to the user.
export async function readUsableModels(db: D1Database, userId: string): Promise<UsableModel[]> {
  const { results: latest } = await db.prepare(`${LATEST_WITH_KEY} AND t.state = 'passed' ORDER BY t.provider, t.model`).bind(userId).all<LatestRecord>();
  const results = latest.filter((r) => !onEarlierKey(r.tested_at, r.connected_at));
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
// A failed test on the current key leads; then the provider's list; then a
// test on an earlier key, which a test on the current key replaces.
export async function readNotUsable(db: D1Database, userId: string, models: Array<{ provider: Provider; model: string }>): Promise<NotUsable[]> {
  if (!models.length) return [];
  const { results } = await db.prepare(LATEST_WITH_KEY).bind(userId).all<LatestRecord>();
  const latest = new Map(results.map((r) => [`${r.provider}|${r.model}`, r]));
  const checks = await readOfferChecks(db, userId, [...new Set(models.map((m) => m.provider))]);
  return models.map((m) => {
    const l = latest.get(`${m.provider}|${m.model}`);
    const earlier = l ? onEarlierKey(l.tested_at, l.connected_at) : false;
    if (l?.state === "failed" && !earlier) return "failed";
    return notOffered(checks, m.provider, m.model) ?? (earlier ? "earlier_key" : "unknown");
  });
}
