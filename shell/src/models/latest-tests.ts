// Each model's latest real call, kept per user and model: a Test on its row,
// or a task's own call (models/ready.ts recordUse). It is no input to Ready
// (the owner, 2026-11-28: "why would i as a user wanna waste my money on
// testing models i dont wish to test"); a failed one marks its row Failed
// when used (or when tested) until a later call of the model works.
//
//   latestTestWrite(db, userId, provider, model, state, record, testedAt) -> D1PreparedStatement
//   readLatestTests(db, userId, provider) -> Map<model, LatestTest>
//
// A call counts only for the key that made it: one made before the
// provider's current connection (connected_at, moved by each Connect that
// makes a new key) was made on an earlier key, whose account may have other
// settings, so it marks nothing.

import type { Link } from "../proxy/plugin";
import type { TestRefusal, TestResult } from "./test-model";

// What a call showed, as stored (model_latest_tests): the passed test call
// for a passed Test; the plain reason, the provider's own words, the fix and
// the pages to open for a failure. `used`: a task's own call made it, not a Test.
export interface TestRecord {
  reason?: TestRefusal;
  text: string;
  reply?: { status: number; errorName?: string; message?: string; repliedModel?: string };
  fix?: string;
  links?: Link[];
  test?: TestResult;
  used?: true;
}

export interface LatestTest {
  model: string;
  state: "passed" | "failed";
  testedAt: string;
  result: TestRecord;
  // Made before the provider's current connection: on an earlier key.
  earlierKey?: true;
}

// A call made at `testedAt` ran on an earlier key than the connection made at
// `connectedAt`. With no connection there is no current key to compare.
export const onEarlierKey = (testedAt: string, connectedAt: string | null | undefined): boolean =>
  Boolean(connectedAt) && Date.parse(testedAt) < Date.parse(connectedAt!);

// The write that makes `record` the model's latest call, unless a newer one
// is there already.
export function latestTestWrite(
  db: D1Database,
  userId: string,
  provider: string,
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

interface LatestRecord {
  model: string;
  state: LatestTest["state"];
  result: string;
  tested_at: string;
  connected_at: string | null;
}

// Each model's latest call at `provider`, marked when it ran on an earlier key.
export async function readLatestTests(db: D1Database, userId: string, provider: string): Promise<Map<string, LatestTest>> {
  const { results } = await db
    .prepare(
      `SELECT t.model, t.state, t.result, t.tested_at, c.connected_at FROM model_latest_tests t
       LEFT JOIN provider_connections c ON c.user_id = t.user_id AND c.provider = t.provider WHERE t.user_id = ? AND t.provider = ?`,
    )
    .bind(userId, provider)
    .all<LatestRecord>();
  return new Map(
    results.map((r) => [
      r.model,
      { model: r.model, state: r.state, testedAt: r.tested_at, result: JSON.parse(r.result) as TestRecord, ...(onEarlierKey(r.tested_at, r.connected_at) ? { earlierKey: true as const } : {}) },
    ]),
  );
}
