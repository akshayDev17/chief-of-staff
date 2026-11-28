// The Run object (src/objects/run.ts): the run's record, its moves, and its
// own storage upgrade when it wakes one step behind its code.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RUN_STEPS, runObjectName, STORAGE_CHECK_USER_PREFIX, type RunStart } from "../src/objects/run";
import { at, refusal } from "./objects-fixture";

const USER = "6f1c2a7e-0d4b-4f6e-9a51-3b2c1d0e9f87";

const freshRun = () => {
  const runId = crypto.randomUUID();
  return { runId, stub: env.RUN.getByName(runObjectName(USER, runId)) };
};

const start = (runId: string, extra: Partial<RunStart> = {}): RunStart => ({ userId: USER, runId, type: "proof", imageTag: "agent-v0.1.0-7", ...extra });

describe("a Run object's storage", () => {
  it("is at the code's last step from its first wake", async () => {
    const { stub } = freshRun();
    expect(await stub.wakeUpgrade()).toEqual({ from: 0, to: RUN_STEPS.length });
    expect((await stub.storageSteps()).map((s) => [s.step, s.name])).toEqual(RUN_STEPS.map((s, i) => [i + 1, s.name]));
  });

  it("upgrades itself when it wakes one step behind, keeping its parked run and session", async () => {
    const userId = `${STORAGE_CHECK_USER_PREFIX}${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    const stub = env.RUN.getByName(runObjectName(userId, runId));
    const seeded = await stub.seedStorageCheck({ userId, runId, at: at(0).toISOString() });
    expect(seeded.map((s) => s.step)).toEqual([1]);
    expect(await refusal(stub.evict())).toContain("storage check: wake this object again");

    // A new instance: its constructor applies the last step before this call.
    const woken = env.RUN.getByName(runObjectName(userId, runId));
    expect(await woken.wakeUpgrade()).toEqual({ from: RUN_STEPS.length - 1, to: RUN_STEPS.length });
    const steps = await woken.storageSteps();
    expect(steps.map((s) => s.name)).toEqual(RUN_STEPS.map((s) => s.name));
    expect(steps[0]!.appliedAt).toBe(at(0).toISOString());
    expect(new Date(steps[1]!.appliedAt).getTime()).toBeGreaterThan(at(0).getTime());
    expect(await woken.record()).toMatchObject({ runId, userId, state: "parked", imageTag: "storage-check", promptVersion: "storage-check" });
    const session = await (await woken.sessions(new Request(`http://sessions.cos/apps/storage_check/users/${userId}/sessions/${runId}`))).json<{
      events: Array<{ id: string }>;
      state: Record<string, unknown>;
    }>();
    expect(session.events.map((e) => e.id)).toEqual(["before-park"]);
    expect(session.state).toHaveProperty("waiting");

    // The run goes on, on the upgraded storage.
    await woken.resume(at(5));
    expect((await woken.finish(at(6))).state).toBe("finished");
    expect(await woken.moves()).toEqual([
      { at: at(5).toISOString(), from: "parked", to: "running" },
      { at: at(6).toISOString(), from: "running", to: "finished" },
    ]);
  });

  it("is seeded only for the storage check's own users and runs", async () => {
    const { runId, stub } = freshRun();
    expect(await refusal(stub.seedStorageCheck({ userId: USER, runId, at: at(0).toISOString() }))).toBe("only the storage check's own runs are seeded");
    await stub.begin(start(runId));
    // A check id sent to a real run's object, which is named for the real run.
    expect(await refusal(stub.seedStorageCheck({ userId: `${STORAGE_CHECK_USER_PREFIX}x`, runId, at: at(0).toISOString() }))).toBe(
      "only the storage check's own runs are seeded",
    );
    expect(await stub.record()).toMatchObject({ userId: USER, state: "running" });
  });

  it("knows its own name", async () => {
    const { runId, stub } = freshRun();
    await runInDurableObject(stub, (_, state) => {
      expect(state.id.name).toBe(runObjectName(USER, runId));
    });
  });
});

describe("a Run object's record", () => {
  it("records the run at begin with its image tag and prompt version, running", async () => {
    const { runId, stub } = freshRun();
    expect(await stub.record()).toBeNull();
    const record = await stub.begin(start(runId, { promptVersion: "prompts-3" }), at(0));
    expect(record).toEqual({
      runId,
      userId: USER,
      type: "proof",
      state: "running",
      imageTag: "agent-v0.1.0-7",
      promptVersion: "prompts-3",
      createdAt: at(0).toISOString(),
      updatedAt: at(0).toISOString(),
    });
    expect(await stub.moves()).toEqual([{ at: at(0).toISOString(), from: null, to: "running" }]);
  });

  it("answers the same begin again with the record as it is", async () => {
    const { runId, stub } = freshRun();
    const first = await stub.begin(start(runId), at(0));
    expect(await stub.begin(start(runId), at(9))).toEqual(first);
    expect(await stub.moves()).toHaveLength(1);
  });

  it("refuses another run, another user or another image tag in the same object", async () => {
    const { runId, stub } = freshRun();
    // Before anything is recorded too: the object is named for its run.
    expect(await refusal(stub.begin(start(runId, { userId: "another-user" })))).toBe(`this Run object is named for ${runObjectName(USER, runId)}`);
    await stub.begin(start(runId));
    expect(await refusal(stub.begin(start(runId, { userId: "another-user" })))).toBe(`this Run object is named for ${runObjectName(USER, runId)}`);
    expect(await refusal(stub.begin(start(crypto.randomUUID())))).toContain("this Run object is named for");
    expect(await refusal(stub.begin(start(runId, { type: "role_search" })))).toContain(`this Run object holds run ${runId} of user ${USER}, type proof`);
    expect(await refusal(stub.begin(start(runId, { imageTag: "agent-v0.2.0-8" })))).toContain("image agent-v0.1.0-7");
    expect((await stub.record())!.imageTag).toBe("agent-v0.1.0-7");
  });

  it("records the prompt version once, when the container reports it after begin", async () => {
    const { runId, stub } = freshRun();
    expect((await stub.begin(start(runId))).promptVersion).toBeNull();
    expect((await stub.recordPromptVersion("prompts-3", at(1))).promptVersion).toBe("prompts-3");
    expect((await stub.recordPromptVersion("prompts-3", at(2))).updatedAt).toBe(at(1).toISOString());
    expect(await refusal(stub.recordPromptVersion("prompts-4"))).toContain("already records prompt version prompts-3");
    expect(await refusal(stub.begin(start(runId, { promptVersion: "prompts-4" })))).toContain("already records prompt version prompts-3");
  });

  it("moves running, parked, running, finished, and refuses any other move", async () => {
    const { runId, stub } = freshRun();
    expect(await refusal(stub.park())).toBe("this Run object holds no run yet");
    await stub.begin(start(runId), at(0));
    expect(await refusal(stub.resume())).toContain("is running and cannot become running");
    await stub.park(at(1));
    expect(await refusal(stub.finish())).toContain("is parked and cannot become finished");
    await stub.resume(at(2));
    await stub.finish(at(3));
    expect(await refusal(stub.resume())).toContain("is finished and cannot become running");
    expect((await stub.moves()).map((m) => m.to)).toEqual(["running", "parked", "running", "finished"]);
    expect((await stub.record())!.imageTag).toBe("agent-v0.1.0-7");
  });

  it("refuses ids that would make an ambiguous name", async () => {
    expect(() => runObjectName("a/b", "c")).toThrow("letters, digits and dashes");
    const { runId, stub } = freshRun();
    expect(await refusal(stub.begin(start(runId, { userId: "a/b" })))).toContain("letters, digits and dashes");
  });
});
