#!/usr/bin/env node
// `make release-deploy-check` (part of `make test`): runs the release's
// deploy step, scripts/release-deploy.sh, for real with a stand-in `npx` that
// records its arguments, and checks that every provider variable set in the
// environment reaches `wrangler deploy` as a --var and every unset or empty
// one is left out. No account is touched.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const script = join(dirname(fileURLToPath(import.meta.url)), "release-deploy.sh");
const fail = (message) => {
  console.error(`check-release-deploy: ${message}`);
  process.exit(1);
};

const BASE = { TAG: "shell-v0.1.0-7", GITHUB_SHA: "abc123", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud-tag" };
const ALL = {
  AWS_APP_ROLE_ARN: "arn:aws:iam::111122223333:role/chief-of-staff-app",
  AWS_REGION: "us-east-1",
  BEDROCK_TEMPLATE_URL: "https://bucket.s3.amazonaws.com/v1.0.0.json",
  ENTRA_CLIENT_ID: "00000000-1111-2222-3333-444444444444",
  ENTRA_CERT_THUMBPRINT: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
  FOUNDRY_CREDENTIAL: "certificate",
  GOOGLE_WIF_PROVIDER: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/w",
};
const deployArgs = (vars) => [
  "wrangler", "deploy", "--tag", BASE.TAG, "--message", `${BASE.TAG} from ${BASE.GITHUB_SHA}`,
  "--var", `ACCESS_TEAM_DOMAIN:${BASE.ACCESS_TEAM_DOMAIN}`, "--var", `ACCESS_AUD:${BASE.ACCESS_AUD}`,
  ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`]),
];

const dir = mkdtempSync(join(tmpdir(), "cos-release-deploy-"));
try {
  const record = join(dir, "npx-args");
  writeFileSync(join(dir, "npx"), `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "${record}"\n`);
  chmodSync(join(dir, "npx"), 0o755);
  const deploy = (env) => {
    rmSync(record, { force: true });
    const run = spawnSync("bash", [script], { encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}`, ...BASE, ...env } });
    if (run.status !== 0) fail(`the deploy step failed: ${run.stderr}`);
    if (run.stderr) fail(`the deploy step printed an error: ${run.stderr}`);
    return readFileSync(record, "utf8").split("\0").slice(0, -1);
  };

  const cases = [
    ["every provider variable set", ALL, ALL],
    ["none set", {}, {}],
    ["as GitHub passes unset variables, empty", Object.fromEntries(Object.keys(ALL).map((k) => [k, ""])), {}],
    [
      "some set, some empty",
      { ...ALL, BEDROCK_TEMPLATE_URL: "", ENTRA_CERT_THUMBPRINT: "", GOOGLE_WIF_PROVIDER: "" },
      { AWS_APP_ROLE_ARN: ALL.AWS_APP_ROLE_ARN, AWS_REGION: ALL.AWS_REGION, ENTRA_CLIENT_ID: ALL.ENTRA_CLIENT_ID, FOUNDRY_CREDENTIAL: ALL.FOUNDRY_CREDENTIAL },
    ],
  ];
  for (const [name, env, passed] of cases) {
    const got = deploy(env);
    if (!isDeepStrictEqual(got, deployArgs(passed))) fail(`${name}: wrangler got ${JSON.stringify(got)}`);
  }
  console.log(`check-release-deploy: ${cases.length} cases passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
