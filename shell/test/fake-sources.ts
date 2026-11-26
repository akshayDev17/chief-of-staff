// A fetch that answers the vendors' price-source URLs from the saved
// responses in fixtures/, so a refresh runs without the network. Google's
// STS answers each subject token with that subject's own federated token, and
// the Cloud Billing Catalog answers only the price reader's token with the
// app's own project as quota project, as the owner's T10 grant allows.
import type { GoogleFederationEnv } from "../src/google-federation";
import azure from "./fixtures/azure-retail-eastus2.json";
import awsBedrock from "./fixtures/aws-AmazonBedrock-us-east-1.json";
import awsFoundation from "./fixtures/aws-AmazonBedrockFoundationModels-us-east-1.json";
import google from "./fixtures/google-catalog-vertex.json";
import { APP_ORIGIN, decodeJwt, issuerKey, issuerKeys } from "./issuer-fixture";

export type Overrides = Partial<Record<"azure" | "aws" | "google" | "sts", () => Response>>;

// The app's own project number, which holds the pool.
export const APP_PROJECT_NUMBER = "123456789";
export const PRICE_WIF = `//iam.googleapis.com/projects/${APP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/chief-of-staff/providers/chief-of-staff-worker`;

let keys: Promise<string> | undefined;
// The app's Google identity as T10 sets it, with a test-only issuer key.
export async function googleEnv(): Promise<GoogleFederationEnv> {
  keys ??= issuerKey("price-k1").then((k) => issuerKeys("price-k1", [k]));
  return { APP_ORIGIN, ISSUER_KEYS: await keys, GOOGLE_WIF_PROVIDER: PRICE_WIF };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const denied = () =>
  Response.json({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, { status: 403 });

export function fakeFetch(overrides: Overrides = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = request.url;
    if (url.startsWith("https://prices.azure.com/")) return overrides.azure?.() ?? ok(azure);
    if (url === "https://sts.googleapis.com/v1/token") {
      if (overrides.sts) return overrides.sts();
      const { subjectToken } = (await request.json()) as { subjectToken: string };
      return ok({ access_token: `federated-token-for-${decodeJwt(subjectToken).claims.sub}`, token_type: "Bearer", expires_in: 3599 });
    }
    if (url.startsWith("https://cloudbilling.googleapis.com/")) {
      if (overrides.google) return overrides.google();
      const authorized =
        request.headers.get("authorization") === "Bearer federated-token-for-price-reader" &&
        request.headers.get("x-goog-user-project") === APP_PROJECT_NUMBER &&
        !new URL(url).searchParams.has("key");
      return authorized ? ok(google) : denied();
    }
    if (url.startsWith("https://pricing.us-east-1.amazonaws.com/")) {
      if (overrides.aws) return overrides.aws();
      const offer = url.includes("AmazonBedrockFoundationModels") ? "AmazonBedrockFoundationModels" : "AmazonBedrock";
      if (url.endsWith("region_index.json"))
        return ok({ regions: { "us-east-1": { regionCode: "us-east-1", currentVersionUrl: `/offers/v1.0/aws/${offer}/20261123/us-east-1/index.json` } } });
      return ok(offer === "AmazonBedrock" ? awsBedrock : awsFoundation);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
