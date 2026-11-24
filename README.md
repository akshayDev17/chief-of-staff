# chief-of-staff

An AI agent that runs a job search end to end: finds roles, fills applications and follows up.

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
`make test COMPONENTS=agent` runs one component.

### Continuous integration

`.github/workflows/ci.yml` runs on every pull request. A component's check and
tests run only in that component's job, and only when that component's files
change (`agent/**`, `shell/**`) or the shared `Makefile` or `ci.yml` change;
each component's build ticket adds its own filter and job. The `ci` job runs
no commands of its own: it fails when a component job failed and passes when
a component job was skipped. Require the `ci` and `secret-scan` checks.
Third-party actions are pinned to full commit SHAs.

### Secret scan

[gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1 scans the full history
and the tree (`make secret-scan`) and fails the build on a match. Its workflow,
`.github/workflows/secret-scan.yml`, runs on every pull request and on a push
to any branch. The same scanner runs as a pre-commit hook on staged changes.
To set it up once per clone:

```sh
brew install gitleaks   # or a release binary from GitHub
make hooks              # sets core.hooksPath to .githooks
```
