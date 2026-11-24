// A fetch that answers the vendors' price-source URLs from the saved
// responses in fixtures/, so a refresh runs without the network.
import azure from "./fixtures/azure-retail-eastus2.json";
import awsBedrock from "./fixtures/aws-AmazonBedrock-us-east-1.json";
import awsFoundation from "./fixtures/aws-AmazonBedrockFoundationModels-us-east-1.json";
import google from "./fixtures/google-catalog-vertex.json";

export type Overrides = Partial<Record<"azure" | "aws" | "google", () => Response>>;

const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

export function fakeFetch(overrides: Overrides = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://prices.azure.com/")) return overrides.azure?.() ?? ok(azure);
    if (url.startsWith("https://cloudbilling.googleapis.com/")) return overrides.google?.() ?? ok(google);
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
