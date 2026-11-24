// Creates or updates the one Cloudflare Access application in front of the
// shell Worker's whole address, with one reusable policy that allows only
// the owner's email (T15; design-v3 section 10.3). Run by the deploy
// pipeline once T10's Cloudflare API token exists, through
// sync-access-app.mjs; never by hand against an account.
//
// Cloudflare API pages read 2026-11-24:
// - Applications create/update:
//   https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/
//   POST /accounts/{account_id}/access/apps, PUT .../access/apps/{app_id};
//   `destinations` replaces the deprecated `self_hosted_domains`.
// - Reusable policies:
//   https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/policies/methods/create/
//   POST /accounts/{account_id}/access/policies. The app-scoped policy page
//   recommends "creating a reusable policy instead and subsequently
//   referencing its ID in the application's 'policies' array."
// - An email rule is {"email": {"email": "<address>"}}.
//
// The owner's email is personal data: it arrives at run time from the
// pipeline's OWNER_EMAIL secret and is never logged or written anywhere.
//
// One exception to "owner only" (T16): the app's OpenID Connect issuer
// publishes two documents that AWS, Google and Microsoft fetch without any
// sign-in, its discovery document and its key set. A second application
// covers exactly those two paths with a reusable Bypass policy. Cloudflare's
// pages, read 2026-11-25: "The Bypass action in Cloudflare Access disables
// Access enforcement for specific traffic" (Access policies, dateModified
// 2026-11-17); "When multiple rules are set for a common root path, the more
// specific rule takes precedence" (Application paths, dateModified
// 2026-04-17); a public destination's `uri` is "The public hostname and
// optional path to secure"; the `everyone` rule is "An empty object which
// matches on all users". The Worker itself exempts exactly the same two paths
// (src/issuer.ts PUBLIC_ISSUER_PATHS) and nothing else.

export const APP_NAME = "chief-of-staff";
export const POLICY_NAME = "chief-of-staff: owner only";
export const ISSUER_APP_NAME = "chief-of-staff: issuer documents";
export const ISSUER_POLICY_NAME = "chief-of-staff: issuer documents are public";
// The same paths as src/issuer.ts PUBLIC_ISSUER_PATHS (a test checks).
export const ISSUER_PATHS = ["/oidc/.well-known/openid-configuration", "/oidc/jwks.json"];
// Access allows sessions up to one month; the app asks for the longest
// (design-v3 section 10.3, R6).
export const SESSION_DURATION = "730h";

export const policyBody = (ownerEmail) => ({
  name: POLICY_NAME,
  decision: "allow",
  include: [{ email: { email: ownerEmail } }],
  exclude: [],
  require: [],
});

export const appBody = (domain, policyId) => ({
  name: APP_NAME,
  type: "self_hosted",
  domain,
  // `<host>` covers every path; the address is the app's whole address.
  destinations: [{ type: "public", uri: domain }],
  session_duration: SESSION_DURATION,
  app_launcher_visible: false,
  policies: [{ id: policyId, precedence: 1 }],
});

export const issuerPolicyBody = () => ({
  name: ISSUER_POLICY_NAME,
  decision: "bypass",
  include: [{ everyone: {} }],
  exclude: [],
  require: [],
});

// Exactly the issuer's two documents, nothing wider.
export const issuerAppBody = (domain, policyId) => ({
  name: ISSUER_APP_NAME,
  type: "self_hosted",
  domain: `${domain}${ISSUER_PATHS[0]}`,
  destinations: ISSUER_PATHS.map((path) => ({ type: "public", uri: `${domain}${path}` })),
  app_launcher_visible: false,
  policies: [{ id: policyId, precedence: 1 }],
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^[a-z0-9.-]+\.[a-z]{2,}$/;

export const readInputs = (env) => {
  const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "ACCESS_APP_DOMAIN", "OWNER_EMAIL"]
    .filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
  const domain = env.ACCESS_APP_DOMAIN.trim();
  if (!HOST.test(domain)) throw new Error("ACCESS_APP_DOMAIN must be a host name only, without a scheme or path");
  const ownerEmail = env.OWNER_EMAIL.trim();
  // The address itself is never echoed.
  if (!EMAIL.test(ownerEmail)) throw new Error("OWNER_EMAIL is not an email address");
  return {
    token: env.CLOUDFLARE_API_TOKEN.trim(),
    accountId: env.CLOUDFLARE_ACCOUNT_ID.trim(),
    domain,
    ownerEmail,
  };
};

// `request(method, path, body)` resolves to the API's `result`, or throws.
export const cloudflareApi = (token, fetchImpl = fetch) => async (method, path, body) => {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const codes = (payload.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`${method} ${path} failed (${response.status}) ${codes}`);
  }
  return payload.result;
};

const findByName = (items, name, what) => {
  const matches = (items ?? []).filter((item) => item.name === name);
  if (matches.length > 1) throw new Error(`more than one Access ${what} named "${name}"; fix by hand`);
  return matches[0];
};

// Returns the application's id and AUD tag, which the pipeline sets as the
// Worker's ACCESS_AUD variable.
export const syncAccessApp = async (request, { accountId, domain, ownerEmail }) => {
  const base = `/accounts/${accountId}/access`;

  const upsert = async (kind, items, name, body) => {
    const existing = findByName(items, name, kind === "policies" ? "policy" : "application");
    const result = existing
      ? await request("PUT", `${base}/${kind}/${existing.id}`, body)
      : await request("POST", `${base}/${kind}`, body);
    return { result, created: !existing };
  };

  const policies = await request("GET", `${base}/policies?per_page=1000`);
  const policy = await upsert("policies", policies, POLICY_NAME, policyBody(ownerEmail));
  const issuerPolicy = await upsert("policies", policies, ISSUER_POLICY_NAME, issuerPolicyBody());

  const apps = await request("GET", `${base}/apps?per_page=1000`);
  const app = await upsert("apps", apps, APP_NAME, appBody(domain, policy.result.id));
  const issuerApp = await upsert("apps", apps, ISSUER_APP_NAME, issuerAppBody(domain, issuerPolicy.result.id));

  return {
    appId: app.result.id,
    aud: app.result.aud,
    policyId: policy.result.id,
    issuerAppId: issuerApp.result.id,
    created: { app: app.created, policy: policy.created, issuerApp: issuerApp.created, issuerPolicy: issuerPolicy.created },
  };
};
