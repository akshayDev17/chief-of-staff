import { describe, expect, it } from "vitest";
import {
  appProjectNumber,
  CLOUD_BILLING_READONLY_SCOPE,
  priceReaderGoogleToken,
  userGoogleToken,
  userPrincipal,
  wifAudience,
} from "../src/google-federation";
import { readGoogle } from "../src/prices/google";
import { APP_PROJECT_NUMBER, fakeFetch, googleEnv, PRICE_WIF } from "./fake-sources";
import { APP_ORIGIN, decodeJwt, scriptedFetch } from "./issuer-fixture";
import catalog from "./fixtures/google-catalog-vertex.json";

const NOW = new Date("2026-11-26T06:00:00Z");
const USER = "aaaaaaaa-1111-4111-8111-111111111111";
const POOL = "principal://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/chief-of-staff/subject";

const stsAnswer = () => Response.json({ access_token: "federated-token", token_type: "Bearer", expires_in: 3599 });

describe("the price reader and the users are different identities in the one pool", () => {
  it("names a user by their own app ID, never by the price reader's subject", () => {
    expect(userPrincipal(PRICE_WIF, USER)).toBe(`${POOL}/${USER}`);
    // "price-reader" is not an app ID, so no user's identity can be it.
    expect(userPrincipal(PRICE_WIF, "price-reader")).toBeUndefined();
  });

  it("mints the price reader's token with its own subject and the narrowest Catalog scope", async () => {
    const { fetcher, sent } = scriptedFetch([[/sts\.googleapis\.com/, stsAnswer]]);
    expect(await priceReaderGoogleToken(await googleEnv(), fetcher, NOW)).toEqual({ accessToken: "federated-token", expiresIn: 3599 });
    const body = JSON.parse(sent[0]!.body);
    expect(body).toMatchObject({ audience: PRICE_WIF, scope: CLOUD_BILLING_READONLY_SCOPE, subjectTokenType: "urn:ietf:params:oauth:token-type:jwt" });
    expect(decodeJwt(body.subjectToken).claims).toMatchObject({ iss: `${APP_ORIGIN}/chief-of-staff/oidc`, aud: wifAudience(PRICE_WIF), sub: "price-reader" });
  });

  it("never mints a user's token for the price reader's subject or for anything but an app ID", async () => {
    const { fetcher, sent } = scriptedFetch([[/sts\.googleapis\.com/, stsAnswer]]);
    for (const id of ["price-reader", "", "user-1"]) {
      await expect(userGoogleToken(await googleEnv(), fetcher, NOW, id)).rejects.toThrow(/user's own app ID/);
    }
    expect(sent).toEqual([]);
    await userGoogleToken(await googleEnv(), fetcher, NOW, USER);
    expect(decodeJwt(JSON.parse(sent[0]!.body).subjectToken).claims.sub).toBe(USER);
  });

  it("takes the quota project from the pool's own project, never from elsewhere", () => {
    expect(appProjectNumber(PRICE_WIF)).toBe(APP_PROJECT_NUMBER);
    expect(appProjectNumber("projects/1/pools/p")).toBeUndefined();
  });
});

describe("reading the Cloud Billing Catalog", () => {
  it("sends the price reader's federated token and the app's own project as quota project, and no API key", async () => {
    const { fetcher, sent } = scriptedFetch([
      [/sts\.googleapis\.com/, () => Response.json({ access_token: "reader-token", expires_in: 3599 })],
      [/cloudbilling\.googleapis\.com/, () => Response.json(catalog)],
    ]);
    const read = await readGoogle(fetcher, await googleEnv(), NOW, "2026-11-26");
    expect(read.ok).toBe(true);
    const calls = sent.filter((s) => s.url.startsWith("https://cloudbilling.googleapis.com/"));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer reader-token");
      expect(call.headers.get("x-goog-user-project")).toBe(APP_PROJECT_NUMBER);
      expect(new URL(call.url).searchParams.has("key")).toBe(false);
      expect(new URL(call.url).pathname).toBe("/v1/services/C7E2-9256-1C43/skus");
    }
  });

  it("fails, and calls nothing, until the app's pool exists", async () => {
    const { fetcher, sent } = scriptedFetch([]);
    expect(await readGoogle(fetcher, {}, NOW, "2026-11-26")).toEqual({ source: "google-catalog", ok: false, error: "not configured yet: GOOGLE_WIF_PROVIDER" });
    expect(sent).toEqual([]);
  });

  it("is answered by the fake Catalog only with the price reader's token, as the owner's grant allows", async () => {
    expect((await readGoogle(fakeFetch(), await googleEnv(), NOW, "2026-11-26")).ok).toBe(true);
  });
});
