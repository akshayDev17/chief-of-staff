#!/usr/bin/env node
// The owner's one-time provider setup (T16, run by the owner under T10, never
// by CI). It touches no account: it makes keys locally and prints what the
// owner uploads or sets, never a private half.
//
//   node scripts/provider-setup.mjs keys <dir>
//     Makes the issuer's signing key and the Entra certificate in <dir> (a
//     directory outside the repository, created with owner-only access), and
//     prints the public certificate's path to upload, its thumbprint, and the
//     Wrangler command that stores each private half as a Worker secret.
//
//   node scripts/provider-setup.mjs rotate-issuer <issuer-keys.json> publish|sign|retire
//     One step of rotating the issuer key (README "Rotating the issuer key"),
//     rewriting the file and printing the Wrangler command to store it.
//
//   node scripts/provider-setup.mjs values
//     Prints every value the T10 checklist needs, from APP_ORIGIN,
//     AWS_ACCOUNT_ID, GOOGLE_PROJECT_ID, GOOGLE_PROJECT_NUMBER,
//     GITHUB_REPOSITORY and BEDROCK_TEMPLATE_BUCKET in the environment.

import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readValueInputs, renderChecklist, rotateIssuerKeys, setupValues } from "./provider-setup-lib.mjs";

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
  const certKey = `${out}/entra-key.pem`;
  const cert = `${out}/entra-cert.pem`;
  for (const f of [issuerFile, certKey, cert]) if (existsSync(f)) throw new Error(`${f} exists already; nothing was overwritten`);

  const key = generateIssuerKey();
  writePrivate(issuerFile, JSON.stringify({ signing: key.kid, keys: [key] }));

  // A self-signed certificate is what Entra takes for an app credential.
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "730",
    "-subj", "/CN=chief-of-staff", "-keyout", certKey, "-out", cert,
  ], { stdio: "pipe" });
  chmodSync(certKey, 0o600);
  const x509 = new X509Certificate(readFileSync(cert));
  const thumbprint = base64url(createHash("sha256").update(x509.raw).digest());

  console.log(`Made in ${out} (owner-only access); the private halves are never printed.

The issuer's signing key (kid ${key.kid}). Store it as the Worker secret:
  npx wrangler secret put ISSUER_KEYS < ${issuerFile}

The Entra certificate, valid until ${x509.validTo}.
  Upload the public certificate in Entra: App registrations → Chief of staff →
  Certificates & secrets → Certificates → Upload certificate:
    ${cert}
  Store its private key as the Worker secret:
    npx wrangler secret put ENTRA_CERT_KEY < ${certKey}
  And set the Worker variable (not secret):
    ENTRA_CERT_THUMBPRINT=${thumbprint}

Keep ${out} somewhere safe and private: a later key rotation starts from issuer-keys.json.`);
}

function rotate(file, step) {
  const current = JSON.parse(readFileSync(file, "utf8"));
  const next = rotateIssuerKeys(current, step, step === "publish" ? generateIssuerKey() : undefined);
  writePrivate(file, JSON.stringify(next));
  const advice = {
    publish: "Both keys are now published, the old one still signing. Wait until AWS and Google have fetched the new key set (a day is ample), then run the sign step.",
    sign: "The new key now signs; both stay published. Wait until every token signed with the old key has expired (tokens live 5 minutes, credentials minted from them at most 1 hour; wait a day), then run the retire step.",
    retire: "Only the signing key is published now. The rotation is done.",
  }[step];
  console.log(`${step}: signing key ${next.signing}, published ${next.keys.map((k) => k.kid).join(", ")}.
Store it:
  npx wrangler secret put ISSUER_KEYS < ${resolve(file)}
${advice}`);
}

const USAGE = "usage: provider-setup.mjs keys <dir> | rotate-issuer <issuer-keys.json> publish|sign|retire | values";
const [command, ...args] = process.argv.slice(2);
try {
  if (command === "keys" && args.length === 1) keys(args[0]);
  else if (command === "rotate-issuer" && args.length === 2) rotate(args[0], args[1]);
  else if (command === "values" && args.length === 0) console.log(renderChecklist(setupValues(readValueInputs(process.env))));
  else throw new Error(USAGE);
} catch (error) {
  console.error(`provider-setup: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
