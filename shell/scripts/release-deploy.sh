#!/usr/bin/env bash
# The release pipeline's deploy of the Worker as a tagged version
# (.github/workflows/release-shell.yml, README "Releasing the shell").
#
#   TAG=... GITHUB_SHA=... ACCESS_TEAM_DOMAIN=... ACCESS_AUD=... scripts/release-deploy.sh
#
# A deploy replaces every Worker variable with the ones it is given, so each
# value the Worker reads comes from the GitHub environment `production`:
# ACCESS_TEAM_DOMAIN and ACCESS_AUD (the release stops earlier without them).
# Nothing is defaulted here. APP_ORIGIN ships in wrangler.jsonc "vars"; the
# secret (VAULT_KEY) stays. The variables the removed Bedrock,
# Foundry and Vertex AI plug-ins read are no longer passed, so a release
# clears them from the Worker. `make release-deploy-check` runs this with a
# stand-in for npx.
set -euo pipefail

exec npx wrangler deploy --tag "$TAG" --message "$TAG from ${GITHUB_SHA}" \
  --var "ACCESS_TEAM_DOMAIN:${ACCESS_TEAM_DOMAIN}" --var "ACCESS_AUD:${ACCESS_AUD}"
