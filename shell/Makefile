# shell/: the TypeScript Worker release unit. Every install comes from
# package-lock.json; `npm ci` fails when it disagrees with package.json.
# npm is pinned to the packageManager version in package.json (npm 10 cannot
# resolve this dependency tree).

NPM := npx --yes npm@11.21.3

.PHONY: test check install

install:
	$(NPM) ci

check: install
	$(NPM) run typecheck

test: install
	$(NPM) test
