# shell/: the TypeScript Worker release unit. Every install comes from
# package-lock.json; `npm ci` fails when it disagrees with package.json.
# npm is pinned to the packageManager version in package.json (npm 10 cannot
# resolve this dependency tree).

NPM := npx --yes npm@11.21.3
INSTALLED := node_modules/.package-lock.json

.PHONY: test check migrations

$(INSTALLED): package.json package-lock.json
	$(NPM) ci
	touch $@

check: $(INSTALLED)
	$(NPM) run typecheck

test: $(INSTALLED) migrations
	$(NPM) test

# Apply every migration, in order, to a fresh local D1 database with
# Cloudflare's own tool (design-v3 8.4); a failing file fails the build.
MIGRATIONS_CHECK_DB := .wrangler/migrations-check
migrations: $(INSTALLED)
	rm -rf $(MIGRATIONS_CHECK_DB)
	CI=1 npx wrangler d1 migrations apply chief-of-staff --local --persist-to $(MIGRATIONS_CHECK_DB) < /dev/null
