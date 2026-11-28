// The `Chief` object (design-v3 2.4, 11.2): one per user, named by the
// user's id. It is where that user's runs start: it names each run, keeps the
// user's list of runs, and records the run in its own `Run` object. One
// Chief per user, handling one request at a time, is where the user's caps,
// switches, schedule and waiting list go as their tickets build them (T22,
// T23), each as a storage step of its own (storage.ts).

import { DurableObject } from "cloudflare:workers";
import { runObjectName, type Run, type RunRecord } from "./run";
import { appliedSteps, wakeStorage, type AppliedStep, type StorageStep } from "./storage";

export interface ChiefEnv {
  RUN: DurableObjectNamespace<Run>;
}

export interface RunListing {
  runId: string;
  type: string;
  imageTag: string;
  startedAt: string;
}

// Append only, never edit (storage.ts).
export const CHIEF_STEPS: readonly StorageStep[] = [
  {
    name: "chief's user and runs",
    apply(sql) {
      sql.exec(`CREATE TABLE chief (
        only INTEGER PRIMARY KEY CHECK (only = 1),
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      sql.exec(`CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        image_tag TEXT NOT NULL,
        started_at TEXT NOT NULL
      )`);
    },
  },
];

export const runStub = (env: ChiefEnv, userId: string, runId: string): DurableObjectStub<Run> => env.RUN.getByName(runObjectName(userId, runId));

export class Chief extends DurableObject<ChiefEnv> {
  constructor(ctx: DurableObjectState, env: ChiefEnv) {
    super(ctx, env);
    void wakeStorage(ctx, "Chief", CHIEF_STEPS);
  }

  // This object's user, the one it is named for and recorded at its first
  // run; any other user is refused, since one Chief serves one user.
  // Undefined before the first run.
  private servedUser(userId: string): string | undefined {
    const named = this.ctx.id.name;
    if (named !== undefined && named !== userId) throw new Error(`this Chief serves user ${named}`);
    const served = this.ctx.storage.sql.exec<{ user_id: string }>("SELECT user_id FROM chief").toArray()[0]?.user_id;
    if (served !== undefined && served !== userId) throw new Error(`this Chief serves user ${served}`);
    return served;
  }

  private claim(userId: string, at: Date): void {
    if (this.servedUser(userId) === undefined) this.ctx.storage.sql.exec("INSERT INTO chief (only, user_id, created_at) VALUES (1, ?, ?)", userId, at.toISOString());
  }

  // Starts a run of `type` for the user on `imageTag`: names it, lists it,
  // and records it in its `Run` object. Starting its container is the
  // caller's next step (T21 part B).
  async startRun(input: { userId: string; type: string; imageTag: string; promptVersion?: string }, at: Date = new Date()): Promise<RunRecord> {
    this.claim(input.userId, at);
    const runId = crypto.randomUUID();
    this.ctx.storage.sql.exec("INSERT INTO runs (run_id, type, image_tag, started_at) VALUES (?, ?, ?, ?)", runId, input.type, input.imageTag, at.toISOString());
    try {
      return await runStub(this.env, input.userId, runId).begin(
        { userId: input.userId, runId, type: input.type, imageTag: input.imageTag, ...(input.promptVersion !== undefined ? { promptVersion: input.promptVersion } : {}) },
        at,
      );
    } catch (error) {
      this.ctx.storage.sql.exec("DELETE FROM runs WHERE run_id = ?", runId);
      throw error;
    }
  }

  // The user's runs, newest first.
  runs(userId: string): RunListing[] {
    if (this.servedUser(userId) === undefined) return [];
    return this.ctx.storage.sql
      .exec<{ run_id: string; type: string; image_tag: string; started_at: string }>("SELECT run_id, type, image_tag, started_at FROM runs ORDER BY started_at DESC, run_id")
      .toArray()
      .map((r) => ({ runId: r.run_id, type: r.type, imageTag: r.image_tag, startedAt: r.started_at }));
  }

  storageSteps(): AppliedStep[] {
    return appliedSteps(this.ctx.storage.sql);
  }
}
