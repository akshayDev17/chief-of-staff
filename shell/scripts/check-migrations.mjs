#!/usr/bin/env node
// `make migrations`: applies every migration, in order, to a fresh local D1
// that holds only the made-up persona (design-v3 8.4), with Cloudflare's own
// `wrangler d1 migrations apply --local`. The migrations up to the one named
// on the first line of test/persona-seed.sql apply to the empty database, the
// persona's rows go in, and every later migration applies on top of them. A
// failing file fails the build.
//
//   node scripts/check-migrations.mjs <persist-to dir>
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [persistArg] = process.argv.slice(2);
if (!persistArg) throw new Error("usage: check-migrations.mjs <persist-to dir>");
const SEED = "test/persona-seed.sql";

// A copy of the configuration whose migrations folder fills in two steps.
const stage = mkdtempSync(join(tmpdir(), "cos-migrations-"));
mkdirSync(join(stage, "migrations"));
writeFileSync(
  join(stage, "wrangler.jsonc"),
  JSON.stringify({
    name: "migrations-check",
    compatibility_date: "2026-11-01",
    d1_databases: [{ binding: "DB", database_name: "chief-of-staff", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "migrations" }],
  }),
);
const local = ["chief-of-staff", "--local", "--persist-to", resolve(persistArg), "-c", join(stage, "wrangler.jsonc")];
const d1 = (...args) =>
  execFileSync("npx", ["wrangler", "d1", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, CI: "1" } });
const applyStaged = (names) => {
  for (const f of names) copyFileSync(join("migrations", f), join(stage, "migrations", f));
  if (names.length) d1("migrations", "apply", ...local);
};

const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
const after = /^-- after: (\S+)/.exec(readFileSync(SEED, "utf8"))?.[1];
if (!after || !files.includes(after)) throw new Error(`${SEED} must name an existing migration on its first line`);
const split = files.indexOf(after) + 1;

let users;
try {
  applyStaged(files.slice(0, split));
  d1("execute", ...local, "--yes", "--file", resolve(SEED));
  applyStaged(files.slice(split));
  users = JSON.parse(d1("execute", ...local, "--json", "--command", "SELECT email FROM users")).at(-1).results;
} finally {
  rmSync(stage, { recursive: true, force: true });
}
if (users.length !== 1 || users[0].email !== "morgan.sample@example.com") throw new Error(`expected only the persona, found ${JSON.stringify(users)}`);
console.log(`migrations: ${files.length} applied in order, ${files.length - split} of them over the persona's rows`);
