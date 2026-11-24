import { checkAccess } from "./access";

export interface Env {
  // Cloudflare Access team domain, `https://<team>.cloudflareaccess.com`.
  ACCESS_TEAM_DOMAIN?: string;
  // The Access application's AUD tag.
  ACCESS_AUD?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const refused = await checkAccess(request, env);
    if (refused) return refused;
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && request.method === "GET") {
      return json({ status: "ok" });
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
