#!/usr/bin/env node
// Rolls the price table back to the snapshot before the newest one, and
// records the rolled_back alert, through Wrangler (T11; design-v3 1.3). Run by
// a maintainer after a bad refresh: `make roll-back-prices` for the deployed
// D1, which needs T10's Cloudflare token in CLOUDFLARE_API_TOKEN. The SQL is
// src/prices/rollback.ts, the same statements the Worker runs.
//
//   node scripts/roll-back-prices.mjs --remote
//   node scripts/roll-back-prices.mjs --local --persist-to <dir>
//
// Prints the snapshot current afterwards as JSON. Refuses, changing nothing
// and exiting non-zero, when no earlier snapshot would stay current.
import { execFileSync } from "node:child_process";
import { ROLL_BACK_REFUSED, ROLL_BACK_STATEMENTS } from "../src/prices/rollback.ts";

const CURRENT = "SELECT id, taken_at, status FROM price_snapshots WHERE status != 'rolled_back' ORDER BY id DESC LIMIT 1";

const readTarget = (args) => {
  if (args.length === 1 && args[0] === "--remote") return args;
  if (args.length === 3 && args[0] === "--local" && args[1] === "--persist-to") return args;
  throw new Error("usage: roll-back-prices.mjs --remote | --local --persist-to <dir>");
};

// Each statement's result, with its rows in `results`.
const executeSql = (target, sql) =>
  JSON.parse(
    execFileSync("npx", ["wrangler", "d1", "execute", "chief-of-staff", ...target, "--yes", "--json", "--command", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );

try {
  const target = readTarget(process.argv.slice(2));
  const rolledBack = executeSql(target, ROLL_BACK_STATEMENTS.join(";\n"));
  if (!rolledBack.at(-1)?.results[0]?.rolled_back) throw new Error(ROLL_BACK_REFUSED);
  const [current] = executeSql(target, CURRENT);
  console.log(JSON.stringify(current.results[0]));
} catch (error) {
  console.error(`roll-back-prices: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
