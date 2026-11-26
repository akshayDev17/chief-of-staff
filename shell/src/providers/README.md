# Connecting the providers (T16, design-v3 1.4 to 1.6, ADR-001)

Each provider is a "Connect <Provider>" button backed by one plug-in. No user
hands the app a key: each user grants the app's own identity a narrow
permission inside their own account, revocable there, and the app turns that
grant into a credential that lasts about an hour. A connection record holds
nothing secret.

Every user grants the same app, so a grant alone does not say which user made
it. Each connection is used only for the user who proved control of it (T116,
design-v3 1.4): Bedrock by the user's own external ID, Foundry by the tenant
in the user's own signed Microsoft sign-in, Vertex AI by a role granted to the
user's own Google identity. Typing another user's project ID, or forging the
tenant in Foundry's consent callback, reaches nothing of theirs.

| Provider | Plug-in | The user types | The record holds | The credential |
| --- | --- | --- | --- | --- |
| Amazon Bedrock | `bedrock.ts` | the 12-digit AWS account ID | the invoke-only role's ARN, the user's external ID | the issuer's token → `AssumeRoleWithWebIdentity` (the app's role) → `AssumeRole` (the user's role, with the external ID): 1 hour |
| Microsoft Foundry | `foundry.ts` | the Foundry resource address, the Azure directory's ID (only where to sign in) | the tenant ID (the `tid` of the user's own Microsoft sign-in, its ID token verified against Microsoft's keys and its `idp` showing a personal Microsoft account; admin consent's callback is only checked against it), the endpoint | client credentials in that tenant only, proven by the app's certificate (or, with `FOUNDRY_CREDENTIAL=federated`, the issuer's token): 60 to 90 minutes |
| Google Vertex AI | `vertex.ts` | the project ID | the project ID | the issuer's token with the user's own app ID as its subject → Google's STS (Workload Identity Federation) → that user's own federated principal's token, used directly: 1 hour |

Connect Microsoft Foundry is two Microsoft pages: the sign-in at the typed
directory's own endpoint (`/{tenant}`, scope `openid`, returning to
`/models/setup/providers/foundry/signed-in`), then admin consent in the
signed-in tenant (`/{tid}/adminconsent`, returning to `.../consented`). Each
leg's state, and the sign-in's nonce, sit on the user's own check row and
are spent on first use; those pending fields alone say which leg an answer
is for. Foundry is for personal Microsoft accounts only (the owner,
2026-11-25): the signed token's `idp` must name the personal Microsoft
account provider, never "`tid` is the consumers tenant", and a work or school
sign-in is refused at Connect, naming Bedrock and Vertex AI, with nothing
stored. There is no one-app-user-per-directory rule: someone a user invites
into their own directory who also uses the app is that directory owner's
responsibility (the owner: "i dont think that should be imagined as a gap,
because its now upto that user that added the other guy onto their
directory. the model related expense managements now exclusively falls on
their shoulders, not mine at all."). Whether the token tells the two apart
every time is checked live in M2 step 11, check 8.

Connect Google Vertex AI shows the user's own principal to grant,
`principal://iam.googleapis.com/projects/<pool project number>/locations/global/workloadIdentityPools/<pool>/subject/<user id>`,
derived from `GOOGLE_WIF_PROVIDER`; no user's project grants a service
account shared by every user. The user ID is always a UUID, and the pool
admits only UUID subjects and one more, `price-reader`: the price table's
reader of Google's Cloud Billing Catalog (`src/prices/google.ts`), which
holds one role on the app's own project and nothing on any user's. A user's
token can never carry `price-reader`, and the price reader's token carries
no user's ID. Both tokens come from the one exchange in
`src/google-federation.ts`.

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
model family Bedrock's own ID is known for), Anthropic's Messages format for
Claude on Foundry (`/anthropic/v1/messages`) and on Vertex AI (`rawPredict`),
Chat Completions for every other Foundry model
(`/openai/v1/chat/completions`, by the user's deployment name) and
`generateContent` for Gemini on Vertex AI. The last two came with Add a model
(T17, `src/models/README.md`) and are checked live in M2 step 3.

## The issuer (`src/issuer.ts`)

The Worker is its own OpenID Connect issuer at
`<APP_ORIGIN>/chief-of-staff/oidc` (`https://akshayprabhakant.com/chief-of-staff/oidc`
once deployed), with its discovery document at
`/chief-of-staff/oidc/.well-known/openid-configuration` and its key set at
`/chief-of-staff/oidc/jwks.json`. Those two paths are the only ones served
without the owner's sign-in: the Worker exempts exactly them from its Access
check, and the owner's `portfolio-app` tool makes a second Access application
on exactly those two paths with a Bypass policy (README "Cloudflare
Access"). Tokens are RS256 and live 5 minutes, with the
audience and subject each provider was told to trust:

| Provider | `aud` | `sub` |
| --- | --- | --- |
| AWS | `sts.amazonaws.com` | `chief-of-staff:bedrock` |
| Google | `https://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/chief-of-staff/providers/chief-of-staff-worker` | the user's own app ID, only for that user's own calls |
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
  own version label (`bedrock-1.0.0`, `foundry-1.1.0`, `vertex-1.1.0`) on
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
- **The Vertex AI assets** (the pool and provider, with each user's own
  principal, and the custom role command) keep the role ID
  `chiefOfStaffModelCaller` and its one permission, so roles users already
  made keep working.
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
- A test call is a real call, sent through the proxy (`sendTestCall` in
  `src/proxy/proxy.ts`), which prices it, writes its ledger row (`task`
  `test_call`), raises `price_missing` and records a removed grant as for any
  call. It needs the model's list price, as every call does; it needs no
  budget yet (budgets come after providers on the checklist), and waits while
  one is set and spent; saving that provider's budget on Models › Setup ›
  Budgets, or Try again, runs it again at once.
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
app role's trust and permission policies, the Google pool and provider, and
the Entra registration with its two return addresses (the Microsoft
sign-in's and admin consent's). Google's pool needs no service account, no
service-account impersonation grant and no API key: each user grants their
own principal. The app's own project needs `sts.googleapis.com` and
`cloudbilling.googleapis.com` enabled, not `aiplatform.googleapis.com` (each
user enables Vertex AI in their own project), and one grant: the price
reader's principal,
`principal://iam.googleapis.com/projects/<project number>/locations/global/workloadIdentityPools/chief-of-staff/subject/price-reader`,
gets a custom role on that project, `chiefOfStaffPriceReader`, holding only
`serviceusage.services.use`, so it can name the project as its quota project. Nothing is guessed during T10.

The Worker reads the values below. Each variable except `APP_ORIGIN` is set
as an environment variable of the GitHub environment `production` (Settings →
Environments → production → Environment variables), never in the Cloudflare
dashboard: every release deploys the ones set there as Worker variables and
leaves out the ones that are not (`scripts/release-deploy.sh`; the
repository README, "Setting the provider variables", has the steps), and a
deploy replaces whatever the dashboard held.
The two secrets are stored with `npx wrangler secret put`, which a deploy
keeps.

| Name | Kind | What |
| --- | --- | --- |
| `APP_ORIGIN` | variable | `https://<host>`, no path; the issuer and Microsoft's sign-in and consent returns are under `<APP_ORIGIN>/chief-of-staff`. Set in `shell/wrangler.jsonc` `"vars"` (`https://akshayprabhakant.com`), so every release ships it |
| `ISSUER_KEYS` | secret | the issuer's keys (above) |
| `AWS_APP_ROLE_ARN` | variable | the app's own role in the owner's AWS account |
| `AWS_REGION` | variable | where STS and Bedrock are called and the stack is made; default `us-east-1` |
| `BEDROCK_TEMPLATE_URL` | variable | the published template version the link opens (`bedrock-template/README.md`) |
| `ENTRA_CLIENT_ID` | variable | the multi-tenant Entra app's client ID |
| `ENTRA_CERT_KEY` | secret | its certificate's private key, PKCS #8 PEM |
| `ENTRA_CERT_THUMBPRINT` | variable | the certificate's `x5t#S256` |
| `FOUNDRY_CREDENTIAL` | variable | `certificate` (default) or `federated` |
| `GOOGLE_WIF_PROVIDER` | variable | the workload identity pool provider's full name; each user's own principal, the price reader's and the price reader's quota project (the pool's own project) are derived from it |

Until they are set, every page still renders, and a test call says plainly
which of the app's own values is missing. A variable added to `production`
reaches the Worker with the next release.

## Waiting on T10 (checked live in M2)

Nothing here has run against a cloud account. M2 steps 1, 2, 10 and the
Connect checks of step 11 (federated credentials across Entra tenants, admin
consent from a personal Microsoft account, a Foundry role without `listkeys`,
a console-enabled Bedrock model through the invoke-only role, Vertex AI
billing to the user's project, the time from revoking a grant to refusal,
and (g): Vertex AI's Claude endpoint answering a per-user federated principal
granted the role directly; if it does not, each user gets their own service
account in the app's project, which only that user's principal may act as),
the Cloud Billing Catalog answering the price reader's federated token with
the app's project as quota project (design-v3 1.6, item 9; if Google refuses
it, the owner is told and no API key is made),
the template version read from a live stack, a live issuer-key rotation, and
Foundry's key question (T13) all wait on the owner's accounts. Google's exact
error strings are recorded from live failures then; real vendor error bodies
saved for tests go only into the private test-examples store.
