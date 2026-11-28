// Admin · Run storage check (src/objects/storage-check.ts): M3 step 10 as the
// deployed Worker runs it, through the Worker with Access, on a made-up test
// user's own Run object.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { RUN_STEPS, runObjectName, STORAGE_CHECK_USER_PREFIX } from "../src/objects/run";
import { answerStorageCheck, readStorageCheck } from "../src/objects/storage-check";
import { ENV, generateKey, serveCerts, signToken, type TestKey } from "./access-fixture";
import { dumpEveryTable } from "./test-plugin";

const BASE = "https://shell.test/chief-of-staff/admin/checks/run-storage";
let key: TestKey;

beforeAll(async () => {
  key = await generateKey("kid-storage-check");
});
afterEach(() => vi.restoreAllMocks());

const send = async (url: string, init: RequestInit = {}, token = true): Promise<Response> => {
  serveCerts(() => [key]);
  const headers = new Headers(init.headers);
  if (token) headers.set("cf-access-jwt-assertion", await signToken(key));
  return worker.fetch(new Request(url, { ...init, headers, redirect: "manual" }), { ...env, ...ENV });
};
const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  send(BASE, { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });

const idsOf = (location: string) => {
  const params = new URL(location).searchParams;
  return { userId: params.get("user")!, runId: params.get("run")! };
};

describe("the run storage check", () => {
  it("seeds a parked test run one step behind, which upgrades itself on wake and finishes when answered", async () => {
    const before = await dumpEveryTable();
    const seeded = await post({ action: "seed" }, { origin: "https://shell.test" });
    expect(seeded.status).toBe(303);
    const location = seeded.headers.get("location")!;
    const { userId, runId } = idsOf(location);
    expect(userId.startsWith(STORAGE_CHECK_USER_PREFIX)).toBe(true);

    const last = RUN_STEPS.length;
    const opened = await (await send(location)).text();
    expect(opened).toContain(`This object woke with its storage at step ${last - 1} and upgraded it itself to step ${last} of the ${last} this Worker knows. The run is parked.`);
    expect(opened).toContain("Answer the run");

    const answered = await post({ action: "answer", user: userId, run: runId });
    expect(answered.status).toBe(303);
    const report = await readStorageCheck(env, userId, runId);
    expect(report.storage.map((s) => s.step)).toEqual(RUN_STEPS.map((_, i) => i + 1));
    expect(report.run).toMatchObject({ userId, runId, state: "finished" });
    expect(report.moves.map((m) => [m.from, m.to])).toEqual([
      ["parked", "running"],
      ["running", "finished"],
    ]);
    expect(report.session!.events.map((e) => (e as { author: string }).author)).toEqual(["storage_check", "user"]);
    expect(report.session!.state).toMatchObject({ waiting: null, answer: "Yes, go on." });
    expect(report.wake).toEqual({ from: last - 1, to: last });
    const finished = await (await send(location)).text();
    expect(finished).not.toContain("Answer the run");
    expect(finished).toContain("The run is finished.");
    // Nothing for any real user, in D1 or anywhere else.
    expect(await dumpEveryTable()).toEqual(before);
  });

  it("refuses an answer to a run that is not parked, saying why", async () => {
    const { userId, runId } = idsOf((await post({ action: "seed" })).headers.get("location")!);
    await post({ action: "answer", user: userId, run: runId });
    const again = await post({ action: "answer", user: userId, run: runId });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("the check run is finished; only a parked run takes an answer");
    expect((await readStorageCheck(env, userId, runId)).session!.events).toHaveLength(2);
  });

  it("leaves the run parked and answerable when its answer is not taken", async () => {
    const { userId, runId } = idsOf((await post({ action: "seed" })).headers.get("location")!);
    const refused = await answerStorageCheck(env, userId, runId, "€".repeat(700_000), new Date()).then(
      () => "taken",
      (error: Error) => error.message,
    );
    expect(refused).toContain("the answer was not appended: 413");
    const parked = await readStorageCheck(env, userId, runId);
    expect(parked.run).toMatchObject({ state: "parked" });
    expect(parked.moves).toEqual([]);
    expect(parked.session!.events).toHaveLength(1);
    expect((await post({ action: "answer", user: userId, run: runId })).status).toBe(303);
    expect((await readStorageCheck(env, userId, runId)).run).toMatchObject({ state: "finished" });
  });

  it("accepts only its own test runs' ids", async () => {
    const realUser = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await env.RUN.getByName(runObjectName(realUser, runId)).begin({ userId: realUser, runId, type: "proof", imageTag: "agent-v0.1.0-7" });
    expect((await send(`${BASE}?user=${realUser}&run=${runId}`)).status).toBe(400);
    expect((await post({ action: "answer", user: realUser, run: runId })).status).toBe(400);
    expect((await post({ action: "answer", user: `${STORAGE_CHECK_USER_PREFIX}x`, run: "not-a-run" })).status).toBe(400);
    expect(await env.RUN.getByName(runObjectName(realUser, runId)).record()).toMatchObject({ state: "running" });
  });

  it("refuses a post from another site, any other action, and a request without the owner's sign-in", async () => {
    expect((await post({ action: "seed" }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await post({ action: "delete" })).status).toBe(400);
    expect((await send(BASE, {}, false)).status).toBe(403);
    expect((await send(BASE, { method: "PUT" })).status).toBe(405);
  });

  it("opens on a page that says what it does", async () => {
    const html = await (await send(BASE)).text();
    expect(html).toContain("<title>Admin · Run storage check · Chief of staff</title>");
    expect(html).toContain("Seed a parked test run, one storage step behind");
  });
});
