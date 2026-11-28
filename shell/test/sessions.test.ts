// The run's ADK session in its Run object, served as `sessions.cos`
// (src/objects/sessions.ts), through the Run object's own `sessions` call.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runObjectName } from "../src/objects/run";
import type { Session } from "../src/objects/sessions";

const USER = "6f1c2a7e-0d4b-4f6e-9a51-3b2c1d0e9f87";
const APP = "chief_of_staff";

const newRun = async () => {
  const runId = crypto.randomUUID();
  const stub = env.RUN.getByName(runObjectName(USER, runId));
  await stub.begin({ userId: USER, runId, type: "proof", imageTag: "agent-v0.1.0-7" });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await stub.sessions(
      new Request(`http://sessions.cos${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }),
    );
    return { status: response.status, body: response.status === 204 ? undefined : await response.json<Record<string, unknown>>() };
  };
  return { runId, stub, call };
};

const base = (user = USER) => `/apps/${APP}/users/${user}/sessions`;

const event = (id: string, timestamp: number, extra: Record<string, unknown> = {}) => ({ id, invocationId: "inv-1", author: "agent", timestamp, ...extra });

describe("sessions.cos", () => {
  it("creates a session with its state and returns it with no events", async () => {
    const { call } = await newRun();
    const created = await call("POST", base(), { sessionId: "s1", state: { run: { type: "proof" } } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ appName: APP, userId: USER, id: "s1", state: { run: { type: "proof" } }, events: [] });
    expect(typeof created.body!.lastUpdateTime).toBe("number");
    expect((await call("POST", base(), { sessionId: "s1" })).status).toBe(409);
  });

  it("names a session itself when none is given", async () => {
    const { call } = await newRun();
    const created = await call("POST", base(), {});
    expect(created.body!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("appends events in order, applies their state delta and drops temp: keys", async () => {
    const { call } = await newRun();
    const created = await call("POST", base(), { sessionId: "s1" });
    let last = created.body!.lastUpdateTime as number;
    const first = await call("POST", `${base()}/s1/events`, {
      event: event("e1", last + 1, { actions: { stateDelta: { answers: { name: "Morgan Sample" }, "temp:page": "<html>" } } }),
      lastUpdateTime: last,
    });
    expect(first).toEqual({ status: 200, body: { lastUpdateTime: last + 1, stored: true } });
    last = last + 1;
    await call("POST", `${base()}/s1/events`, { event: event("e2", last + 1, { actions: { stateDelta: { waiting: { kind: "ask_owner" } } } }), lastUpdateTime: last });
    const session = (await call("GET", `${base()}/s1`)).body as unknown as Session;
    expect(session.state).toEqual({ answers: { name: "Morgan Sample" }, waiting: { kind: "ask_owner" } });
    expect(session.events.map((e) => (e as { id: string }).id)).toEqual(["e1", "e2"]);
    expect((session.events[0] as { actions: { stateDelta: object } }).actions.stateDelta).toEqual({ answers: { name: "Morgan Sample" } });
    expect(session.lastUpdateTime).toBe(last + 1);
  });

  it("refuses an append to a session that changed after it was read, as ADK does", async () => {
    const { call } = await newRun();
    const t = (await call("POST", base(), { sessionId: "s1" })).body!.lastUpdateTime as number;
    await call("POST", `${base()}/s1/events`, { event: event("e1", t + 1), lastUpdateTime: t });
    const stale = await call("POST", `${base()}/s1/events`, { event: event("e2", t + 2), lastUpdateTime: t });
    expect(stale.status).toBe(409);
    expect(stale.body!.error).toContain("stale session");
  });

  it("stores a retried append once and answers it as stored", async () => {
    const { call } = await newRun();
    const t = (await call("POST", base(), { sessionId: "s1" })).body!.lastUpdateTime as number;
    const append = { event: event("e1", t + 1, { actions: { stateDelta: { effects: ["sent-1"] } } }), lastUpdateTime: t };
    expect((await call("POST", `${base()}/s1/events`, append)).status).toBe(200);
    expect(await call("POST", `${base()}/s1/events`, append)).toEqual({ status: 200, body: { lastUpdateTime: t + 1, stored: true } });
    expect(((await call("GET", `${base()}/s1`)).body!.events as unknown[]).length).toBe(1);
    const changed = await call("POST", `${base()}/s1/events`, { event: event("e1", t + 1, { author: "someone else" }), lastUpdateTime: t + 1 });
    expect(changed.status).toBe(409);
  });

  it("does not store a partial event", async () => {
    const { call } = await newRun();
    const t = (await call("POST", base(), { sessionId: "s1" })).body!.lastUpdateTime as number;
    expect(await call("POST", `${base()}/s1/events`, { event: event("p1", t + 1, { partial: true }), lastUpdateTime: t })).toEqual({ status: 200, body: { lastUpdateTime: t, stored: false } });
    expect((await call("GET", `${base()}/s1`)).body!.events).toEqual([]);
  });

  it("refuses app: and user: state, which ADK would share with other runs", async () => {
    const { call } = await newRun();
    expect((await call("POST", base(), { sessionId: "s1", state: { "user:name": "x" } })).status).toBe(400);
    const t = (await call("POST", base(), { sessionId: "s2" })).body!.lastUpdateTime as number;
    const refused = await call("POST", `${base()}/s2/events`, { event: event("e1", t + 1, { actions: { stateDelta: { "app:flag": true } } }), lastUpdateTime: t });
    expect(refused.status).toBe(400);
    expect(refused.body!.error).toContain('"app:flag"');
    expect((await call("GET", `${base()}/s2`)).body!.events).toEqual([]);
  });

  it("refuses an event or a session state too large for its row, counting UTF-8 bytes", async () => {
    const { call } = await newRun();
    // 700,000 characters, 2,100,000 bytes: three bytes each in UTF-8.
    const wide = "€".repeat(700_000);
    const created = await call("POST", base(), { sessionId: "s0", state: { answers: wide } });
    expect(created.status).toBe(413);
    expect(created.body!.error).toContain("session state is");
    expect((await call("GET", `${base()}/s0`)).status).toBe(404);

    const t = (await call("POST", base(), { sessionId: "s1", state: { answers: "a".repeat(1_000_000) } })).body!.lastUpdateTime as number;
    const big = await call("POST", `${base()}/s1/events`, { event: event("e1", t + 1, { content: { parts: [{ text: wide }] } }), lastUpdateTime: t });
    expect(big.status).toBe(413);
    expect(big.body!.error).toContain("event is");
    const grown = await call("POST", `${base()}/s1/events`, { event: event("e2", t + 1, { actions: { stateDelta: { effects: "b".repeat(1_000_000) } } }), lastUpdateTime: t });
    expect(grown.status).toBe(413);
    expect(grown.body!.error).toContain("session state is");
    const session = (await call("GET", `${base()}/s1`)).body as unknown as Session;
    expect(session.events).toEqual([]);
    expect(Object.keys(session.state)).toEqual(["answers"]);
    expect(session.lastUpdateTime).toBe(t);
  });

  it("answers only for the run's own user", async () => {
    const { call } = await newRun();
    await call("POST", base(), { sessionId: "s1" });
    for (const [method, path] of [
      ["GET", `${base("another-user")}/s1`],
      ["GET", base("another-user")],
      ["POST", base("another-user")],
      ["DELETE", `${base("another-user")}/s1`],
    ] as const) {
      expect((await call(method, path, method === "POST" ? {} : undefined)).status).toBe(403);
    }
  });

  it("gets the most recent events, or those from a time on", async () => {
    const { call } = await newRun();
    let t = (await call("POST", base(), { sessionId: "s1" })).body!.lastUpdateTime as number;
    for (const id of ["e1", "e2", "e3"]) {
      await call("POST", `${base()}/s1/events`, { event: event(id, t + 1), lastUpdateTime: t });
      t += 1;
    }
    const ids = async (query: string) => ((await call("GET", `${base()}/s1${query}`)).body!.events as Array<{ id: string }>).map((e) => e.id);
    expect(await ids("?numRecentEvents=2")).toEqual(["e2", "e3"]);
    expect(await ids("?numRecentEvents=0")).toEqual([]);
    expect(await ids(`?afterTimestamp=${t}`)).toEqual(["e3"]);
    expect((await call("GET", `${base()}/s1?numRecentEvents=-1`)).status).toBe(400);
  });

  it("lists sessions oldest update first, and deletes one with its events", async () => {
    const { call } = await newRun();
    const a = (await call("POST", base(), { sessionId: "a" })).body!.lastUpdateTime as number;
    await call("POST", base(), { sessionId: "b" });
    await call("POST", `${base()}/a/events`, { event: event("e1", a + 100), lastUpdateTime: a });
    expect(((await call("GET", base())).body!.sessions as Session[]).map((s) => s.id)).toEqual(["b", "a"]);
    expect((await call("DELETE", `${base()}/a`)).status).toBe(204);
    expect((await call("GET", `${base()}/a`)).status).toBe(404);
    expect(((await call("GET", base())).body!.sessions as Session[]).map((s) => s.id)).toEqual(["b"]);
  });

  it("refuses malformed requests with a reason", async () => {
    const { call, stub } = await newRun();
    const t = (await call("POST", base(), { sessionId: "s1" })).body!.lastUpdateTime as number;
    expect((await call("POST", `${base()}/s1/events`, { event: { id: "e1" }, lastUpdateTime: t })).status).toBe(400);
    expect((await call("POST", `${base()}/s1/events`, { event: event("e1", t + 1) })).status).toBe(400);
    expect((await call("POST", `${base()}/nope/events`, { event: event("e1", t + 1), lastUpdateTime: t })).status).toBe(404);
    expect((await call("GET", "/elsewhere")).status).toBe(404);
    expect((await call("PUT", `${base()}/s1`)).status).toBe(405);
    const notJson = await stub.sessions(new Request(`http://sessions.cos${base()}`, { method: "POST", body: "{" }));
    expect(notJson.status).toBe(400);
  });
});
