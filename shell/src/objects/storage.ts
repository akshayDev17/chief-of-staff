// Each Durable Object upgrades its own storage (design-v3 8.4; the rules for
// a step are in README.md, "Each object upgrades its own storage"):
//
//   upgradeStorage(storage, steps, now?) -> { from, to }
//
// The steps applied are rows of the object's own `_sql_schema_migrations`
// table, numbered by their place in the list and checked by name, so a
// reordered or renamed list fails to wake rather than skipping a step. The
// steps the storage lacks run forward and in order, each with its row inside
// one `transactionSync`: a step that throws rolls back with its row and the
// upgrade stops there. Storage newer than the code (a Worker rollback) is
// left as it is. wakeStorage is the constructor's call: the upgrade inside
// `ctx.blockConcurrencyWhile`, so no request reaches the object before its
// storage matches its code, and a step that throws resets the object, whose
// next request tries again.

export interface StorageStep {
  name: string;
  apply(sql: SqlStorage): void;
}

export interface StorageUpgrade {
  // Steps stored before and after this upgrade. `to` stays at `from` when
  // the storage is newer than the code (a Worker rollback).
  from: number;
  to: number;
}

export interface AppliedStep {
  step: number;
  name: string;
  appliedAt: string;
}

export const VERSION_TABLE = "_sql_schema_migrations";

const createVersionTable = (sql: SqlStorage) =>
  sql.exec(`CREATE TABLE IF NOT EXISTS ${VERSION_TABLE} (step INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);

// The steps this object's storage holds, in order.
export function appliedSteps(sql: SqlStorage): AppliedStep[] {
  createVersionTable(sql);
  return sql
    .exec<{ step: number; name: string; applied_at: string }>(`SELECT step, name, applied_at FROM ${VERSION_TABLE} ORDER BY step`)
    .toArray()
    .map((r) => ({ step: r.step, name: r.name, appliedAt: r.applied_at }));
}

export function upgradeStorage(storage: DurableObjectStorage, steps: readonly StorageStep[], now: () => Date = () => new Date()): StorageUpgrade {
  const names = steps.map((s) => s.name);
  if (new Set(names).size !== names.length) throw new Error("two storage steps share one name");
  const applied = appliedSteps(storage.sql);
  applied.forEach((row, i) => {
    if (row.step !== i + 1) throw new Error(`storage step ${i + 1} is missing from ${VERSION_TABLE}`);
    const known = steps[i];
    if (known && known.name !== row.name) {
      throw new Error(`storage step ${row.step} is "${row.name}" in storage but "${known.name}" in code`);
    }
  });
  const from = applied.length;
  for (let i = from; i < steps.length; i++) {
    const step = steps[i]!;
    storage.transactionSync(() => {
      step.apply(storage.sql);
      storage.sql.exec(`INSERT INTO ${VERSION_TABLE} (step, name, applied_at) VALUES (?, ?, ?)`, i + 1, step.name, now().toISOString());
    });
  }
  return { from, to: Math.max(from, steps.length) };
}

// The constructor's call: the upgrade, before any request is delivered,
// resolving to what this wake applied. `kind` names the object in the log
// line an upgrade writes.
export function wakeStorage(ctx: DurableObjectState, kind: string, steps: readonly StorageStep[]): Promise<StorageUpgrade> {
  return ctx.blockConcurrencyWhile(async () => {
    const upgrade = upgradeStorage(ctx.storage, steps);
    if (upgrade.to > upgrade.from) console.log(`${kind} storage upgraded from step ${upgrade.from} to step ${upgrade.to}`);
    if (upgrade.from > steps.length) console.log(`${kind} storage is at step ${upgrade.from}, newer than this code's ${steps.length}; nothing applied`);
    return upgrade;
  });
}
