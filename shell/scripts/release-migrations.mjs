#!/usr/bin/env node
// The release pipeline's look at the deployed D1 before it migrates
// (.github/workflows/release-shell.yml; design-v3 8.4). Needs
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (T10).
//
//   node scripts/release-migrations.mjs
//
// Reads which migrations the deployed database has applied (its
// `d1_migrations` table; none on a database never migrated), and prints, as
// JSON, the pending files in order and those among them that may change or
// remove existing data (src/release/migration-rules.ts). When any may, it
// also records D1's current Time Travel bookmark
// (`wrangler d1 time-travel info chief-of-staff --json`) in the output, so
// the release can name it. It changes nothing.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { changesData, pendingMigrations } from "../src/release/migration-rules.ts";

const DATABASE = "chief-of-staff";
const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const appliedMigrations = () => {
  const tables = JSON.parse(
    wrangler(["d1", "execute", DATABASE, "--remote", "--json", "--command", "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'"]),
  ).at(-1).results;
  if (!tables.length) return [];
  return JSON.parse(wrangler(["d1", "execute", DATABASE, "--remote", "--json", "--command", "SELECT name FROM d1_migrations"]))
    .at(-1)
    .results.map((r) => r.name);
};

try {
  const pending = pendingMigrations(readdirSync("migrations"), appliedMigrations());
  const changing = pending.filter((f) => changesData(readFileSync(`migrations/${f}`, "utf8")));
  const bookmark = changing.length ? JSON.parse(wrangler(["d1", "time-travel", "info", DATABASE, "--json"])).bookmark : null;
  if (changing.length && !bookmark) throw new Error("Time Travel gave no bookmark; not migrating without one");
  console.log(JSON.stringify({ pending, changesData: changing, bookmark }));
} catch (error) {
  console.error(`release-migrations: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
