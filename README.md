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

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`.
A component's job runs only when that component's files change (`agent/**`,
`shell/**`); each component's build ticket adds its own filter and job. The
`ci` job runs `make check` and `make test` on every change and is the one
check to require. Third-party actions are pinned to full commit SHAs.

### Secret scan

[gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1 scans the full history
and the tree in CI (`make secret-scan`) and fails the build on a match. The same
scanner runs as a pre-commit hook on staged changes. To set it up once per clone:

```sh
brew install gitleaks   # or a release binary from GitHub
make hooks              # sets core.hooksPath to .githooks
```
