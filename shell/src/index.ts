import maintainerFile from "../prices/maintainer-read.json";
import { checkMaintainerEntries, entriesDueForReading, type MaintainerEntry } from "./prices/maintainer";
import { parseSort, renderPriceTablePage } from "./prices/page";
import { refreshPrices } from "./prices/refresh";
import { addAlert, currentSnapshot, readSnapshotRows, recentAlerts } from "./prices/store";
import { accessDenied, readAccessIdentity } from "./access";
import { handleIssuerRequest, PUBLIC_ISSUER_PATHS, readAppOrigin } from "./issuer";
import { runDueChecks } from "./providers/check";
import { providerPlugins, type ProvidersEnv } from "./providers/index";
import { handleProviders, isProvidersPath } from "./providers/page";
import { handleAddModel, isAddModelPath } from "./models/page";
import { handleTaskModels, isTaskModelsPath } from "./models/picker-page";
import { handleBudgets } from "./proxy/budgets-page";
import { BUDGETS_PATH, HEALTH_PATH, isAppPath, isHomePath, PRICE_TABLE_PATH, PROVIDERS_PATH } from "./paths";
import { userFromAccess } from "./users";

// Variables and secrets the provider plug-ins read (T10 sets them, except
// APP_ORIGIN, which is in wrangler.jsonc "vars"; see
// src/providers/README.md): APP_ORIGIN, ISSUER_KEYS (secret), AWS_APP_ROLE_ARN, AWS_REGION, BEDROCK_TEMPLATE_URL, ENTRA_CLIENT_ID,
// ENTRA_CERT_KEY (secret), ENTRA_CERT_THUMBPRINT, FOUNDRY_CREDENTIAL,
// GOOGLE_WIF_PROVIDER.
export interface Env extends ProvidersEnv {
  // Cloudflare Access team domain, `<team>.cloudflareaccess.com` (as the
  // portfolio-app tool writes it) or `https://<team>.cloudflareaccess.com`.
  ACCESS_TEAM_DOMAIN?: string;
  // The Access application's AUD tag.
  ACCESS_AUD?: string;
  DB: D1Database;
  // The maintainers' Cloud Billing API key, a Worker secret (arrives with T10).
  GOOGLE_BILLING_API_KEY?: string;
}

// The Cron Triggers in wrangler.jsonc. Only handlers may be exported from this
// module: workerd refuses any other named export of the entry point.
const WEEKLY_READING_CRON = "0 7 * * 1";
// Every minute: the provider checks whose next try is due (T16).
const PROVIDER_CHECKS_CRON = "* * * * *";

function maintainerEntries(): MaintainerEntry[] {
  const problems = checkMaintainerEntries(maintainerFile.entries);
  if (problems.length) throw new Error(`prices/maintainer-read.json is invalid: ${problems.join("; ")}`);
  return maintainerFile.entries as MaintainerEntry[];
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The route `<domain>/chief-of-staff*` also matches sibling paths such as
    // `/chief-of-staff.html`; they are the origin's, passed on untouched (a
    // Worker's subrequest to its own zone goes to the origin, not back here).
    if (!isAppPath(url.pathname)) return fetch(request);
    // The issuer's two public documents are the only paths served without
    // the owner's sign-in: AWS, Google and Microsoft fetch them (T16).
    if (request.method === "GET" && PUBLIC_ISSUER_PATHS.includes(url.pathname)) {
      return (await handleIssuerRequest(url.pathname, env))!;
    }
    const claims = await readAccessIdentity(request, env);
    if (!claims) return accessDenied();
    if (url.pathname === HEALTH_PATH && request.method === "GET") {
      return json({ status: "ok" });
    }
    // The app's home. The only screens so far are Models › Setup, so it
    // opens the first of them until the dashboard has a home screen.
    if (isHomePath(url.pathname) && request.method === "GET") {
      return Response.redirect(`${url.origin}${PROVIDERS_PATH}`, 302);
    }
    // The signed-in user's own budgets; a token naming no person is refused.
    if (url.pathname === BUDGETS_PATH && (request.method === "GET" || request.method === "POST")) {
      const now = new Date();
      const user = await userFromAccess(env.DB, claims, now);
      if (!user) return accessDenied();
      return handleBudgets(request, env.DB, providerPlugins(env), user.id, now);
    }
    // Models › Setup › Providers, for the signed-in user. Access lets only
    // the owner in until invitations bring friends (T45), so every viewer
    // is the owner for now.
    if (isProvidersPath(url.pathname)) {
      const now = new Date();
      const user = await userFromAccess(env.DB, claims, now);
      if (!user) return accessDenied();
      return handleProviders(request, { db: env.DB, plugins: providerPlugins(env), userId: user.id, viewer: "owner", appOrigin: readAppOrigin(env), now });
    }
    // Models › Setup › Add a model, for the signed-in user (T17); every
    // viewer is the owner until invitations bring friends (T45).
    if (isAddModelPath(url.pathname)) {
      const now = new Date();
      const user = await userFromAccess(env.DB, claims, now);
      if (!user) return accessDenied();
      return handleAddModel(request, { db: env.DB, plugins: providerPlugins(env), userId: user.id, viewer: "owner", now });
    }
    // Models › Setup › Model for each task, for the signed-in user (T18);
    // every viewer is the owner until invitations bring friends (T45).
    if (isTaskModelsPath(url.pathname)) {
      const now = new Date();
      const user = await userFromAccess(env.DB, claims, now);
      if (!user) return accessDenied();
      return handleTaskModels(request, { db: env.DB, plugins: providerPlugins(env), userId: user.id, viewer: "owner", now });
    }
    // Owner only: behind the Cloudflare Access check above (T15).
    if (url.pathname === PRICE_TABLE_PATH && request.method === "GET") {
      const snapshot = await currentSnapshot(env.DB);
      const html = renderPriceTablePage({
        snapshot,
        rows: snapshot ? await readSnapshotRows(env.DB, snapshot.id) : [],
        alerts: await recentAlerts(env.DB),
        maintainerEntries: maintainerEntries(),
        sort: parseSort(url.searchParams),
        today: new Date().toISOString().slice(0, 10),
      });
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return json({ error: "not found" }, 404);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date(controller.scheduledTime);
    if (controller.cron === PROVIDER_CHECKS_CRON) {
      await runDueChecks(env.DB, providerPlugins(env), now);
      return;
    }
    if (controller.cron === WEEKLY_READING_CRON) {
      // Every listing is read again each week; overdue ones are named first.
      const entries = maintainerEntries();
      const overdue = entriesDueForReading(entries, now.toISOString().slice(0, 10));
      const detail =
        (overdue.length ? `overdue: ${overdue.map((e) => `${e.model} (read ${e.date_read})`).join(", ")}. ` : "") +
        `Read each listing again and update shell/prices/maintainer-read.json: ` +
        entries.map((e) => `${e.model} ${e.listing}`).join("; ");
      console.warn(`maintainer reading due: ${detail}`);
      await addAlert(env.DB, now, "maintainer_reading_due", detail);
      return;
    }
    const { results } = await refreshPrices({
      db: env.DB,
      fetcher: fetch,
      googleApiKey: env.GOOGLE_BILLING_API_KEY,
      maintainerEntries: maintainerEntries(),
      now,
    });
    console.log(`price refresh: ${JSON.stringify(results)}`);
  },
} satisfies ExportedHandler<Env>;
