// The exact values the owner's one-time provider steps need (T10), worked
// out from a few inputs so nothing is guessed: the issuer's addresses, the
// AWS identity provider and role policies, the Google pool and provider, and
// the Entra app registration with its two return addresses. Used by
// provider-setup.mjs `values`; nothing here touches any account. Also the
// issuer key's rotation steps (`rotateIssuerKeys`). No Node-only imports,
// so the Worker's tests import it too.
//
// The audiences, subjects and names are the ones the Worker uses (a test
// checks each against src/): src/issuer.ts, src/google-federation.ts and
// src/providers/bedrock.ts, foundry.ts and vertex.ts.

// The app's path on its host (src/paths.ts BASE_PATH): the issuer and the
// consent return live under it.
export const BASE_PATH = "/chief-of-staff";
export const ISSUER_PATH = `${BASE_PATH}/oidc`;
export const AWS_AUDIENCE = "sts.amazonaws.com";
export const AWS_SUBJECT = "chief-of-staff:bedrock";
export const ROLE_NAME = "chief-of-staff-model-caller";
export const APP_ROLE_NAME = "chief-of-staff-app";
export const ENTRA_SUBJECT = "chief-of-staff:foundry";
export const ENTRA_FEDERATED_AUDIENCE = "api://AzureADTokenExchange";
export const CONSENT_RETURN_PATH = `${BASE_PATH}/models/setup/providers/foundry/consented`;
export const SIGN_IN_RETURN_PATH = `${BASE_PATH}/models/setup/providers/foundry/signed-in`;
export const GOOGLE_POOL = "chief-of-staff";
export const GOOGLE_PROVIDER = "chief-of-staff-worker";
// The pool takes exactly two kinds of subject from the issuer: each user's own
// app ID (a UUID, src/users.ts), and the price reader's one fixed subject,
// which is not a UUID, so neither can pass for the other.
export const GOOGLE_USER_SUBJECT_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
export const GOOGLE_PRICE_READER_SUBJECT = "price-reader";
export const GOOGLE_SUBJECT_CONDITION = `assertion.sub.matches('${GOOGLE_USER_SUBJECT_PATTERN}') || assertion.sub == '${GOOGLE_PRICE_READER_SUBJECT}'`;
// The one role the price reader holds, a custom role on the app's own project
// only, with the one permission that lets the reader name that project as its
// quota project.
export const GOOGLE_PRICE_READER_ROLE_ID = "chiefOfStaffPriceReader";
export const GOOGLE_PRICE_READER_PERMISSION = "serviceusage.services.use";
export const TEMPLATE_PREFIX = "chief-of-staff-bedrock-role/";

const ORIGIN = /^https:\/\/[a-z0-9.-]+$/;
const ACCOUNT = /^\d{12}$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const NUMBER = /^\d+$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

// Inputs (none secret): APP_ORIGIN, AWS_ACCOUNT_ID, GOOGLE_PROJECT_ID,
// GOOGLE_PROJECT_NUMBER, GITHUB_REPOSITORY, GITHUB_OWNER_ID,
// GITHUB_REPOSITORY_ID, BEDROCK_TEMPLATE_BUCKET. The two IDs are the numbers
// in `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`'s
// sub_claim_prefix, repo:<owner>@<owner_id>/<repo>@<repo_id>: the repository
// uses GitHub's immutable OIDC subject, so its tokens carry them.
export function readValueInputs(env) {
  const checks = [
    ["APP_ORIGIN", ORIGIN, "https://<host>, no path"],
    ["AWS_ACCOUNT_ID", ACCOUNT, "12 digits"],
    ["GOOGLE_PROJECT_ID", PROJECT, "the owner's project ID"],
    ["GOOGLE_PROJECT_NUMBER", NUMBER, "the project's number"],
    ["GITHUB_REPOSITORY", REPO, "<owner>/<repo>"],
    ["GITHUB_OWNER_ID", NUMBER, "the owner's numeric GitHub ID"],
    ["GITHUB_REPOSITORY_ID", NUMBER, "the repository's numeric GitHub ID"],
    ["BEDROCK_TEMPLATE_BUCKET", BUCKET, "an S3 bucket name"],
  ];
  const problems = [];
  const inputs = {};
  for (const [name, pattern, hint] of checks) {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is missing (${hint})`);
    else if (!pattern.test(value)) problems.push(`${name} is not ${hint}`);
    else inputs[name] = value;
  }
  if (problems.length) throw new Error(problems.join("; "));
  return inputs;
}

export function setupValues(i) {
  const issuer = `${i.APP_ORIGIN}${ISSUER_PATH}`;
  const [repoOwner, repoName] = i.GITHUB_REPOSITORY.split("/");
  const githubSubjectPrefix = `repo:${repoOwner}@${i.GITHUB_OWNER_ID}/${repoName}@${i.GITHUB_REPOSITORY_ID}`;
  const issuerHostPath = issuer.replace(/^https:\/\//, "");
  const appRoleArn = `arn:aws:iam::${i.AWS_ACCOUNT_ID}:role/${APP_ROLE_NAME}`;
  const oidcProviderArn = `arn:aws:iam::${i.AWS_ACCOUNT_ID}:oidc-provider/${issuerHostPath}`;
  const wifProvider = `//iam.googleapis.com/projects/${i.GOOGLE_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${GOOGLE_POOL}/providers/${GOOGLE_PROVIDER}`;
  const poolPrincipal = (subject) => `principal://iam.googleapis.com/projects/${i.GOOGLE_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${GOOGLE_POOL}/subject/${subject}`;
  const priceReaderPrincipal = poolPrincipal(GOOGLE_PRICE_READER_SUBJECT);
  const publishRoleArn = `arn:aws:iam::${i.AWS_ACCOUNT_ID}:role/chief-of-staff-template-publisher`;
  return {
    issuer: {
      url: issuer,
      discovery: `${issuer}/.well-known/openid-configuration`,
      jwks: `${issuer}/jwks.json`,
    },
    aws: {
      oidcProviderCommand: `aws iam create-open-id-connect-provider --url ${issuer} --client-id-list ${AWS_AUDIENCE}`,
      appRoleName: APP_ROLE_NAME,
      appRoleArn,
      // Only the Worker's own token, with the Bedrock audience and subject.
      appRoleTrustPolicy: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Federated: oidcProviderArn },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: { StringEquals: { [`${issuerHostPath}:aud`]: AWS_AUDIENCE, [`${issuerHostPath}:sub`]: AWS_SUBJECT } },
          },
        ],
      },
      // The next hop: each user's own model-caller role, which in turn trusts
      // this role only with that user's external ID. And Bedrock's own model
      // list, read once a day and on Refresh model list for the Connect
      // screen's model list (src/providers/bedrock-catalog.ts, T17):
      // ListFoundationModels has no resource type, so it takes "*"; nothing
      // here can call a model.
      appRolePermissionPolicy: {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "sts:AssumeRole", Resource: `arn:aws:iam::*:role/${ROLE_NAME}` },
          { Sid: "ReadBedrockModelList", Effect: "Allow", Action: ["bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles"], Resource: "*" },
        ],
      },
      templateBucket: i.BEDROCK_TEMPLATE_BUCKET,
      templateBucketPolicy: {
        Version: "2012-10-17",
        Statement: [
          { Sid: "PublicReadTemplates", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::${i.BEDROCK_TEMPLATE_BUCKET}/${TEMPLATE_PREFIX}*` },
        ],
      },
      publishRoleArn,
      publishRoleTrustPolicy: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Federated: `arn:aws:iam::${i.AWS_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com` },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub": `${githubSubjectPrefix}:ref:refs/heads/main`,
              },
            },
          },
        ],
      },
      publishRolePermissionPolicy: {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: `arn:aws:s3:::${i.BEDROCK_TEMPLATE_BUCKET}/${TEMPLATE_PREFIX}*` },
          { Effect: "Allow", Action: "cloudformation:ValidateTemplate", Resource: "*" },
        ],
      },
      workerVariables: { AWS_APP_ROLE_ARN: appRoleArn, AWS_REGION: "us-east-1" },
      githubVariables: { BEDROCK_TEMPLATE_BUCKET: i.BEDROCK_TEMPLATE_BUCKET, BEDROCK_PUBLISH_ROLE_ARN: publishRoleArn },
    },
    google: {
      // The app's project needs only STS (the token exchange) and the Cloud
      // Billing API (the price reader's quota project). Vertex AI is enabled
      // in each user's own project, never here.
      commands: [
        `gcloud services enable sts.googleapis.com cloudbilling.googleapis.com --project=${i.GOOGLE_PROJECT_ID}`,
        `gcloud iam workload-identity-pools create ${GOOGLE_POOL} --project=${i.GOOGLE_PROJECT_ID} --location=global --display-name="Chief of staff"`,
        `gcloud iam workload-identity-pools providers create-oidc ${GOOGLE_PROVIDER} --project=${i.GOOGLE_PROJECT_ID} --location=global --workload-identity-pool=${GOOGLE_POOL} --issuer-uri=${issuer} --allowed-audiences=https:${wifProvider} --attribute-mapping=google.subject=assertion.sub --attribute-condition="${GOOGLE_SUBJECT_CONDITION}"`,
        `gcloud iam roles create ${GOOGLE_PRICE_READER_ROLE_ID} --project=${i.GOOGLE_PROJECT_ID} --title="Chief of staff price reader" --permissions=${GOOGLE_PRICE_READER_PERMISSION}`,
        `gcloud projects add-iam-policy-binding ${i.GOOGLE_PROJECT_ID} --member=${priceReaderPrincipal} --role=projects/${i.GOOGLE_PROJECT_ID}/roles/${GOOGLE_PRICE_READER_ROLE_ID}`,
      ],
      // What each user grants on their own project, shown on their Connect screen.
      userPrincipal: poolPrincipal("<user id>"),
      // The price table's reader of the Cloud Billing Catalog (src/prices/google.ts).
      priceReaderPrincipal,
      workerVariables: { GOOGLE_WIF_PROVIDER: wifProvider },
    },
    entra: {
      registration: {
        name: "Chief of staff",
        supportedAccountTypes: "Accounts in any organizational directory (Multitenant)",
        // Microsoft's sign-in returns to the first, its admin consent to the second.
        redirectUris: { platform: "Web", uris: [`${i.APP_ORIGIN}${SIGN_IN_RETURN_PATH}`, `${i.APP_ORIGIN}${CONSENT_RETURN_PATH}`] },
        apiPermissions: "none (the app needs no Microsoft Graph permission; each user gives it a role on their Foundry resource)",
        certificate: "upload the public certificate printed by `provider-setup.mjs keys`",
      },
      // Only if M2 step 11.1 shows a federated credential works across tenants.
      federatedCredential: { scenario: "Other issuer", issuer, subject: ENTRA_SUBJECT, audience: ENTRA_FEDERATED_AUDIENCE },
      workerVariables: { ENTRA_CLIENT_ID: "<the registration's Application (client) ID>", FOUNDRY_CREDENTIAL: "certificate" },
    },
    worker: { APP_ORIGIN: i.APP_ORIGIN },
  };
}

const json = (v) => JSON.stringify(v, null, 2);
const vars = (o) => Object.entries(o).map(([k, v]) => `  ${k}=${v}`).join("\n");

// The checklist as the owner reads it, in the order of the T10 steps.
export function renderChecklist(v) {
  return `Chief of staff: the provider values for T10 (none of them secret)

1. The app's issuer (Worker variable and secret)
  APP_ORIGIN=${v.worker.APP_ORIGIN}
  issuer URL:   ${v.issuer.url}
  discovery:    ${v.issuer.discovery}
  key set:      ${v.issuer.jwks}
  ISSUER_KEYS: the secret from \`provider-setup.mjs keys\`

2. Amazon Bedrock, in the owner's AWS account
  ${v.aws.oidcProviderCommand}
  Role ${v.aws.appRoleName}, trust policy:
${json(v.aws.appRoleTrustPolicy)}
  Its permission policy (a role made before 2026-11-27 needs its second
  statement added: it lets the app read Bedrock's own model list):
${json(v.aws.appRolePermissionPolicy)}
  Worker variables (GitHub environment \`production\`, as environment variables):
${vars(v.aws.workerVariables)}
  BEDROCK_TEMPLATE_URL: set in \`production\` after the template's first publish (its run summary prints it).
  Template bucket ${v.aws.templateBucket}, bucket policy:
${json(v.aws.templateBucketPolicy)}
  GitHub's identity provider (once per account):
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com
  Publish role ${v.aws.publishRoleArn}, trust policy:
${json(v.aws.publishRoleTrustPolicy)}
  Its permission policy:
${json(v.aws.publishRolePermissionPolicy)}
  GitHub repository variables:
${vars(v.aws.githubVariables)}

3. Google: Vertex AI and the price table, in the app's own Google Cloud project
${v.google.commands.map((c) => `  ${c}`).join("\n")}
  No service account, no service-account impersonation grant and no API key is
  needed. Each user grants the role on their own project to their own
  principal in the pool, shown on their Connect screen:
    ${v.google.userPrincipal}
  The price table reads Google's Cloud Billing Catalog as the pool's price
  reader, which holds only the role above, on this project only, so it can
  name this project as its quota project:
    ${v.google.priceReaderPrincipal}
  Whether the Catalog takes that token is checked live in M2; if Google
  refuses it, stop and tell the owner (no API key is made instead).
  Worker variables (GitHub environment \`production\`, as environment variables):
${vars(v.google.workerVariables)}

4. Microsoft Foundry, in the owner's Entra tenant
  Add both return addresses under Authentication → Web → Redirect URIs:
    Microsoft sign-in return:  ${v.entra.registration.redirectUris.uris[0]}
    admin consent return:      ${v.entra.registration.redirectUris.uris[1]}
  App registration:
${json(v.entra.registration)}
  Foundry connects personal Microsoft accounts only (T116). Their sign-in is at
  each user's own Azure directory (login.microsoftonline.com/<tenant ID>), not
  /organizations, which Microsoft says admits only work or school accounts.
  Microsoft's pages do not say whether the multitenant account type above
  admits a personal account signing in to its own directory: M2 step 11,
  check 8 tries it. If it is refused, change Supported account types to
  "Accounts in any organizational directory and personal Microsoft accounts".
  Only if M2 step 11.1 passes, a federated credential:
${json(v.entra.federatedCredential)}
  Worker variables (GitHub environment \`production\`, as environment variables; ENTRA_CERT_THUMBPRINT and the ENTRA_CERT_KEY secret come from \`provider-setup.mjs keys\`):
${vars(v.entra.workerVariables)}
`;
}

// One step of rotating the issuer key (README "Rotating the issuer key"):
// old and new public keys stay published together until the old one is
// retired. Returns the new ISSUER_KEYS value.
export function rotateIssuerKeys(current, step, newKey) {
  const keys = current.keys;
  if (step === "publish") {
    if (keys.length !== 1) throw new Error("a rotation is already under way: finish it with sign and retire first");
    if (!newKey) throw new Error("publish needs a new key");
    return { signing: current.signing, keys: [...keys, newKey] };
  }
  if (step === "sign") {
    const other = keys.find((k) => k.kid !== current.signing);
    if (keys.length !== 2 || !other) throw new Error("sign needs exactly two keys: publish the new one first");
    return { signing: other.kid, keys };
  }
  if (step === "retire") {
    if (keys.length < 2) throw new Error("nothing to retire: only the signing key is published");
    return { signing: current.signing, keys: keys.filter((k) => k.kid === current.signing) };
  }
  throw new Error("the step is publish, sign or retire");
}
