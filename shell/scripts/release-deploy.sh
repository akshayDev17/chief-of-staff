#!/usr/bin/env bash
# The release pipeline's deploy of the Worker as a tagged version
# (.github/workflows/release-shell.yml, README "Releasing the shell").
#
#   TAG=... GITHUB_SHA=... ACCESS_TEAM_DOMAIN=... ACCESS_AUD=... \
#     [AWS_APP_ROLE_ARN=... ...] scripts/release-deploy.sh
#
# A deploy replaces every Worker variable with the ones it is given, so each
# value the Worker reads comes from the GitHub environment `production`:
# ACCESS_TEAM_DOMAIN and ACCESS_AUD always (the release stops earlier without
# them), and each provider plug-in variable (src/providers/README.md, "What
# the owner sets up") only when it is set there. An unset one is left out, so
# the Worker reports it as missing on its Connect page; nothing is defaulted
# here. APP_ORIGIN ships in wrangler.jsonc "vars"; the secrets stay.
# `make release-deploy-check` runs this with a stand-in for npx.
set -euo pipefail

PROVIDER_VARIABLES=(AWS_APP_ROLE_ARN AWS_REGION BEDROCK_TEMPLATE_URL ENTRA_CLIENT_ID ENTRA_CERT_THUMBPRINT FOUNDRY_CREDENTIAL GOOGLE_WIF_PROVIDER)

vars=(--var "ACCESS_TEAM_DOMAIN:${ACCESS_TEAM_DOMAIN}" --var "ACCESS_AUD:${ACCESS_AUD}")
for name in "${PROVIDER_VARIABLES[@]}"; do
  if [ -n "${!name:-}" ]; then vars+=(--var "${name}:${!name}"); fi
done

exec npx wrangler deploy --tag "$TAG" --message "$TAG from ${GITHUB_SHA}" "${vars[@]}"
