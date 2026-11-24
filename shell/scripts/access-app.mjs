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

export const APP_NAME = "chief-of-staff";
export const POLICY_NAME = "chief-of-staff: owner only";
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

  const policies = await request("GET", `${base}/policies?per_page=1000`);
  const existingPolicy = findByName(policies, POLICY_NAME, "policy");
  const policy = existingPolicy
    ? await request("PUT", `${base}/policies/${existingPolicy.id}`, policyBody(ownerEmail))
    : await request("POST", `${base}/policies`, policyBody(ownerEmail));

  const apps = await request("GET", `${base}/apps?per_page=1000`);
  const existingApp = findByName(apps, APP_NAME, "application");
  const app = existingApp
    ? await request("PUT", `${base}/apps/${existingApp.id}`, appBody(domain, policy.id))
    : await request("POST", `${base}/apps`, appBody(domain, policy.id));

  return {
    appId: app.id,
    aud: app.aud,
    policyId: policy.id,
    created: { app: !existingApp, policy: !existingPolicy },
  };
};
