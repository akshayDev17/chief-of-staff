import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("returns a JSON OK", async () => {
    const response = await SELF.fetch("https://shell.test/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("answers 404 for an unknown path", async () => {
    const response = await SELF.fetch("https://shell.test/nope");
    expect(response.status).toBe(404);
  });
});
