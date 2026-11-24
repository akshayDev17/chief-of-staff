const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && request.method === "GET") {
      return json({ status: "ok" });
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler;
