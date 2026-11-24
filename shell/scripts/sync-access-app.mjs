#!/usr/bin/env node
// Deploy-time entry point for access-app.mjs. Reads CLOUDFLARE_API_TOKEN,
// CLOUDFLARE_ACCOUNT_ID, ACCESS_APP_DOMAIN and OWNER_EMAIL from the
// environment and prints the application's id and AUD tag (never the email).
// See README "Cloudflare Access". Not run by any CI job yet: the deploy
// ticket wires it in once T10's Cloudflare token exists.
import { cloudflareApi, readInputs, syncAccessApp } from "./access-app.mjs";

try {
  const inputs = readInputs(process.env);
  const result = await syncAccessApp(cloudflareApi(inputs.token), inputs);
  console.log(JSON.stringify({ appId: result.appId, aud: result.aud, policyId: result.policyId, issuerAppId: result.issuerAppId, created: result.created }));
} catch (error) {
  console.error(`sync-access-app: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
