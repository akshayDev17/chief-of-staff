import { parseSort, renderPriceTablePage } from "./prices/page";
import { readHostsWaiting, readWaitingHosts } from "./prices/host-reads";
import { refreshPrices } from "./prices/refresh";
import { readStrength } from "./prices/strength";
import { currentSnapshot, readSnapshotRows, readStoredCatalog, recentAlerts } from "./prices/store";
import { accessDenied, readAccessIdentity } from "./access";
import { readAppOrigin } from "./app-config";
import { readProviderPlugins, type ProvidersEnv } from "./providers/index";
import { vaultSecrets } from "./providers/secrets";
import { handleProviders, isProvidersPath } from "./providers/page";
import { handleTaskModels, isTaskModelsPath } from "./models/picker-page";
import { handleBudgets } from "./proxy/budgets-page";
import { handleUsage, isUsagePath } from "./models/usage-page";
import { ADD_MODEL_PATH, BUDGETS_PATH, HEALTH_PATH, isAppPath, isHomePath, PRICE_TABLE_PATH, PROVIDERS_PATH } from "./paths";
import { userFromAccess } from "./users";

// Variables and secrets the Worker reads besides Access's: APP_ORIGIN (in
// wrangler.jsonc "vars") and VAULT_KEY (secret: the vault key, which seals
// the key OpenRouter issues each user; src/providers/secrets.ts). See
// src/providers/README.md.
export interface Env extends ProvidersEnv {
  // Cloudflare Access team domain, `<team>.cloudflareaccess.com` (as the
  // portfolio-app tool writes it) or `https://<team>.cloudflareaccess.com`.
  ACCESS_TEAM_DOMAIN?: string;
  // The Access application's AUD tag.
  ACCESS_AUD?: string;
  DB: D1Database;
}

// The Cron Triggers in wrangler.jsonc: 06:00 UTC daily, and every minute.
export const DAILY_CRON = "0 6 * * *";
export const HOST_READ_CRON = "* * * * *";

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
    // No path under the prefix is served without the owner's sign-in.
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
      return handleBudgets(request, env.DB, user.id, now, { secrets: vaultSecrets(env.DB, env), plugins: await readProviderPlugins(env, env.DB) });
    }
    // Models › Setup › Providers, for the signed-in user. Access lets only
    // the owner in until invitations bring friends (T45), so every viewer
    // is the owner for now.
    if (isProvidersPath(url.pathname)) {
      const now = new Date();
      const user = await userFromAccess(env.DB, claims, now);
      if (!user) return accessDenied();
      return handleProviders(request, {
        db: env.DB,
        plugins: await readProviderPlugins(env, env.DB),
        readPlugins: () => readProviderPlugins(env, env.DB),
        secrets: vaultSecrets(env.DB, env),
        userId: user.id,
        viewer: "owner",
        appOrigin: readAppOrigin(env),
        now,
      });
    }
    // The old Models › Setup › Add a model page: models are chosen on each
    // provider's Connect screen now, so it leads there.
    if (url.pathname === ADD_MODEL_PATH && request.method === "GET") {
      const provider = url.searchParams.get("provider");
      return Response.redirect(`${url.origin}${PROVIDERS_PATH}${provider && /^[a-z]+$/.test(provider) ? `?provider=${provider}` : ""}`, 303);
    }
    // Models › Setup › Model for each task, for the signed-in user (T18);
    // every viewer is the owner until invitations bring friends (T45).
    if (isTaskModelsPath(url.pathname)) {
      const now = new Date();
      const user = await userFromAccess(env.DB, claims, now);
      if (!user) return accessDenied();
      return handleTaskModels(request, { db: env.DB, plugins: await readProviderPlugins(env, env.DB), userId: user.id, viewer: "owner", now });
    }
    // Models › Usage, for the signed-in user: the month's OpenRouter spend
    // against the budget, per model and per task, from the ledger.
    if (isUsagePath(url.pathname) && request.method === "GET") {
      const now = new Date();
      const user = await userFromAccess(env.DB, claims, now);
      if (!user) return accessDenied();
      return handleUsage({ db: env.DB, userId: user.id, now, secrets: vaultSecrets(env.DB, env), plugins: await readProviderPlugins(env, env.DB) });
    }
    // Owner only: behind the Cloudflare Access check above (T15).
    if (url.pathname === PRICE_TABLE_PATH && request.method === "GET") {
      const snapshot = await currentSnapshot(env.DB);
      const rows = snapshot ? await readSnapshotRows(env.DB, snapshot.id) : [];
      const catalog = snapshot ? await readStoredCatalog(env.DB, snapshot.id) : undefined;
      const html = renderPriceTablePage({
        snapshot,
        rows,
        alerts: await recentAlerts(env.DB),
        sort: parseSort(url.searchParams),
        strength: await readStrength(env.DB, snapshot, { rows, ...(catalog ? { catalog } : {}) }),
        hosts: await readHostsWaiting(env.DB, snapshot),
      });
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return json({ error: "not found" }, 404);
  },

  // Two Cron Triggers (wrangler.jsonc): the daily refresh, and every minute
  // the background read of any hosts the current snapshot's figures still
  // wait for (src/prices/host-reads.ts), which does nothing when none wait.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date(controller.scheduledTime);
    if (controller.cron === HOST_READ_CRON) {
      const snapshotId = await readWaitingHosts({ db: env.DB, fetcher: fetch, now });
      if (snapshotId !== undefined) console.log(`host read: snapshot ${snapshotId} stored ${Date.now() - now.getTime()} ms after its minute`);
      return;
    }
    const { results } = await refreshPrices({ db: env.DB, fetcher: fetch, now, daily: true });
    console.log(`price refresh: ${JSON.stringify(results)}`);
  },
} satisfies ExportedHandler<Env>;
