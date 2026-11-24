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
- `shell/`: the TypeScript Cloudflare Worker, with `GET /health`, the
  price table (see `shell/prices/README.md`), the model proxy with its
  usage ledger, per-provider budgets and per-user vault (see
  `shell/src/proxy/README.md`), and "Connect <Provider>" for Bedrock, Foundry
  and Vertex AI with the app's own OpenID Connect issuer (see
  `shell/src/providers/README.md`). D1 migrations are in `shell/migrations/`. Managed with
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

Until the site's own sign-in exists (T45, T47), the shell Worker sits behind
one Cloudflare Access application covering its whole address, with one rule
that allows only the owner's email (T15, design-v3 section 10.3). Two parts:

- **The check in the Worker** (`shell/src/access.ts`), run first on every
  request, HTTP and WebSocket upgrade alike. It reads the
  `Cf-Access-Jwt-Assertion` header only (a `CF_Authorization` cookie
  without the header is refused), verifies the RS256 signature against the team's keys at
  `<team domain>/cdn-cgi/access/certs` (cached; refetched on an unknown key
  id, at most every 30 seconds), and checks `iss`, `aud`, `exp` and `nbf`.
  Anything else, including a Worker without its configuration, gets a bare
  403. The one exception is the app's OpenID Connect issuer: `GET` on
  exactly `/oidc/.well-known/openid-configuration` and `/oidc/jwks.json` is
  served without a token, because AWS, Google and Microsoft fetch them
  (`shell/src/providers/README.md`). Configuration is two Worker variables set at deploy:
  `ACCESS_TEAM_DOMAIN` (`https://<team>.cloudflareaccess.com`) and
  `ACCESS_AUD` (the application's AUD tag).
- **The Access application itself**, created or updated by
  `node shell/scripts/sync-access-app.mjs` at deploy time. It reads
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ACCESS_APP_DOMAIN` (the
  app's host name only, no scheme or path) and `OWNER_EMAIL` from the environment, makes
  one reusable policy, `chief-of-staff: owner only`, that allows only
  `OWNER_EMAIL`, attaches it to the self-hosted application `chief-of-staff`
  covering `ACCESS_APP_DOMAIN`, and prints the application id and AUD tag.
  It also makes the application `chief-of-staff: issuer documents`, covering
  exactly the issuer's two paths, with a reusable Bypass policy (`everyone`),
  the more specific path taking precedence over the whole-address one. It
  is idempotent: a second run updates both in place. The owner's email is
  personal data: it lives only in the GitHub Actions secret `OWNER_EMAIL`,
  never in the repository, and the script never prints it. The shell's
  release workflow runs it before each deploy (below).

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
push to `main` that touches `shell/`, it:

1. runs `make check test` in `shell/`, which applies every migration, in
   order, to a fresh local D1 holding only the made-up persona
   (`scripts/check-migrations.mjs`, seeded from `test/persona-seed.sql`);
2. stops there with a plain message while `CLOUDFLARE_API_TOKEN` is not set
   (until T10), and refuses while `wrangler.jsonc` has the placeholder
   database id;
3. lists the pending migrations and, when any may change or remove data
   (anything but adding tables, indexes, views, columns or rows, and any
   upsert that updates existing rows; every `.sql` file wrangler would apply is
   checked, whatever its name; `src/release/migration-rules.ts`), records D1's restore bookmark with
   `wrangler d1 time-travel info chief-of-staff` (`scripts/release-migrations.mjs`);
4. runs `wrangler d1 migrations apply chief-of-staff --remote`; a failed file
   is rolled back by D1 and stops the release, so the Worker is not deployed;
5. runs the Access sync script (above) for the application's AUD tag;
6. deploys the Worker with `wrangler deploy --tag shell-v<version>-<run>`;
7. creates a GitHub release with that tag naming the migrations applied and
   the restore bookmark.

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
