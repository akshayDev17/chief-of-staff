// Each object upgrades its own storage (design-v3 8.4; src/objects/storage.ts):
// the upgrade machinery against step lists of its own, inside a real Durable
// Object's SQLite storage.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { appliedSteps, upgradeStorage, VERSION_TABLE, type StorageStep } from "../src/objects/storage";

const table = (name: string): StorageStep => ({ name: `make ${name}`, apply: (sql) => void sql.exec(`CREATE TABLE ${name} (v TEXT)`) });

// A fresh Owner object as a scratch database: it has no storage steps of
// its own (src/objects/owner.ts), so only the version table is in it.
const scratch = () => env.OWNER.get(env.OWNER.newUniqueId());

const tables = (sql: SqlStorage) =>
  sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
    .toArray()
    .map((r) => r.name);

describe("upgradeStorage", () => {
  it("applies every step of a fresh object in order and records each", async () => {
    await runInDurableObject(scratch(), (_, state) => {
      const at = new Date("2026-11-29T10:00:00.000Z");
      expect(upgradeStorage(state.storage, [table("a"), table("b")], () => at)).toEqual({ from: 0, to: 2 });
      expect(appliedSteps(state.storage.sql)).toEqual([
        { step: 1, name: "make a", appliedAt: at.toISOString() },
        { step: 2, name: "make b", appliedAt: at.toISOString() },
      ]);
      expect(tables(state.storage.sql)).toEqual([VERSION_TABLE, "a", "b"]);
    });
  });

  it("applies only the steps an older storage lacks, keeping its data", async () => {
    await runInDurableObject(scratch(), (_, state) => {
      upgradeStorage(state.storage, [table("a")]);
      state.storage.sql.exec("INSERT INTO a (v) VALUES ('kept')");
      expect(upgradeStorage(state.storage, [table("a"), table("b"), table("c")])).toEqual({ from: 1, to: 3 });
      expect(appliedSteps(state.storage.sql).map((s) => s.step)).toEqual([1, 2, 3]);
      expect(state.storage.sql.exec("SELECT v FROM a").toArray()).toEqual([{ v: "kept" }]);
    });
  });

  it("does nothing on storage already at the code's step", async () => {
    await runInDurableObject(scratch(), (_, state) => {
      const steps = [table("a")];
      upgradeStorage(state.storage, steps);
      expect(upgradeStorage(state.storage, steps)).toEqual({ from: 1, to: 1 });
      expect(appliedSteps(state.storage.sql)).toHaveLength(1);
    });
  });

  it("rolls a failed step back whole, with its version row, and stops there", async () => {
    await runInDurableObject(scratch(), (_, state) => {
      const failing: StorageStep = {
        name: "half done",
        apply(sql) {
          sql.exec("CREATE TABLE half (v TEXT)");
          throw new Error("step failed");
        },
      };
      expect(() => upgradeStorage(state.storage, [table("a"), failing, table("c")])).toThrow("step failed");
      expect(appliedSteps(state.storage.sql).map((s) => s.name)).toEqual(["make a"]);
      expect(tables(state.storage.sql)).toEqual([VERSION_TABLE, "a"]);
      // The next wake tries the failed step again.
      expect(upgradeStorage(state.storage, [table("a"), table("half"), table("c")])).toEqual({ from: 1, to: 3 });
    });
  });

  it("leaves storage newer than the code as it is: a Worker rollback applies nothing", async () => {
    await runInDurableObject(scratch(), (_, state) => {
      upgradeStorage(state.storage, [table("a"), table("b")]);
      expect(upgradeStorage(state.storage, [table("a")])).toEqual({ from: 2, to: 2 });
      expect(appliedSteps(state.storage.sql).map((s) => s.step)).toEqual([1, 2]);
    });
  });

  it("refuses a step list whose stored steps were renamed or reordered", async () => {
    await runInDurableObject(scratch(), (_, state) => {
      upgradeStorage(state.storage, [table("a"), table("b")]);
      expect(() => upgradeStorage(state.storage, [table("b"), table("a"), table("c")])).toThrow('storage step 1 is "make a" in storage but "make b" in code');
      expect(appliedSteps(state.storage.sql).map((s) => s.step)).toEqual([1, 2]);
    });
  });

  it("refuses two steps with one name", async () => {
    await runInDurableObject(scratch(), (_, state) => {
      expect(() => upgradeStorage(state.storage, [table("a"), table("a")])).toThrow("two storage steps share one name");
    });
  });
});
