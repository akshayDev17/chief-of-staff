# chief-of-staff

An AI agent that runs a job search end to end: finds roles, fills applications and follows up.

The design is [docs/design-v3.md](docs/design-v3.md) and its decision records are in [docs/adr/](docs/adr/). Licensed under the [MIT licence](LICENSE).

## Layout

One directory per release unit (design-v3 ADR-017), each with its own lock
file and version, so a component's CI job sees only its own changes:

- `agent/`: the Python 3.13 agent, built on Google ADK. Managed with
  [uv](https://docs.astral.sh/uv/) (version pinned by `required-version`);
  `uv.lock` pins every dependency to an exact version with hashes. Version in
  `agent/pyproject.toml`.
- `shell/`: the TypeScript Cloudflare Worker at `/chief-of-staff` (see
  "Cloudflare Access" below), with `GET /chief-of-staff/health`, the
  price table (see `shell/prices/README.md`), the model proxy with its
  usage ledger, per-provider budgets and per-user vault (see
  `shell/src/proxy/README.md`), and "Connect <Provider>" for Bedrock, Foundry
  and Vertex AI with the app's own OpenID Connect issuer (see
  `shell/src/providers/README.md`), and Add a model and the model for each
  task (see `shell/src/models/README.md`). D1 migrations are in `shell/migrations/`. Managed with
  npm 11 (pinned in `packageManager`); `package-lock.json` pins every
  dependency with integrity hashes. Version in `shell/package.json`.
- `shell/bedrock-template/`: the CloudFormation template a user's "Connect
  Amazon Bedrock" link opens, its own release unit with its own version and
  publish workflow (see `shell/bedrock-template/README.md`).
- `testdata/persona/`: Morgan Sample, a made-up test persona with invented
  facts and a fake resume. The repository holds nothing about any real user.

Later release units get their own directory when their ticket builds them.

Every install comes from a lock file: `make check` fails when `uv.lock` or
`package-lock.json` is out of date with its manifest (`uv lock --check`,
`uv sync --locked`, `npm ci`). After changing a dependency, run `uv lock` in
`agent/` or `npx npm@<packageManager version> install` in `shell/` and commit
the lock file.

## Development

The repository root has one test command and one check command for every
language in it:

```sh
make test    # runs each component's tests
make check   # runs each component's linters and type checks
```

Each component directory (`agent/` for Python, `shell/` for TypeScript) has its
own `Makefile` with `test` and `check` targets; the root targets run them for
every component directory that exists and skip one that does not yet exist.
`make test COMPONENTS=agent` runs one component; a named component without a
`Makefile` is skipped.

### Cloudflare Access

The app lives at `https://akshayprabhakant.com/chief-of-staff`: every page,
API path and issuer document is under that one path (`shell/src/paths.ts`,
`BASE_PATH`), and `/chief-of-staff` itself is the app's home. The Worker's
one route is `akshayprabhakant.com/chief-of-staff*` (`shell/wrangler.jsonc`),
the only pattern that also matches `/chief-of-staff?<query>`. It matches
sibling paths too, such as `/chief-of-staff.html` or `/chief-of-staffx`: the
Worker passes each of those, and any other path that is neither
`/chief-of-staff` nor under `/chief-of-staff/`, to the origin untouched.

Until the site's own sign-in exists (T45, T47), the app sits behind
Cloudflare Access with one rule that allows only the owner's address (T15,
design-v3 section 10.3). Two parts:

- **The Access applications** are the owner's `portfolio-app` setup tool's
  (my-skills-package), the same tool that sets up every app on
  akshayprabhakant.com; this repository makes none. Its plan for this app:
  one application with the shared one-address sign-in policy on
  `akshayprabhakant.com/chief-of-staff` and
  `akshayprabhakant.com/chief-of-staff/*`, and a second one with a Bypass
  policy on exactly the issuer's two documents,
  `/chief-of-staff/oidc/.well-known/openid-configuration` and
  `/chief-of-staff/oidc/jwks.json`. The tool also puts the deploy secrets
  in the repository's GitHub environment `production` (below). So the
  deploy token needs no Access permission, and no address of the owner's is
  in this repository or its secrets.
- **The check in the Worker** (`shell/src/access.ts`), run first on every
  request under the prefix, HTTP and WebSocket upgrade alike. It reads the
  `Cf-Access-Jwt-Assertion` header only (a `CF_Authorization` cookie
  without the header is refused), verifies the RS256 signature against the team's keys at
  `<team domain>/cdn-cgi/access/certs` (cached; refetched on an unknown key
  id, at most every 30 seconds), and checks `iss`, `aud`, `exp` and `nbf`.
  Anything else, including a Worker without its configuration, gets a bare
  403. The one exception is the app's OpenID Connect issuer: `GET` on
  exactly `/chief-of-staff/oidc/.well-known/openid-configuration` and
  `/chief-of-staff/oidc/jwks.json` is served without a token, because AWS,
  Google and Microsoft fetch them (`shell/src/providers/README.md`).
  Configuration is two Worker variables set at deploy from the `production`
  environment: `ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`, the bare host the
  tool writes, or the same with `https://`)
  and `ACCESS_AUD` (the AUD tag of the tool's sign-in application, not
  secret). The tool writes both there.

### Continuous integration

`.github/workflows/ci.yml` runs on every pull request. A component's check and
tests run only in that component's job, and only when that component's files
change (`agent/**`, `shell/**`) or the shared `Makefile` or `ci.yml` change;
each component's build ticket adds its own filter and job. The `ci` job runs
no commands of its own: it fails when a component job failed and passes when
a component job was skipped. Require the `ci` and `secret-scan` checks.
Third-party actions are pinned to full commit SHAs.

### Releasing the shell

The shell Worker is its own release unit with its own pipeline,
`.github/workflows/release-shell.yml` (design-v3 2.4, 8.4, ADR-017). On a
push to `main` that touches `shell/`, it runs in the GitHub environment
`production`, where the `portfolio-app` tool (above) puts the secrets
`CLOUDFLARE_API_TOKEN` (the narrow deploy token, no Access permission) and
`CLOUDFLARE_ACCOUNT_ID` and the variables `ACCESS_AUD` and
`ACCESS_TEAM_DOMAIN`, and where the owner adds the provider plug-ins'
variables `AWS_APP_ROLE_ARN`, `AWS_REGION`, `BEDROCK_TEMPLATE_URL`,
`ENTRA_CLIENT_ID`, `ENTRA_CERT_THUMBPRINT`, `FOUNDRY_CREDENTIAL` and
`GOOGLE_WIF_PROVIDER` as environment variables (`shell/src/providers/README.md`,
"What the owner sets up"), and:

1. runs `make check test` in `shell/`, which applies every migration, in
   order, to a fresh local D1 holding only the made-up persona
   (`scripts/check-migrations.mjs`, seeded from `test/persona-seed.sql`);
2. stops there with a plain message naming the missing one while
   `CLOUDFLARE_API_TOKEN`, `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` is not set in
   that environment, and
   refuses while `wrangler.jsonc` has the placeholder database id;
3. lists the pending migrations and, when any may change or remove data
   (anything but adding tables, indexes, views, columns or rows, and any
   upsert that updates existing rows; every `.sql` file wrangler would apply is
   checked, whatever its name; `src/release/migration-rules.ts`), records D1's restore bookmark with
   `wrangler d1 time-travel info chief-of-staff` (`scripts/release-migrations.mjs`);
4. runs `wrangler d1 migrations apply chief-of-staff --remote`; a failed file
   is rolled back by D1 and stops the release, so the Worker is not deployed;
5. deploys the Worker, with its route, as
   `wrangler deploy --tag shell-v<version>-<run>` (`shell/scripts/release-deploy.sh`),
   passing `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN` and each provider variable set
   in that environment as variables alongside the `APP_ORIGIN` in
   `shell/wrangler.jsonc`; a provider variable not set there is left out and
   never stops the release. A deploy keeps the Worker's secrets but replaces
   its variables, so a variable set only in the Cloudflare dashboard is gone
   after the next release: set them in the `production` environment;
6. creates a GitHub release with that tag naming the migrations applied and
   the restore bookmark.

**Setting the provider variables.** The seven values the provider plug-ins
read are not entered anywhere in the app: no setup page has an input for
them. Each goes in the same place as `ACCESS_AUD`, and the release carries it
to the Worker:

1. On GitHub, open the repository's **Settings → Environments → production**.
2. Under **Environment variables**, choose **Add environment variable** (not
   a secret: none of these is secret).
3. Enter the name exactly as below and the value the named step printed, and
   save. Repeat for each value you have; leave out the ones you do not.
4. Push or merge a change under `shell/` to `main`: the next release deploys
   every variable set there. One set only in the Cloudflare dashboard is
   wiped by that release.

| Name | Where its value comes from (`shell/src/providers/README.md`, "What the owner sets up") | Needed |
| --- | --- | --- |
| `AWS_APP_ROLE_ARN` | `node scripts/provider-setup.mjs values`, step 2 (the app role you create) | required for Bedrock |
| `AWS_REGION` | the same step 2 (`us-east-1`) | optional; the Worker uses `us-east-1` without it |
| `BEDROCK_TEMPLATE_URL` | the run summary of the template's first publish (`.github/workflows/release-bedrock-template.yml`) | required for Bedrock: no Connect link without it |
| `GOOGLE_WIF_PROVIDER` | `node scripts/provider-setup.mjs values`, step 3 (the pool provider's full name) | required for Vertex AI |
| `ENTRA_CLIENT_ID` | the Entra registration of step 4: its Application (client) ID | required for Foundry |
| `ENTRA_CERT_THUMBPRINT` | `node scripts/provider-setup.mjs keys <dir>` | required for Foundry with `certificate`; not read with `federated` |
| `FOUNDRY_CREDENTIAL` | step 4: `certificate`, or `federated` only once M2 step 11.1 passes | optional; `certificate` without it |

The secrets `ISSUER_KEYS` and `ENTRA_CERT_KEY` are stored with
`npx wrangler secret put` instead (the same section), which a release keeps.

**D1 migrations** are numbered `.sql` files in `shell/migrations/`, forward
only, applied by that pipeline and never by hand. **Every schema change takes
two releases.** *Expand*: add the new table or column and switch the code
over, leaving the old in place. *Contract*: remove the old in a later release,
once no Worker version that may still run reads it. So the previous Worker
always works with the current schema, and a Worker rollback never needs a
schema rollback. A contract migration changes data, so the pipeline records
the bookmark before it.

**Data migrations** (backfills, reshaping rows, re-encrypting a vault) are
jobs in the shell Worker, not SQL files: `runDataMigration`
(`shell/src/data-migrations.ts`) runs a job user by user, commits each step's
writes and its `data_migration_steps` log row in one transaction, and skips a
step already logged, so a job is safe to run twice and an interrupted one
resumes where it stopped. A job starts after the Worker that carries it is
live; none exists yet, and the first one adds its start to the pipeline.

**Rolling the Worker back.** Each deploy is a Cloudflare Worker version.
List them with `npx wrangler versions list` (in `shell/`, with
`CLOUDFLARE_API_TOKEN` set) and go back to the previous one with
`npx wrangler rollback --message "<why>"`, or to a named one with
`npx wrangler rollback <version-id> --message "<why>"`. Migrations stay
applied: the rule above keeps the previous Worker working on the newer schema.

**Restoring the database** is a deliberate, owner-approved act, never
automatic. D1's Time Travel restores to any minute in the last 30 days and
overwrites the database in place. Take the bookmark named in the release (or
`npx wrangler d1 time-travel info chief-of-staff --timestamp <time>`), then run
`npx wrangler d1 time-travel restore chief-of-staff --bookmark=<bookmark>`; it
prints the bookmark to undo the restore. Then roll the Worker back to the
version that ran on that schema.

### Secret scan

[gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1 scans the history
reachable from `HEAD` and the working tree (`make secret-scan`) and fails the
build on a match. Its workflow, `.github/workflows/secret-scan.yml`, runs on
every pull request and on a push to any branch. The same scanner runs as a pre-commit hook on staged changes.
To set it up once per clone:

```sh
brew install gitleaks   # or a release binary from GitHub
make hooks              # sets core.hooksPath to .githooks
```
