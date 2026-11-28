// The `Run` object (design-v3 2.4): one per run, named by its user and run
// (runObjectName). It owns the run's record: whose run it is, its type, its
// state, the agent image tag it started on and the prompt version label that
// image carries (design-v3 2.4, 2.5), and the run's memory, its ADK session
// (sessions.ts), all in its own SQLite storage, which it upgrades itself
// when it wakes (storage.ts).
//
// The image tag is fixed at `begin` and never changes, so a parked run
// resumes on the tag it started on (T22). The prompt version label is
// recorded at `begin` when the caller knows it, or once afterwards with
// `recordPromptVersion` when the container reports it; a different label for
// the same run is refused. The container side (T21 part B) decides where
// both come from; this object records what it is given.
//
// States: running -> parked -> running -> ... -> finished. Each change is a
// row in `run_moves` with its time. What a parked run waits on is the
// `waiting` key of its session state (design-v3 2.5), written by the agent.

import { DurableObject } from "cloudflare:workers";
import { handleSessionRequest } from "./sessions";
import { appliedSteps, upgradeStorage, wakeStorage, type AppliedStep, type StorageStep, type StorageUpgrade } from "./storage";

export type RunState = "running" | "parked" | "finished";

export interface RunStart {
  userId: string;
  runId: string;
  // The run type (design-v3 2.5), e.g. role_search.
  type: string;
  imageTag: string;
  promptVersion?: string;
}

export interface RunRecord {
  runId: string;
  userId: string;
  type: string;
  state: RunState;
  imageTag: string;
  promptVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunMove {
  at: string;
  from: RunState | null;
  to: RunState;
}

// User ids are the users table's UUIDs (and the storage check's own ids,
// storage-check.ts); run ids are UUIDs. Neither holds a "/", so a name is
// read back one way only.
const ID = /^[A-Za-z0-9-]{1,80}$/;

export const runObjectName = (userId: string, runId: string): string => {
  if (!ID.test(userId) || !ID.test(runId)) throw new Error("a run's user id and run id are letters, digits and dashes");
  return `${userId}/${runId}`;
};

// Append only, never edit (storage.ts). Step 1's tables follow ADK 2.15's
// SqliteSessionService for the session and its events.
export const RUN_STEPS: readonly StorageStep[] = [
  {
    name: "run record and ADK session",
    apply(sql) {
      sql.exec(`CREATE TABLE run (
        only INTEGER PRIMARY KEY CHECK (only = 1),
        run_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running', 'parked', 'finished')),
        image_tag TEXT NOT NULL,
        prompt_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      sql.exec(`CREATE TABLE sessions (
        app_name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        state TEXT NOT NULL,
        create_time REAL NOT NULL,
        update_time REAL NOT NULL,
        PRIMARY KEY (app_name, user_id, id)
      )`);
      sql.exec(`CREATE TABLE events (
        seq INTEGER PRIMARY KEY,
        app_name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        timestamp REAL NOT NULL,
        event TEXT NOT NULL,
        UNIQUE (app_name, user_id, session_id, id)
      )`);
    },
  },
  {
    name: "run moves",
    apply(sql) {
      sql.exec(`CREATE TABLE run_moves (
        seq INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL
      )`);
    },
  },
];

const MOVES: Record<RunState, readonly RunState[]> = { running: ["parked", "finished"], parked: ["running"], finished: [] };

type RunRow = {
  run_id: string;
  user_id: string;
  type: string;
  state: RunState;
  image_tag: string;
  prompt_version: string | null;
  created_at: string;
  updated_at: string;
};

const toRecord = (r: RunRow): RunRecord => ({
  runId: r.run_id,
  userId: r.user_id,
  type: r.type,
  state: r.state,
  imageTag: r.image_tag,
  promptVersion: r.prompt_version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// The storage check's own users (storage-check.ts). A users-table id is a
// bare UUID, so it never starts with this.
export const STORAGE_CHECK_USER_PREFIX = "storage-check-";
export const isStorageCheckUser = (userId: string): boolean => userId.startsWith(STORAGE_CHECK_USER_PREFIX) && ID.test(userId);

// What the storage check seeds: a parked run whose storage holds every
// step but the last, written with step 1's tables only (storage-check.ts).
export interface StorageCheckSeed {
  userId: string;
  runId: string;
  at: string;
}

export class Run extends DurableObject<unknown> {
  private readonly woke: Promise<StorageUpgrade>;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.woke = wakeStorage(ctx, "Run", RUN_STEPS);
  }

  // What this instance's wake applied: the steps its storage held when it
  // woke, and after.
  wakeUpgrade(): Promise<StorageUpgrade> {
    return this.woke;
  }

  private row(): RunRow | undefined {
    return this.ctx.storage.sql.exec<RunRow>("SELECT * FROM run").toArray()[0];
  }

  private held(): RunRow {
    const row = this.row();
    if (!row) throw new Error("this Run object holds no run yet");
    return row;
  }

  record(): RunRecord | null {
    const row = this.row();
    return row ? toRecord(row) : null;
  }

  moves(): RunMove[] {
    return this.ctx.storage.sql
      .exec<{ at: string; from_state: RunState | null; to_state: RunState }>("SELECT at, from_state, to_state FROM run_moves ORDER BY seq")
      .toArray()
      .map((m) => ({ at: m.at, from: m.from_state, to: m.to_state }));
  }

  storageSteps(): AppliedStep[] {
    return appliedSteps(this.ctx.storage.sql);
  }

  // Records the run, running. The same start again returns the record as it
  // is; any other run is refused, since one object holds one run.
  begin(start: RunStart, at: Date = new Date()): RunRecord {
    const name = runObjectName(start.userId, start.runId);
    const named = this.ctx.id.name;
    if (named !== undefined && named !== name) throw new Error(`this Run object is named for ${named}`);
    if (!start.type || !start.imageTag) throw new Error("a run starts with a type and an image tag");
    if (start.promptVersion === "") throw new Error("a prompt version label is not empty");
    const existing = this.row();
    if (existing) {
      if (existing.user_id !== start.userId || existing.run_id !== start.runId || existing.type !== start.type || existing.image_tag !== start.imageTag) {
        throw new Error(`this Run object holds run ${existing.run_id} of user ${existing.user_id}, type ${existing.type}, image ${existing.image_tag}`);
      }
      if (start.promptVersion !== undefined) return this.recordPromptVersion(start.promptVersion, at);
      return toRecord(existing);
    }
    const when = at.toISOString();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO run (only, run_id, user_id, type, state, image_tag, prompt_version, created_at, updated_at) VALUES (1, ?, ?, ?, 'running', ?, ?, ?, ?)",
        start.runId,
        start.userId,
        start.type,
        start.imageTag,
        start.promptVersion ?? null,
        when,
        when,
      );
      this.ctx.storage.sql.exec("INSERT INTO run_moves (at, from_state, to_state) VALUES (?, NULL, 'running')", when);
    });
    return toRecord(this.held());
  }

  recordPromptVersion(label: string, at: Date = new Date()): RunRecord {
    if (!label) throw new Error("a prompt version label is not empty");
    const row = this.held();
    if (row.prompt_version === label) return toRecord(row);
    if (row.prompt_version !== null) throw new Error(`run ${row.run_id} already records prompt version ${row.prompt_version}`);
    this.ctx.storage.sql.exec("UPDATE run SET prompt_version = ?, updated_at = ?", label, at.toISOString());
    return toRecord(this.held());
  }

  private move(to: RunState, at: Date): RunRecord {
    const row = this.held();
    if (!MOVES[row.state].includes(to)) throw new Error(`run ${row.run_id} is ${row.state} and cannot become ${to}`);
    const when = at.toISOString();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE run SET state = ?, updated_at = ?", to, when);
      this.ctx.storage.sql.exec("INSERT INTO run_moves (at, from_state, to_state) VALUES (?, ?, ?)", when, row.state, to);
    });
    return toRecord(this.held());
  }

  park(at: Date = new Date()): RunRecord {
    return this.move("parked", at);
  }

  resume(at: Date = new Date()): RunRecord {
    return this.move("running", at);
  }

  finish(at: Date = new Date()): RunRecord {
    return this.move("finished", at);
  }

  // The `sessions.cos` API for this run's container (sessions.ts).
  sessions(request: Request): Promise<Response> {
    return handleSessionRequest(this.ctx.storage, this.held().user_id, request);
  }

  // The storage check only (storage-check.ts): empties this object and
  // writes a parked run at the step before the last, so the next wake
  // upgrades it. Refused unless the object, by its name and by the run it
  // holds, is the check's own, so it can never empty a real run.
  seedStorageCheck(seed: StorageCheckSeed): AppliedStep[] {
    const existing = this.row();
    const named = this.ctx.id.name;
    if (
      !isStorageCheckUser(seed.userId) ||
      (named !== undefined && named !== runObjectName(seed.userId, seed.runId)) ||
      (existing && (existing.user_id !== seed.userId || existing.run_id !== seed.runId))
    ) {
      throw new Error("only the storage check's own runs are seeded");
    }
    if (RUN_STEPS.length < 2) throw new Error("the storage check needs at least two Run storage steps");
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      for (const { name } of sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray()) {
        sql.exec(`DROP TABLE "${name}"`);
      }
    });
    upgradeStorage(this.ctx.storage, RUN_STEPS.slice(0, -1), () => new Date(seed.at));
    const sql = this.ctx.storage.sql;
    const seconds = new Date(seed.at).getTime() / 1000;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        "INSERT INTO run (only, run_id, user_id, type, state, image_tag, prompt_version, created_at, updated_at) VALUES (1, ?, ?, 'storage_check', 'parked', 'storage-check', 'storage-check', ?, ?)",
        seed.runId,
        seed.userId,
        seed.at,
        seed.at,
      );
      const state = { waiting: { kind: "ask_owner", question: "Continue the storage check?" } };
      sql.exec("INSERT INTO sessions (app_name, user_id, id, state, create_time, update_time) VALUES ('storage_check', ?, ?, ?, ?, ?)", seed.userId, seed.runId, JSON.stringify(state), seconds, seconds);
      const event = { id: "before-park", invocationId: "storage-check", author: "storage_check", timestamp: seconds, content: { role: "model", parts: [{ text: "Asked the owner; parking." }] }, actions: { stateDelta: state } };
      sql.exec(
        "INSERT INTO events (app_name, user_id, session_id, id, invocation_id, timestamp, event) VALUES ('storage_check', ?, ?, 'before-park', 'storage-check', ?, ?)",
        seed.userId,
        seed.runId,
        seconds,
        JSON.stringify(event),
      );
    });
    return appliedSteps(sql);
  }

  // The storage check only: ends this instance, so the next request wakes a
  // new one, which upgrades the storage in its constructor.
  evict(): void {
    this.ctx.abort("storage check: wake this object again");
  }
}
