// The exact values the owner's one-time provider steps need (T10), worked
// out from a few inputs so nothing is guessed: the issuer's addresses, the
// AWS identity provider and role policies, the Google pool, provider and
// service account, and the Entra app registration. Used by
// provider-setup.mjs `values`; nothing here touches any account. Also the
// issuer key's rotation steps (`rotateIssuerKeys`). No Node-only imports,
// so the Worker's tests import it too.
//
// The audiences, subjects and names are the ones the Worker uses (a test
// checks each against src/): src/issuer.ts, src/providers/bedrock.ts,
// foundry.ts and vertex.ts.

export const ISSUER_PATH = "/oidc";
export const AWS_AUDIENCE = "sts.amazonaws.com";
export const AWS_SUBJECT = "chief-of-staff:bedrock";
export const ROLE_NAME = "chief-of-staff-model-caller";
export const APP_ROLE_NAME = "chief-of-staff-app";
export const ENTRA_SUBJECT = "chief-of-staff:foundry";
export const ENTRA_FEDERATED_AUDIENCE = "api://AzureADTokenExchange";
export const CONSENT_RETURN_PATH = "/models/setup/providers/foundry/consented";
export const GOOGLE_SUBJECT = "chief-of-staff:vertex";
export const GOOGLE_POOL = "chief-of-staff";
export const GOOGLE_PROVIDER = "chief-of-staff-worker";
export const GOOGLE_SERVICE_ACCOUNT_ID = "chief-of-staff-models";
export const TEMPLATE_PREFIX = "chief-of-staff-bedrock-role/";

const ORIGIN = /^https:\/\/[a-z0-9.-]+$/;
const ACCOUNT = /^\d{12}$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const NUMBER = /^\d+$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

// Inputs (none secret): APP_ORIGIN, AWS_ACCOUNT_ID, GOOGLE_PROJECT_ID,
// GOOGLE_PROJECT_NUMBER, GITHUB_REPOSITORY, BEDROCK_TEMPLATE_BUCKET.
export function readValueInputs(env) {
  const checks = [
    ["APP_ORIGIN", ORIGIN, "https://<host>, no path"],
    ["AWS_ACCOUNT_ID", ACCOUNT, "12 digits"],
    ["GOOGLE_PROJECT_ID", PROJECT, "the owner's project ID"],
    ["GOOGLE_PROJECT_NUMBER", NUMBER, "the project's number"],
    ["GITHUB_REPOSITORY", REPO, "<owner>/<repo>"],
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
  const issuerHostPath = issuer.replace(/^https:\/\//, "");
  const appRoleArn = `arn:aws:iam::${i.AWS_ACCOUNT_ID}:role/${APP_ROLE_NAME}`;
  const oidcProviderArn = `arn:aws:iam::${i.AWS_ACCOUNT_ID}:oidc-provider/${issuerHostPath}`;
  const serviceAccount = `${GOOGLE_SERVICE_ACCOUNT_ID}@${i.GOOGLE_PROJECT_ID}.iam.gserviceaccount.com`;
  const wifProvider = `//iam.googleapis.com/projects/${i.GOOGLE_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${GOOGLE_POOL}/providers/${GOOGLE_PROVIDER}`;
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
      // Only the next hop: each user's own invoke-only role, which in turn
      // trusts this role only with that user's external ID.
      appRolePermissionPolicy: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Resource: `arn:aws:iam::*:role/${ROLE_NAME}` }],
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
                "token.actions.githubusercontent.com:sub": `repo:${i.GITHUB_REPOSITORY}:ref:refs/heads/main`,
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
      commands: [
        `gcloud services enable aiplatform.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project=${i.GOOGLE_PROJECT_ID}`,
        `gcloud iam service-accounts create ${GOOGLE_SERVICE_ACCOUNT_ID} --project=${i.GOOGLE_PROJECT_ID} --display-name="Chief of staff models"`,
        `gcloud iam workload-identity-pools create ${GOOGLE_POOL} --project=${i.GOOGLE_PROJECT_ID} --location=global --display-name="Chief of staff"`,
        `gcloud iam workload-identity-pools providers create-oidc ${GOOGLE_PROVIDER} --project=${i.GOOGLE_PROJECT_ID} --location=global --workload-identity-pool=${GOOGLE_POOL} --issuer-uri=${issuer} --allowed-audiences=https:${wifProvider} --attribute-mapping=google.subject=assertion.sub --attribute-condition="assertion.sub=='${GOOGLE_SUBJECT}'"`,
        `gcloud iam service-accounts add-iam-policy-binding ${serviceAccount} --project=${i.GOOGLE_PROJECT_ID} --role=roles/iam.workloadIdentityUser --member=principal://iam.googleapis.com/projects/${i.GOOGLE_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${GOOGLE_POOL}/subject/${GOOGLE_SUBJECT}`,
      ],
      workerVariables: { GOOGLE_WIF_PROVIDER: wifProvider, GOOGLE_SERVICE_ACCOUNT: serviceAccount },
    },
    entra: {
      registration: {
        name: "Chief of staff",
        supportedAccountTypes: "Accounts in any organizational directory (Multitenant)",
        redirectUri: { platform: "Web", uri: `${i.APP_ORIGIN}${CONSENT_RETURN_PATH}` },
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
  Its permission policy:
${json(v.aws.appRolePermissionPolicy)}
  Worker variables:
${vars(v.aws.workerVariables)}
  BEDROCK_TEMPLATE_URL: set after the template's first publish (its run summary prints it).
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

3. Google Vertex AI, in the owner's Google Cloud project
${v.google.commands.map((c) => `  ${c}`).join("\n")}
  Worker variables:
${vars(v.google.workerVariables)}

4. Microsoft Foundry, in the owner's Entra tenant
  App registration:
${json(v.entra.registration)}
  Only if M2 step 11.1 passes, a federated credential:
${json(v.entra.federatedCredential)}
  Worker variables (ENTRA_CERT_THUMBPRINT and the ENTRA_CERT_KEY secret come from \`provider-setup.mjs keys\`):
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
