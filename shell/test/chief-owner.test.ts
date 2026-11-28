// The Chief object, one per user (src/objects/chief.ts), and the one Owner
// object (src/objects/owner.ts): their own storage, and Chief starting runs.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CHIEF_STEPS, runStub } from "../src/objects/chief";
import { OWNER_OBJECT_NAME } from "../src/objects/owner";
import { VERSION_TABLE } from "../src/objects/storage";
import { at, refusal } from "./objects-fixture";

const newUser = () => crypto.randomUUID();

describe("a Chief object", () => {
  it("is at the code's last step from its first wake", async () => {
    const chief = env.CHIEF.getByName(newUser());
    expect((await chief.storageSteps()).map((s) => s.name)).toEqual(CHIEF_STEPS.map((s) => s.name));
  });

  it("starts a run: names it, lists it, and records it in its own Run object", async () => {
    const userId = newUser();
    const chief = env.CHIEF.getByName(userId);
    const record = await chief.startRun({ userId, type: "proof", imageTag: "agent-v0.1.0-7", promptVersion: "prompts-3" }, at(0));
    expect(record).toMatchObject({ userId, type: "proof", state: "running", imageTag: "agent-v0.1.0-7", promptVersion: "prompts-3", createdAt: at(0).toISOString() });
    expect(await runStub(env, userId, record.runId).record()).toEqual(record);
    const second = await chief.startRun({ userId, type: "proof", imageTag: "agent-v0.1.1-8" }, at(1));
    expect(second.runId).not.toBe(record.runId);
    expect(await chief.runs(userId)).toEqual([
      { runId: second.runId, type: "proof", imageTag: "agent-v0.1.1-8", startedAt: at(1).toISOString() },
      { runId: record.runId, type: "proof", imageTag: "agent-v0.1.0-7", startedAt: at(0).toISOString() },
    ]);
  });

  it("serves one user only, the one it is named for", async () => {
    const userId = newUser();
    const chief = env.CHIEF.getByName(userId);
    expect(await refusal(chief.startRun({ userId: newUser(), type: "proof", imageTag: "agent-v0.1.0-7" }))).toBe(`this Chief serves user ${userId}`);
    expect(await chief.runs(userId)).toEqual([]);
    await chief.startRun({ userId, type: "proof", imageTag: "agent-v0.1.0-7" });
    expect(await refusal(chief.startRun({ userId: newUser(), type: "proof", imageTag: "agent-v0.1.0-7" }))).toBe(`this Chief serves user ${userId}`);
    expect(await refusal(chief.runs(newUser()))).toBe(`this Chief serves user ${userId}`);
    expect(await chief.runs(userId)).toHaveLength(1);
  });

  it("lists no run whose Run object refused it", async () => {
    const userId = newUser();
    const chief = env.CHIEF.getByName(userId);
    expect(await refusal(chief.startRun({ userId, type: "proof", imageTag: "" }))).toBe("a run starts with a type and an image tag");
    expect(await chief.runs(userId)).toEqual([]);
  });
});

describe("the Owner object", () => {
  it("wakes with its own version table and no storage steps yet", async () => {
    const owner = env.OWNER.getByName(OWNER_OBJECT_NAME);
    expect(await owner.storageSteps()).toEqual([]);
    await runInDurableObject(owner, (_, state) => {
      const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray();
      expect(tables.map((t) => t.name)).toEqual([VERSION_TABLE]);
    });
  });
});
