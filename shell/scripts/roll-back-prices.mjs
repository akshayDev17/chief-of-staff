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
// Prints the snapshot current afterwards as JSON, or null when none is left.
import { execFileSync } from "node:child_process";
import { ROLL_BACK_STATEMENTS } from "../src/prices/rollback.ts";

const CURRENT = "SELECT id, taken_at, status FROM price_snapshots WHERE status != 'rolled_back' ORDER BY id DESC LIMIT 1";

const readTarget = (args) => {
  if (args.length === 1 && args[0] === "--remote") return args;
  if (args.length === 3 && args[0] === "--local" && args[1] === "--persist-to") return args;
  throw new Error("usage: roll-back-prices.mjs --remote | --local --persist-to <dir>");
};

// Each statement's rows.
const executeSql = (target, sql) =>
  JSON.parse(
    execFileSync("npx", ["wrangler", "d1", "execute", "chief-of-staff", ...target, "--yes", "--json", "--command", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  ).map((statement) => statement.results);

try {
  const target = readTarget(process.argv.slice(2));
  executeSql(target, ROLL_BACK_STATEMENTS.join(";\n"));
  const [current] = executeSql(target, CURRENT);
  console.log(JSON.stringify(current[0] ?? null));
} catch (error) {
  console.error(`roll-back-prices: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
