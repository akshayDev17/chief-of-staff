#!/usr/bin/env node
// `make rollback-check`: runs roll-back-prices.mjs against a fresh local D1
// with the migrations applied (at the directory given), the way a maintainer
// runs it against the deployed one, and checks what it changed.
import { execFileSync } from "node:child_process";
import { deepStrictEqual } from "node:assert/strict";

const [persistTo] = process.argv.slice(2);
if (!persistTo) throw new Error("usage: check-price-rollback.mjs <persist-to dir>");
const local = ["--local", "--persist-to", persistTo];

const query = (sql) =>
  JSON.parse(
    execFileSync("npx", ["wrangler", "d1", "execute", "chief-of-staff", ...local, "--yes", "--json", "--command", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  ).at(-1).results;
const rollBack = () =>
  JSON.parse(execFileSync("node", ["scripts/roll-back-prices.mjs", ...local], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));

query(
  `INSERT INTO price_snapshots (taken_at, status, results) VALUES
     ('2026-11-23T06:00:00.000Z', 'good', '[]'), ('2026-11-24T06:00:00.000Z', 'partial', '[]')`,
);

deepStrictEqual(rollBack(), { id: 1, taken_at: "2026-11-23T06:00:00.000Z", status: "good" });
deepStrictEqual(query("SELECT id, status FROM price_snapshots ORDER BY id"), [
  { id: 1, status: "good" },
  { id: 2, status: "rolled_back" },
]);
deepStrictEqual(query("SELECT kind, detail FROM price_alerts ORDER BY id"), [
  { kind: "rolled_back", detail: "snapshot 2 of 2026-11-24T06:00:00.000Z rolled back" },
]);
const [{ created_at: createdAt }] = query("SELECT created_at FROM price_alerts");
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)) throw new Error(`alert time ${createdAt} is not ISO 8601`);

// Rolling back the last snapshot leaves none current; with none current, a
// rollback changes nothing and records nothing.
deepStrictEqual(rollBack(), null);
deepStrictEqual(rollBack(), null);
deepStrictEqual(query("SELECT count(*) AS n FROM price_alerts"), [{ n: 2 }]);
console.log("rollback-check: ok");
