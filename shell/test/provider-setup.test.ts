import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain JavaScript module run by Node.
import * as lib from "../scripts/provider-setup-lib.mjs";
import { ISSUER_PATH } from "../src/issuer";
import { BASE_PATH } from "../src/paths";
import { AWS_AUDIENCE, AWS_SUBJECT, ROLE_NAME } from "../src/providers/bedrock";
import { CONSENT_RETURN_PATH, ENTRA_FEDERATED_AUDIENCE, ENTRA_SUBJECT, SIGN_IN_RETURN_PATH } from "../src/providers/foundry";
import { PRICE_READER_SUBJECT, USER_SUBJECT, userPrincipal, wifAudience } from "../src/google-federation";

const inputs = {
  APP_ORIGIN: "https://cos.example.com",
  AWS_ACCOUNT_ID: "111122223333",
  GOOGLE_PROJECT_ID: "cos-owner-project",
  GOOGLE_PROJECT_NUMBER: "123456789",
  GITHUB_REPOSITORY: "example/chief-of-staff",
  BEDROCK_TEMPLATE_BUCKET: "cos-templates",
};

describe("the owner's setup values", () => {
  it("use exactly the audiences, subjects and names the Worker uses", () => {
    expect([lib.BASE_PATH, lib.ISSUER_PATH, lib.AWS_AUDIENCE, lib.AWS_SUBJECT, lib.ROLE_NAME, lib.ENTRA_SUBJECT, lib.ENTRA_FEDERATED_AUDIENCE, lib.CONSENT_RETURN_PATH, lib.SIGN_IN_RETURN_PATH])
      .toEqual([BASE_PATH, ISSUER_PATH, AWS_AUDIENCE, AWS_SUBJECT, ROLE_NAME, ENTRA_SUBJECT, ENTRA_FEDERATED_AUDIENCE, CONSENT_RETURN_PATH, SIGN_IN_RETURN_PATH]);
  });

  it("trust only the Worker's own token in the app's AWS role, and let it assume only the users' invoke-only roles", () => {
    const v = lib.setupValues(lib.readValueInputs(inputs));
    expect(v.issuer).toEqual({
      url: "https://cos.example.com/chief-of-staff/oidc",
      discovery: "https://cos.example.com/chief-of-staff/oidc/.well-known/openid-configuration",
      jwks: "https://cos.example.com/chief-of-staff/oidc/jwks.json",
    });
    expect(v.aws.appRoleTrustPolicy.Statement[0].Condition).toEqual({
      StringEquals: { "cos.example.com/chief-of-staff/oidc:aud": "sts.amazonaws.com", "cos.example.com/chief-of-staff/oidc:sub": "chief-of-staff:bedrock" },
    });
    expect(v.aws.appRoleTrustPolicy.Statement[0].Principal).toEqual({ Federated: "arn:aws:iam::111122223333:oidc-provider/cos.example.com/chief-of-staff/oidc" });
    expect(v.aws.appRolePermissionPolicy.Statement).toEqual([{ Effect: "Allow", Action: "sts:AssumeRole", Resource: "arn:aws:iam::*:role/chief-of-staff-model-caller" }]);
    expect(v.aws.workerVariables.AWS_APP_ROLE_ARN).toBe("arn:aws:iam::111122223333:role/chief-of-staff-app");
    // The template bucket is public for the templates only.
    expect(v.aws.templateBucketPolicy.Statement[0].Resource).toBe("arn:aws:s3:::cos-templates/chief-of-staff-bedrock-role/*");
    expect(v.aws.publishRoleTrustPolicy.Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]).toBe("repo:example/chief-of-staff:ref:refs/heads/main");
  });

  it("give Google's provider the issuer and the audience the Worker sends, map each user's own app ID, and make no service account", () => {
    const v = lib.setupValues(lib.readValueInputs(inputs));
    const provider = v.google.workerVariables.GOOGLE_WIF_PROVIDER;
    expect(provider).toBe("//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/chief-of-staff/providers/chief-of-staff-worker");
    const create = v.google.commands.find((c: string) => c.includes("create-oidc"))!;
    expect(create).toContain("--issuer-uri=https://cos.example.com/chief-of-staff/oidc");
    expect(create).toContain(`--allowed-audiences=${wifAudience(provider)}`);
    expect(create).toContain("--attribute-mapping=google.subject=assertion.sub");
    expect(create).toContain(`--attribute-condition="assertion.sub.matches('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || assertion.sub == 'price-reader'"`);
    // The condition takes the app IDs the Worker mints for and the price
    // reader's one subject, and nothing else; the two never overlap.
    expect([lib.GOOGLE_USER_SUBJECT_PATTERN, lib.GOOGLE_PRICE_READER_SUBJECT]).toEqual([USER_SUBJECT.source, PRICE_READER_SUBJECT]);
    const [, pattern, exact] = /^assertion\.sub\.matches\('(.+)'\) \|\| assertion\.sub == '(.+)'$/.exec(lib.GOOGLE_SUBJECT_CONDITION)!;
    const admits = (sub: string) => new RegExp(pattern!).test(sub) || sub === exact;
    expect(admits(crypto.randomUUID())).toBe(true);
    expect(admits("price-reader")).toBe(true);
    expect(new RegExp(pattern!).test("price-reader")).toBe(false);
    for (const other of ["chief-of-staff:vertex", "chief-of-staff:bedrock", "chief-of-staff:foundry", "price-reader-2", "Price-Reader"]) expect(admits(other), other).toBe(false);
    // No service account, and no impersonation grant: each user grants their own principal.
    for (const c of v.google.commands) expect(c).not.toMatch(/service-accounts|workloadIdentityUser|iamcredentials/);
    expect(v.google.workerVariables).toEqual({ GOOGLE_WIF_PROVIDER: provider });
    // The principal the checklist names is the one the Worker shows each user.
    expect(v.google.userPrincipal).toBe("principal://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/chief-of-staff/subject/<user id>");
    const user = crypto.randomUUID();
    expect(userPrincipal(provider, user)).toBe(v.google.userPrincipal.replace("<user id>", user));
    expect(v.google.priceReaderPrincipal).toBe(v.google.userPrincipal.replace("<user id>", PRICE_READER_SUBJECT));
  });

  it("enable only STS and the Cloud Billing API on the app's project, and grant the price reader only the quota-project role there", () => {
    const v = lib.setupValues(lib.readValueInputs(inputs));
    expect(v.google.commands[0]).toBe("gcloud services enable sts.googleapis.com cloudbilling.googleapis.com --project=cos-owner-project");
    for (const c of v.google.commands) expect(c).not.toContain("aiplatform");
    const grants = v.google.commands.filter((c: string) => c.includes("add-iam-policy-binding"));
    expect(grants).toEqual([
      "gcloud projects add-iam-policy-binding cos-owner-project --member=principal://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/chief-of-staff/subject/price-reader --role=roles/serviceusage.serviceUsageConsumer",
    ]);
    // No API key anywhere.
    const text = lib.renderChecklist(v);
    expect(text).not.toMatch(/api-keys|GOOGLE_BILLING_API_KEY/);
    expect(text).toContain(v.google.priceReaderPrincipal);
  });

  it("register the Entra app for every organisation, returning to the sign-in and the consent paths", () => {
    const v = lib.setupValues(lib.readValueInputs(inputs));
    expect(v.entra.registration.redirectUris).toEqual({
      platform: "Web",
      uris: ["https://cos.example.com/chief-of-staff/models/setup/providers/foundry/signed-in", "https://cos.example.com/chief-of-staff/models/setup/providers/foundry/consented"],
    });
    expect(v.entra.federatedCredential).toEqual({ scenario: "Other issuer", issuer: "https://cos.example.com/chief-of-staff/oidc", subject: "chief-of-staff:foundry", audience: "api://AzureADTokenExchange" });
  });

  it("name every missing or malformed input", () => {
    expect(() => lib.readValueInputs({})).toThrow(/APP_ORIGIN is missing.*AWS_ACCOUNT_ID is missing/);
    expect(() => lib.readValueInputs({ ...inputs, APP_ORIGIN: "https://cos.example.com/path", AWS_ACCOUNT_ID: "1" })).toThrow(/APP_ORIGIN is not .*AWS_ACCOUNT_ID is not 12 digits/);
  });

  it("print a checklist with every value, no placeholder left but the Entra client ID and each user's own ID, the sign-in return address, and no Vertex AI service account", () => {
    const text = lib.renderChecklist(lib.setupValues(lib.readValueInputs(inputs)));
    expect(text).toContain("Microsoft sign-in return:  https://cos.example.com/chief-of-staff/models/setup/providers/foundry/signed-in");
    expect(text).toContain("admin consent return:      https://cos.example.com/chief-of-staff/models/setup/providers/foundry/consented");
    // Personal accounts sign in at their own directory; the account type is checked live.
    expect(text).toContain("each user's own Azure directory (login.microsoftonline.com/<tenant ID>), not\n  /organizations");
    expect(text).toContain('"Accounts in any organizational directory and personal Microsoft accounts"');
    expect(text).toContain("No service account, no service-account impersonation grant and no API key is\n  needed.");
    expect(text).toContain("principal://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/chief-of-staff/subject/<user id>");
    expect(text).not.toContain("GOOGLE_SERVICE_ACCOUNT");
    for (const s of ["aws iam create-open-id-connect-provider --url https://cos.example.com/chief-of-staff/oidc --client-id-list sts.amazonaws.com", "GOOGLE_WIF_PROVIDER=//iam.googleapis.com/", "ENTRA_CLIENT_ID=<the registration's Application (client) ID>"]) {
      expect(text).toContain(s);
    }
  });
});
