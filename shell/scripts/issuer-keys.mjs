#!/usr/bin/env node
// The app's own OpenID Connect issuer key (src/issuer.ts), made and rotated
// by the owner, never by CI. It touches no account: it makes the key locally
// and prints the command that stores it, never its private half. The issuer
// is kept for the coming "Connect Anthropic" build, which authenticates with
// it through workload identity federation; no model provider reads it today.
//
//   node scripts/issuer-keys.mjs keys <dir>
//     Makes the issuer's signing key in <dir> (a directory outside the
//     repository, created with owner-only access), and prints the Wrangler
//     command that stores it as the Worker secret ISSUER_KEYS.
//
//   node scripts/issuer-keys.mjs rotate <issuer-keys.json> publish|sign|retire
//     One step of rotating the issuer key (README "Rotating the issuer key"),
//     rewriting the file and printing the Wrangler command to store it.

import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rotateIssuerKeys } from "./issuer-keys-lib.mjs";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const base64url = (buffer) => Buffer.from(buffer).toString("base64url");

// RFC 7638: the key's id is the SHA-256 of its required public members.
const jwkThumbprint = (jwk) => base64url(createHash("sha256").update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest());

function generateIssuerKey() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
  const jwk = privateKey.export({ format: "jwk" });
  return { ...jwk, kid: jwkThumbprint(jwk), alg: "RS256", use: "sig" };
}

function writePrivate(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function outsideRepository(dir) {
  const target = resolve(dir);
  if (target === REPOSITORY || target.startsWith(`${REPOSITORY}/`)) {
    throw new Error("keep the keys outside the repository, so they can never be committed");
  }
  return target;
}

function keys(dir) {
  const out = outsideRepository(dir);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const issuerFile = `${out}/issuer-keys.json`;
  if (existsSync(issuerFile)) throw new Error(`${issuerFile} exists already; nothing was overwritten`);
  const key = generateIssuerKey();
  writePrivate(issuerFile, JSON.stringify({ signing: key.kid, keys: [key] }));
  console.log(`Made in ${out} (owner-only access); the private half is never printed.

The issuer's signing key (kid ${key.kid}). Store it as the Worker secret:
  npx wrangler secret put ISSUER_KEYS < ${issuerFile}

Keep ${out} somewhere safe and private: a later key rotation starts from issuer-keys.json.`);
}

function rotate(file, step) {
  const current = JSON.parse(readFileSync(file, "utf8"));
  const next = rotateIssuerKeys(current, step, step === "publish" ? generateIssuerKey() : undefined);
  writePrivate(file, JSON.stringify(next));
  const advice = {
    publish: "Both keys are now published, the old one still signing. Wait until every relying party has fetched the new key set (a day is ample), then run the sign step.",
    sign: "The new key now signs; both stay published. Wait until every token signed with the old key has expired (tokens live 5 minutes, credentials minted from them at most 1 hour; wait a day), then run the retire step.",
    retire: "Only the signing key is published now. The rotation is done.",
  }[step];
  console.log(`${step}: signing key ${next.signing}, published ${next.keys.map((k) => k.kid).join(", ")}.
Store it:
  npx wrangler secret put ISSUER_KEYS < ${resolve(file)}
${advice}`);
}

const USAGE = "usage: issuer-keys.mjs keys <dir> | rotate <issuer-keys.json> publish|sign|retire";
const [command, ...args] = process.argv.slice(2);
try {
  if (command === "keys" && args.length === 1) keys(args[0]);
  else if (command === "rotate" && args.length === 2) rotate(args[0], args[1]);
  else throw new Error(USAGE);
} catch (error) {
  console.error(`issuer-keys: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
