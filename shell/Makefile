# shell/: the TypeScript Worker release unit. Every install comes from
# package-lock.json; `npm ci` fails when it disagrees with package.json.
# npm is pinned to the packageManager version in package.json (npm 10 cannot
# resolve this dependency tree).

NPM := npx --yes npm@11.21.3
INSTALLED := node_modules/.package-lock.json

.PHONY: test check migrations rollback-check roll-back-prices provider-setup-check

$(INSTALLED): package.json package-lock.json
	$(NPM) ci
	touch $@

check: $(INSTALLED)
	$(NPM) run typecheck

test: $(INSTALLED) migrations rollback-check provider-setup-check
	$(NPM) test

# Apply every migration, in order, to a fresh local D1 database holding only
# the made-up persona, with Cloudflare's own tool (design-v3 8.4); a failing
# file fails the build (scripts/check-migrations.mjs).
MIGRATIONS_CHECK_DB := .wrangler/migrations-check
migrations: $(INSTALLED)
	rm -rf $(MIGRATIONS_CHECK_DB)
	node scripts/check-migrations.mjs $(MIGRATIONS_CHECK_DB)

# Run the price-table rollback script against a fresh local D1 and check
# what it changed (scripts/check-price-rollback.mjs).
ROLLBACK_CHECK_DB := .wrangler/rollback-check
rollback-check: $(INSTALLED)
	rm -rf $(ROLLBACK_CHECK_DB)
	CI=1 npx wrangler d1 migrations apply chief-of-staff --local --persist-to $(ROLLBACK_CHECK_DB) < /dev/null
	node scripts/check-price-rollback.mjs $(ROLLBACK_CHECK_DB)

# Run the owner's provider setup script for real in a temporary directory
# and check its keys, certificate, printout and issuer-key rotation
# (scripts/check-provider-setup.mjs). Touches no account.
provider-setup-check:
	node scripts/check-provider-setup.mjs

# A maintainer's rollback of the deployed price table to the snapshot before
# the newest one (prices/README.md). Needs CLOUDFLARE_API_TOKEN (T10).
roll-back-prices: $(INSTALLED)
	node scripts/roll-back-prices.mjs --remote
