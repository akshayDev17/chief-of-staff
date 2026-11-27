#!/usr/bin/env node
// `make issuer-keys-check` (part of `make test`): runs issuer-keys.mjs for
// real in a temporary directory and checks what it made and printed. The
// owner runs it; this keeps that run honest. No account is touched.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "issuer-keys.mjs");
const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
const fail = (message) => {
  console.error(`check-issuer-keys: ${message}`);
  process.exit(1);
};

const dir = mkdtempSync(join(tmpdir(), "cos-issuer-keys-"));
try {
  const out = join(dir, "keys");
  const printed = run("keys", out);
  const issuerFile = join(out, "issuer-keys.json");
  const keys = JSON.parse(readFileSync(issuerFile, "utf8"));
  const [key] = keys.keys;
  if (keys.signing !== key.kid || !key.d) fail("issuer-keys.json must hold one private signing key named by its kid");
  if ((statSync(issuerFile).mode & 0o077) !== 0) fail("issuer-keys.json must be readable by its owner only");
  // Nothing private is printed: not the issuer key's private members.
  for (const secret of [key.d, key.p, key.q]) if (printed.includes(secret)) fail("a private half was printed");
  if (/PRIVATE KEY/.test(printed)) fail("a private key was printed");
  if (!printed.includes(`npx wrangler secret put ISSUER_KEYS < ${issuerFile}`)) fail("the ISSUER_KEYS command is missing");
  // A second run never overwrites.
  if (spawnSync(process.execPath, [script, "keys", out]).status === 0) fail("keys overwrote an existing key");
  // Never inside the repository.
  if (spawnSync(process.execPath, [script, "keys", resolve(here, "keys-here")]).status === 0) fail("keys wrote inside the repository");

  // A whole rotation: publish, sign, retire.
  run("rotate", issuerFile, "publish");
  const published = JSON.parse(readFileSync(issuerFile, "utf8"));
  if (published.keys.length !== 2 || published.signing !== key.kid) fail("publish must add a key and keep signing with the old one");
  run("rotate", issuerFile, "sign");
  const signing = JSON.parse(readFileSync(issuerFile, "utf8"));
  if (signing.signing === key.kid || signing.keys.length !== 2) fail("sign must switch to the new key with both published");
  run("rotate", issuerFile, "retire");
  const retired = JSON.parse(readFileSync(issuerFile, "utf8"));
  if (retired.keys.length !== 1 || retired.keys[0].kid !== signing.signing) fail("retire must leave only the new signing key");
  console.log("issuer-keys: the key and a full issuer-key rotation checked");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
