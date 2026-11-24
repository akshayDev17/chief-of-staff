import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain JavaScript module run by Node.
import * as lib from "../scripts/provider-setup-lib.mjs";
import { ISSUER_PATH } from "../src/issuer";
import { AWS_AUDIENCE, AWS_SUBJECT, ROLE_NAME } from "../src/providers/bedrock";
import { CONSENT_RETURN_PATH, ENTRA_FEDERATED_AUDIENCE, ENTRA_SUBJECT } from "../src/providers/foundry";
import { GOOGLE_SUBJECT, wifAudience } from "../src/providers/vertex";

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
    expect([lib.ISSUER_PATH, lib.AWS_AUDIENCE, lib.AWS_SUBJECT, lib.ROLE_NAME, lib.ENTRA_SUBJECT, lib.ENTRA_FEDERATED_AUDIENCE, lib.CONSENT_RETURN_PATH, lib.GOOGLE_SUBJECT])
      .toEqual([ISSUER_PATH, AWS_AUDIENCE, AWS_SUBJECT, ROLE_NAME, ENTRA_SUBJECT, ENTRA_FEDERATED_AUDIENCE, CONSENT_RETURN_PATH, GOOGLE_SUBJECT]);
  });

  it("trust only the Worker's own token in the app's AWS role, and let it assume only the users' invoke-only roles", () => {
    const v = lib.setupValues(lib.readValueInputs(inputs));
    expect(v.issuer).toEqual({
      url: "https://cos.example.com/oidc",
      discovery: "https://cos.example.com/oidc/.well-known/openid-configuration",
      jwks: "https://cos.example.com/oidc/jwks.json",
    });
    expect(v.aws.appRoleTrustPolicy.Statement[0].Condition).toEqual({
      StringEquals: { "cos.example.com/oidc:aud": "sts.amazonaws.com", "cos.example.com/oidc:sub": "chief-of-staff:bedrock" },
    });
    expect(v.aws.appRoleTrustPolicy.Statement[0].Principal).toEqual({ Federated: "arn:aws:iam::111122223333:oidc-provider/cos.example.com/oidc" });
    expect(v.aws.appRolePermissionPolicy.Statement).toEqual([{ Effect: "Allow", Action: "sts:AssumeRole", Resource: "arn:aws:iam::*:role/chief-of-staff-model-caller" }]);
    expect(v.aws.workerVariables.AWS_APP_ROLE_ARN).toBe("arn:aws:iam::111122223333:role/chief-of-staff-app");
    // The template bucket is public for the templates only.
    expect(v.aws.templateBucketPolicy.Statement[0].Resource).toBe("arn:aws:s3:::cos-templates/chief-of-staff-bedrock-role/*");
    expect(v.aws.publishRoleTrustPolicy.Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]).toBe("repo:example/chief-of-staff:ref:refs/heads/main");
  });

  it("give Google's provider the issuer, the audience the Worker sends and the one subject it may map", () => {
    const v = lib.setupValues(lib.readValueInputs(inputs));
    const provider = v.google.workerVariables.GOOGLE_WIF_PROVIDER;
    expect(provider).toBe("//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/chief-of-staff/providers/chief-of-staff-worker");
    const create = v.google.commands.find((c: string) => c.includes("create-oidc"))!;
    expect(create).toContain("--issuer-uri=https://cos.example.com/oidc");
    expect(create).toContain(`--allowed-audiences=${wifAudience(provider)}`);
    expect(create).toContain("--attribute-mapping=google.subject=assertion.sub");
    expect(create).toContain(`--attribute-condition="assertion.sub=='chief-of-staff:vertex'"`);
    expect(v.google.commands.find((c: string) => c.includes("workloadIdentityUser"))).toContain("/subject/chief-of-staff:vertex");
    expect(v.google.workerVariables.GOOGLE_SERVICE_ACCOUNT).toBe("chief-of-staff-models@cos-owner-project.iam.gserviceaccount.com");
  });

  it("register the Entra app for every organisation, returning to the consent path", () => {
    const v = lib.setupValues(lib.readValueInputs(inputs));
    expect(v.entra.registration.redirectUri).toEqual({ platform: "Web", uri: "https://cos.example.com/models/setup/providers/foundry/consented" });
    expect(v.entra.federatedCredential).toEqual({ scenario: "Other issuer", issuer: "https://cos.example.com/oidc", subject: "chief-of-staff:foundry", audience: "api://AzureADTokenExchange" });
  });

  it("name every missing or malformed input", () => {
    expect(() => lib.readValueInputs({})).toThrow(/APP_ORIGIN is missing.*AWS_ACCOUNT_ID is missing/);
    expect(() => lib.readValueInputs({ ...inputs, APP_ORIGIN: "https://cos.example.com/path", AWS_ACCOUNT_ID: "1" })).toThrow(/APP_ORIGIN is not .*AWS_ACCOUNT_ID is not 12 digits/);
  });

  it("print a checklist with every value and no placeholder left but the Entra client ID", () => {
    const text = lib.renderChecklist(lib.setupValues(lib.readValueInputs(inputs)));
    for (const s of ["aws iam create-open-id-connect-provider --url https://cos.example.com/oidc --client-id-list sts.amazonaws.com", "GOOGLE_WIF_PROVIDER=//iam.googleapis.com/", "ENTRA_CLIENT_ID=<the registration's Application (client) ID>"]) {
      expect(text).toContain(s);
    }
  });
});
