# chief-of-staff

An AI agent that runs a job search end to end: finds roles, fills applications and follows up.

## Layout

One directory per release unit (design-v3 ADR-017), each with its own lock
file and version, so a component's CI job sees only its own changes:

- `agent/`: the Python 3.13 agent, built on Google ADK. Managed with
  [uv](https://docs.astral.sh/uv/) (version pinned by `required-version`);
  `uv.lock` pins every dependency to an exact version with hashes. Version in
  `agent/pyproject.toml`.
- `shell/`: the TypeScript Cloudflare Worker, with `GET /health`. Managed with
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

### Continuous integration

`.github/workflows/ci.yml` runs on every pull request. A component's check and
tests run only in that component's job, and only when that component's files
change (`agent/**`, `shell/**`) or the shared `Makefile` or `ci.yml` change;
each component's build ticket adds its own filter and job. The `ci` job runs
no commands of its own: it fails when a component job failed and passes when
a component job was skipped. Require the `ci` and `secret-scan` checks.
Third-party actions are pinned to full commit SHAs.

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
