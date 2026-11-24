#!/usr/bin/env node
// `make provider-setup-check` (part of `make test`): runs provider-setup.mjs
// for real in a temporary directory and checks what it made and printed. The
// owner runs it once under T10; this keeps that run honest. No account is
// touched.
import { execFileSync, spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "provider-setup.mjs");
const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
const fail = (message) => {
  console.error(`check-provider-setup: ${message}`);
  process.exit(1);
};

const dir = mkdtempSync(join(tmpdir(), "cos-provider-setup-"));
try {
  const out = join(dir, "keys");
  const printed = run("keys", out);
  const issuerFile = join(out, "issuer-keys.json");
  const keys = JSON.parse(readFileSync(issuerFile, "utf8"));
  const [key] = keys.keys;
  if (keys.signing !== key.kid || !key.d) fail("issuer-keys.json must hold one private signing key named by its kid");
  for (const f of ["issuer-keys.json", "entra-key.pem", "entra-cert.pem"]) {
    if (f !== "entra-cert.pem" && (statSync(join(out, f)).mode & 0o077) !== 0) fail(`${f} must be readable by its owner only`);
  }
  // Nothing private is printed: not the issuer key's private members, not the PEM.
  const pem = readFileSync(join(out, "entra-key.pem"), "utf8");
  for (const secret of [key.d, key.p, key.q, pem.split("\n")[1]]) if (printed.includes(secret)) fail("a private half was printed");
  if (/PRIVATE KEY/.test(printed)) fail("a private key was printed");
  if (!printed.includes(`npx wrangler secret put ISSUER_KEYS < ${issuerFile}`)) fail("the ISSUER_KEYS command is missing");
  if (!printed.includes("npx wrangler secret put ENTRA_CERT_KEY <")) fail("the ENTRA_CERT_KEY command is missing");
  if (!/ENTRA_CERT_THUMBPRINT=[A-Za-z0-9_-]{43}\n/.test(printed)) fail("the certificate's x5t#S256 thumbprint is missing");
  // The key and the certificate belong together.
  const signature = sign("sha256", Buffer.from("x"), createPrivateKey(pem));
  if (!verify("sha256", Buffer.from("x"), createPublicKey(readFileSync(join(out, "entra-cert.pem"))), signature)) fail("the certificate does not match its key");
  // A second run never overwrites.
  if (spawnSync(process.execPath, [script, "keys", out]).status === 0) fail("keys overwrote an existing key");
  // Never inside the repository.
  if (spawnSync(process.execPath, [script, "keys", resolve(here, "keys-here")]).status === 0) fail("keys wrote inside the repository");

  // A whole rotation: publish, sign, retire.
  run("rotate-issuer", issuerFile, "publish");
  const published = JSON.parse(readFileSync(issuerFile, "utf8"));
  if (published.keys.length !== 2 || published.signing !== key.kid) fail("publish must add a key and keep signing with the old one");
  run("rotate-issuer", issuerFile, "sign");
  const signing = JSON.parse(readFileSync(issuerFile, "utf8"));
  if (signing.signing === key.kid || signing.keys.length !== 2) fail("sign must switch to the new key with both published");
  run("rotate-issuer", issuerFile, "retire");
  const retired = JSON.parse(readFileSync(issuerFile, "utf8"));
  if (retired.keys.length !== 1 || retired.keys[0].kid !== signing.signing) fail("retire must leave only the new signing key");
  console.log("provider-setup: keys, certificate and a full issuer-key rotation checked");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
