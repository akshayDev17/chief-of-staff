# Connecting the providers (T16, design-v3 1.4 to 1.6, ADR-001)

Each provider is a "Connect <Provider>" button backed by one plug-in. No user
hands the app a key: each user grants the app's own identity a narrow
permission inside their own account, revocable there, and the app turns that
grant into a credential that lasts about an hour. A connection record holds
nothing secret.

| Provider | Plug-in | The user types | The record holds | The credential |
| --- | --- | --- | --- | --- |
| Amazon Bedrock | `bedrock.ts` | the 12-digit AWS account ID | the invoke-only role's ARN, the user's external ID | the issuer's token → `AssumeRoleWithWebIdentity` (the app's role) → `AssumeRole` (the user's role, with the external ID): 1 hour |
| Microsoft Foundry | `foundry.ts` | the Foundry resource address | the tenant ID (from Microsoft's admin consent), the endpoint | client credentials in the user's tenant, proven by the app's certificate (or, with `FOUNDRY_CREDENTIAL=federated`, the issuer's token): 60 to 90 minutes |
| Google Vertex AI | `vertex.ts` | the project ID | the project ID | the issuer's token → Google's STS (Workload Identity Federation) → the app's service account's token: 1 hour |

Each plug-in has three parts (`src/proxy/plugin.ts`): its **Connect method**
(`connect`: fields, setup link, test request, the plain reasons for the
vendor's errors, the guide with its "checked on" date and pages), its
**caller** (`mintCredential`, `call`: usage read from the reply, cache writes
split into 5-minute and 1-hour, long prompts marked) and its **price source**
(`priceSource`). `index.ts` registers the three; Models › Setup › Providers
shows a button for each registered plug-in, so adding a provider is one
plug-in. Each plug-in's file cites the vendor pages it follows, read
2026-11-25.

The callers speak each provider's own format: Converse on Bedrock (every
model family), Anthropic's Messages format for Claude on Foundry
(`/anthropic/v1/messages`) and on Vertex AI (`rawPredict`). Foundry's
OpenAI-family and Vertex AI's Gemini callers come with the ticket that adds
those models (T17).

## The issuer (`src/issuer.ts`)

The Worker is its own OpenID Connect issuer at `<APP_ORIGIN>/oidc`, with its
discovery document at `/oidc/.well-known/openid-configuration` and its key set
at `/oidc/jwks.json`. Those two paths are the only ones served without the
owner's sign-in: the Worker exempts exactly them from its Access check, and
`scripts/access-app.mjs` adds a second Access application on exactly those
two paths with a Bypass policy. Tokens are RS256 and live 5 minutes, with the
audience and subject each provider was told to trust:

| Provider | `aud` | `sub` |
| --- | --- | --- |
| AWS | `sts.amazonaws.com` | `chief-of-staff:bedrock` |
| Google | `https://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/chief-of-staff/providers/chief-of-staff-worker` | `chief-of-staff:vertex` |
| Microsoft (federated only) | `api://AzureADTokenExchange` | `chief-of-staff:foundry` |

### Rotating the issuer key

The key lives in one place, the Worker secret `ISSUER_KEYS`
(`{"signing": "<kid>", "keys": [<JWK>, ...]}`): every key in it is published,
and only `signing` signs. A rotation never breaks a connection, because old
and new public keys are published together until the old one can no longer
be in use. Run each step on the owner's machine, from the `issuer-keys.json`
that `provider-setup.mjs keys` made:

1. `node scripts/provider-setup.mjs rotate-issuer <dir>/issuer-keys.json publish`,
   then `npx wrangler secret put ISSUER_KEYS < <dir>/issuer-keys.json`. A new
   key is published beside the old one, which still signs.
2. A day later, when AWS and Google have fetched the new key set: the same
   with `sign`. The new key signs; both stay published.
3. A day later, when every token signed with the old key has expired (tokens
   live 5 minutes, credentials minted from them at most an hour): the same
   with `retire`. Only the new key is published.

The tests run a whole rotation and check that tokens signed with either key
verify against the published set until the old key is retired
(`test/issuer.test.ts`), and `make provider-setup-check` runs the script itself.

## Release units (design-v3 1.4, ADR-017)

- **The plug-ins** ship in the Worker and roll back with it; each has its
  own version label (`bedrock-1.0.0`, `foundry-1.0.0`, `vertex-1.0.0`) on
  every ledger row it writes, test calls included.
- **The Bedrock template** (`shell/bedrock-template/`) has its own version
  and publish workflow; users' stacks keep their version, so a new one stays
  compatible with them, and the check reads each stack's version
  (`provider_checks.template_version`). Rollback: `BEDROCK_TEMPLATE_URL`
  back to the previous version.
- **The Entra registration** changes on a planned schedule, since a change
  to it reaches every user's consent at once. To replace the certificate:
  run `provider-setup.mjs keys <new dir>` (its new issuer key is not
  needed and stays unused), upload the new public certificate
  beside the old one, store the new `ENTRA_CERT_KEY` and
  `ENTRA_CERT_THUMBPRINT`, and remove the old certificate from the
  registration only after every token minted with it has expired (90
  minutes at most; wait a day).
- **The Vertex AI assets** (the service account, the pool and provider, the
  custom role command) keep the role ID `chiefOfStaffModelCaller` and its
  one permission, so roles users already made keep working.
- **The issuer key** has its own rotation cycle (above).

## The Connect check (`check.ts`)

After "Connect", the test call runs by itself; there is no test-call button.

- While the provider-side grant is not there yet (the stack not created, the
  role not assigned), the check tries again every minute for an hour after
  Connect (the cron `* * * * *`), and the page refreshes itself.
- "Still switching this on" (Bedrock's Marketplace agreement) is tried again
  every 15 minutes; the item ticks when a call passes.
- A connection whose test call had passed and then loses its grant, found by
  the check or by a real call through the proxy, is recorded as `revoked`
  (`provider_checks.state`), for T49's urgent alert.
- A test call is a real call: it writes a ledger row (`task` `test_call`),
  costed at the list price. It needs that price, as every call does, and
  waits while a budget is set and spent.
- Each result is three lines, shown only to the user who made the call: the
  plain reason, the provider's own reply, the fix. "Ask Admin for help"
  (friends only) records the item's name and the plain reason in
  `help_requests`, never the reply, for T49 to deliver.

## Region

The app picks the test call's region from what the model supports: Global on
Bedrock (or the cross-Region profile of the app's geography); on Foundry the
deployment type is chosen when the user deploys the model; on Vertex AI a
specific location (`vertex-locations.ts`, from Google's model pages: the `us`
multi-region for Claude 4.7 and later and for Gemini, `us-east5` for older
Claude), then Global. The user can change it on the page; the test call
proves it.

## What the owner sets up (T10)

`node scripts/provider-setup.mjs keys <dir>` makes the issuer key and the
Entra certificate outside the repository and prints only what to upload and
the Wrangler commands for the private halves. `node scripts/provider-setup.mjs
values` (with `APP_ORIGIN`, `AWS_ACCOUNT_ID`, `GOOGLE_PROJECT_ID`,
`GOOGLE_PROJECT_NUMBER`, `GITHUB_REPOSITORY` and `BEDROCK_TEMPLATE_BUCKET` in
the environment) prints every other value: the AWS identity provider and the
app role's trust and permission policies, the Google pool, provider, service
account and binding, and the Entra registration. Nothing is guessed during T10.

The Worker reads:

| Name | Kind | What |
| --- | --- | --- |
| `APP_ORIGIN` | variable | `https://<host>`, the issuer's and the consent return's address |
| `ISSUER_KEYS` | secret | the issuer's keys (above) |
| `AWS_APP_ROLE_ARN` | variable | the app's own role in the owner's AWS account |
| `AWS_REGION` | variable | where STS and Bedrock are called and the stack is made; default `us-east-1` |
| `BEDROCK_TEMPLATE_URL` | variable | the published template version the link opens (`bedrock-template/README.md`) |
| `ENTRA_CLIENT_ID` | variable | the multi-tenant Entra app's client ID |
| `ENTRA_CERT_KEY` | secret | its certificate's private key, PKCS #8 PEM |
| `ENTRA_CERT_THUMBPRINT` | variable | the certificate's `x5t#S256` |
| `FOUNDRY_CREDENTIAL` | variable | `certificate` (default) or `federated` |
| `GOOGLE_WIF_PROVIDER` | variable | the workload identity pool provider's full name |
| `GOOGLE_SERVICE_ACCOUNT` | variable | the app's service account's email |

Until they are set, every page still renders, and a test call says plainly
which of the app's own values is missing.

## Waiting on T10 (checked live in M2)

Nothing here has run against a cloud account. M2 steps 1, 2, 10 and the
Connect checks of step 11 (federated credentials across Entra tenants, admin
consent from a personal Microsoft account, a Foundry role without `listkeys`,
a console-enabled Bedrock model through the invoke-only role, Vertex AI
billing to the user's project, the time from revoking a grant to refusal),
the template version read from a live stack, a live issuer-key rotation, and
Foundry's key question (T13) all wait on the owner's accounts. Google's exact
error strings are recorded from live failures then; real vendor error bodies
saved for tests go only into the private test-examples store.
