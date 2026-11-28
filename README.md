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
  usage ledger, the monthly budget and the per-user vault (see
  `shell/src/proxy/README.md`), and "Connect OpenRouter", the one provider:
  OpenRouter's own OAuth PKCE consent page issues the app a key tied to the
  user's own OpenRouter account, which goes straight into that user's vault
  (see `shell/src/providers/README.md`), with OpenRouter's model list on its
  Connect screen, the model for each task, and Models › Usage, the month's
  spend per model and per task (see `shell/src/models/README.md`).
  D1 migrations are in `shell/migrations/`. Managed with
  npm 11 (pinned in `packageManager`); `package-lock.json` pins every
  dependency with integrity hashes. Version in `shell/package.json`.
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

The app lives at `https://akshayprabhakant.com/chief-of-staff`: every page and
API path is under that one path (`shell/src/paths.ts`,
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
  `akshayprabhakant.com/chief-of-staff/*`. The second application the plan
  had, a Bypass policy on the app's former OpenID Connect issuer documents
  (`/chief-of-staff/oidc/...`), is no longer needed: the issuer was removed
  on 2026-11-27, and the owner may take it out of the tool's plan. The tool
  also puts the deploy secrets in the repository's GitHub environment
  `production` (below). So the
  deploy token needs no Access permission, and no address of the owner's is
  in this repository or its secrets.
- **The check in the Worker** (`shell/src/access.ts`), run first on every
  request under the prefix, HTTP and WebSocket upgrade alike. It reads the
  `Cf-Access-Jwt-Assertion` header only (a `CF_Authorization` cookie
  without the header is refused), verifies the RS256 signature against the team's keys at
  `<team domain>/cdn-cgi/access/certs` (cached; refetched on an unknown key
  id, at most every 30 seconds), and checks `iss`, `aud`, `exp` and `nbf`.
  Anything else, including a Worker without its configuration, gets a bare
  403. No path under the prefix is served without the owner's sign-in. The
  app's own OpenID Connect issuer, whose two documents were once served
  without a token for Bedrock, Vertex AI and Foundry, was removed with them
  on 2026-11-27: it was kept that day for a planned Connect Anthropic, then
  removed when the owner parked it ("ok, so lets not do the anthropic one
  just yet, lets get the openrouter one working at least").
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
`ACCESS_TEAM_DOMAIN`, and:

1. runs `make check test` in `shell/`, which applies every migration, in
   order, to a fresh local D1 holding only the made-up persona
   (`scripts/check-migrations.mjs`, seeded from `test/persona-seed.sql`);
2. stops there with a plain message naming the missing one while
   `CLOUDFLARE_API_TOKEN`, `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` is not set in
   that environment, and
   refuses while `wrangler.jsonc` has the placeholder database id;
3. lists the pending migrations and those among them that may change or
   remove data (anything but adding tables, indexes, views, columns or rows,
   and any upsert that updates existing rows; every `.sql` file wrangler would
   apply is checked, whatever its name; `src/release/migration-rules.ts`) and,
   when any is pending, records D1's restore bookmark with
   `wrangler d1 time-travel info chief-of-staff` in the run's summary
   (`scripts/release-migrations.mjs`); with no bookmark it stops;
4. runs `wrangler d1 migrations apply chief-of-staff --remote`; a failed file
   is rolled back by D1 and stops the release, so the Worker is not deployed;
5. deploys the Worker, with its route, as
   `wrangler deploy --tag shell-v<version>-<run>` (`shell/scripts/release-deploy.sh`),
   passing `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` as variables alongside the
   `APP_ORIGIN` in `shell/wrangler.jsonc`. A deploy keeps the Worker's secrets but replaces
   its variables, so a variable set only in the Cloudflare dashboard is gone
   after the next release: set them in the `production` environment;
6. creates a GitHub release with that tag naming the migrations applied and
   the restore bookmark.

**No provider variables.** OpenRouter needs no GitHub variable or secret:
PKCE needs no client secret, the callback is built from `APP_ORIGIN`, and the
app's name is fixed in code. The seven variables the removed Bedrock, Foundry
and Vertex AI plug-ins read are no longer read.

**The Worker's one secret** is stored with `npx wrangler secret put` in
`shell/`, never in the repository or the `production` environment, and a
release keeps it:

- `VAULT_KEY`, the vault key (32 random bytes, base64), which wraps every
  user's own vault key. Set it once, before anyone uses Connect OpenRouter:

  ```sh
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" | npx wrangler secret put VAULT_KEY
  ```

  Without it, Connect OpenRouter says the app's own side is not set up
  (missing VAULT_KEY). Never rotate it casually: it unwraps every user's
  vault key.

`ISSUER_KEYS` (the removed issuer's key) and `ENTRA_CERT_KEY` are no longer
read; the owner may delete them with `npx wrangler secret delete`.

After the release deploys, Admin · Price table fills at the next 06:00 UTC
refresh, or at once with Refresh model list on the Connect OpenRouter screen.

**D1 migrations** are numbered `.sql` files in `shell/migrations/`, forward
only, applied by that pipeline and never by hand. **Every schema change takes
two releases.** *Expand*: add the new table or column and switch the code
over, leaving the old in place. *Contract*: remove the old in a later release,
once no Worker version that may still run reads it. So the previous Worker
always works with the current schema, and a Worker rollback never needs a
schema rollback. The pipeline records the bookmark before every migration,
an expand one included.

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
