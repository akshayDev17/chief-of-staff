// The run's memory: its ADK session, kept in its own `Run` object's SQLite
// storage (design-v3 2.4, 8.4) and served to the run's container as
// `sessions.cos`, the session service the container's ADK runner uses.
//
// The contract follows ADK 2.15's own BaseSessionService, and its
// SqliteSessionService for what it stores: sessions keyed by app, user and
// id; events in append order; a session's state changed only by an event's
// `actions.stateDelta`; `temp:` keys never stored; an append refused as stale
// when the session changed after the caller read it. Two differences, both
// because a `Run` object serves one run of one user:
// - Only session-scoped state. `app:` and `user:` keys would be shared with
//   other runs in ADK, and nothing here is shared, so they are refused rather
//   than quietly kept in this run alone. The run's state keys (design-v3
//   2.5: run, answers, waiting, effects) are session-scoped.
// - Every request names the run's own user; any other user is refused.
//
// HTTP, JSON bodies, ADK's own camelCase field names (`Event.model_dump(
// mode="json", by_alias=True, exclude_none=True)` on the Python side):
//   POST   /apps/<app>/users/<user>/sessions                 {state?, sessionId?} -> 200 session | 409 exists
//   GET    /apps/<app>/users/<user>/sessions                 -> 200 {sessions: [session without events]}
//   GET    /apps/<app>/users/<user>/sessions/<id>[?numRecentEvents=<n>&afterTimestamp=<s>] -> 200 session | 404
//   DELETE /apps/<app>/users/<user>/sessions/<id>            -> 204
//   POST   /apps/<app>/users/<user>/sessions/<id>/events     {event, lastUpdateTime} -> 200 {lastUpdateTime, stored} | 404 | 409 stale
// A session is {appName, userId, id, state, lastUpdateTime, events}; times
// are seconds since the epoch, as ADK keeps them. An event appended twice
// (a retried request) is stored once and answered as stored. A partial event
// is not stored, as in ADK. Every refusal is {error: <reason>} with a 4xx.
//
// The tables are made by the `Run` object's first storage step (run.ts).

export interface Session {
  appName: string;
  userId: string;
  id: string;
  state: Record<string, unknown>;
  lastUpdateTime: number;
  events: unknown[];
}

// SQLite's limit on one row's value in a Durable Object.
const MAX_EVENT_BYTES = 2_000_000;

const TEMP_PREFIX = "temp:";
const SHARED_PREFIXES = ["app:", "user:"];

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Session-scoped keys only: temp: keys are dropped, shared keys refused.
function sessionScoped(state: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith(TEMP_PREFIX)) continue;
    if (SHARED_PREFIXES.some((p) => key.startsWith(p))) throw new Refusal(400, `state key "${key}" is shared across runs in ADK; a run keeps only its own session state`);
    kept[key] = value;
  }
  return kept;
}

const readState = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

interface SessionKey {
  appName: string;
  userId: string;
  sessionId: string;
}

function sessionRow(sql: SqlStorage, key: SessionKey) {
  return sql
    .exec<{ state: string; update_time: number }>("SELECT state, update_time FROM sessions WHERE app_name = ? AND user_id = ? AND id = ?", key.appName, key.userId, key.sessionId)
    .toArray()[0];
}

export function createSession(sql: SqlStorage, input: { appName: string; userId: string; sessionId?: string; state?: Record<string, unknown> }, nowSeconds: number): Session {
  const id = input.sessionId ?? crypto.randomUUID();
  const state = sessionScoped(input.state ?? {});
  if (sessionRow(sql, { appName: input.appName, userId: input.userId, sessionId: id })) throw new Refusal(409, `session ${id} already exists`);
  sql.exec(
    "INSERT INTO sessions (app_name, user_id, id, state, create_time, update_time) VALUES (?, ?, ?, ?, ?, ?)",
    input.appName,
    input.userId,
    id,
    JSON.stringify(state),
    nowSeconds,
    nowSeconds,
  );
  return { appName: input.appName, userId: input.userId, id, state, lastUpdateTime: nowSeconds, events: [] };
}

export function getSession(sql: SqlStorage, key: SessionKey, options: { numRecentEvents?: number; afterTimestamp?: number } = {}): Session | undefined {
  const row = sessionRow(sql, key);
  if (!row) return undefined;
  const where = ["app_name = ?", "user_id = ?", "session_id = ?"];
  const params: SqlStorageValue[] = [key.appName, key.userId, key.sessionId];
  if (options.afterTimestamp !== undefined) {
    where.push("timestamp >= ?");
    params.push(options.afterTimestamp);
  }
  // Newest first so a limit keeps the most recent, then back to append order.
  const limit = options.numRecentEvents !== undefined ? ` LIMIT ${options.numRecentEvents}` : "";
  const events =
    options.numRecentEvents === 0
      ? []
      : sql
          .exec<{ event: string }>(`SELECT event FROM events WHERE ${where.join(" AND ")} ORDER BY timestamp DESC, seq DESC${limit}`, ...params)
          .toArray()
          .reverse()
          .map((r) => JSON.parse(r.event) as unknown);
  return { appName: key.appName, userId: key.userId, id: key.sessionId, state: readState(row.state), lastUpdateTime: row.update_time, events };
}

// Oldest update first, so the last is the most recently active, as in ADK.
export function listSessions(sql: SqlStorage, appName: string, userId: string): Session[] {
  return sql
    .exec<{ id: string; state: string; update_time: number }>("SELECT id, state, update_time FROM sessions WHERE app_name = ? AND user_id = ? ORDER BY update_time, id", appName, userId)
    .toArray()
    .map((r) => ({ appName, userId, id: r.id, state: readState(r.state), lastUpdateTime: r.update_time, events: [] }));
}

export function deleteSession(sql: SqlStorage, key: SessionKey): void {
  sql.exec("DELETE FROM events WHERE app_name = ? AND user_id = ? AND session_id = ?", key.appName, key.userId, key.sessionId);
  sql.exec("DELETE FROM sessions WHERE app_name = ? AND user_id = ? AND id = ?", key.appName, key.userId, key.sessionId);
}

// The event's own fields the store reads; the rest is kept as sent.
function readEvent(event: unknown): { id: string; invocationId: string; timestamp: number; partial: boolean; delta: Record<string, unknown> | undefined } {
  if (!isObject(event)) throw new Refusal(400, "event must be an object");
  const { id, invocationId, timestamp, partial, actions } = event;
  if (typeof id !== "string" || !id) throw new Refusal(400, "event.id must be a non-empty string");
  if (typeof invocationId !== "string") throw new Refusal(400, "event.invocationId must be a string");
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) throw new Refusal(400, "event.timestamp must be a number of seconds");
  if (actions !== undefined && !isObject(actions)) throw new Refusal(400, "event.actions must be an object");
  const delta = actions?.stateDelta;
  if (delta !== undefined && delta !== null && !isObject(delta)) throw new Refusal(400, "event.actions.stateDelta must be an object");
  return { id, invocationId, timestamp, partial: partial === true, delta: delta ?? undefined };
}

// Appends one event: applies its session-scoped state delta, stores it with
// its temp: keys dropped, and moves the session's update time to the
// event's, all in one transaction. `lastUpdateTime` is the session's update
// time as the caller last read it.
export function appendEvent(
  storage: DurableObjectStorage,
  key: SessionKey,
  event: unknown,
  lastUpdateTime: number,
): { lastUpdateTime: number; stored: boolean } {
  const sql = storage.sql;
  const read = readEvent(event);
  const row = sessionRow(sql, key);
  if (!row) throw new Refusal(404, `session ${key.sessionId} not found`);
  if (read.partial) return { lastUpdateTime: row.update_time, stored: false };
  const delta = read.delta ? sessionScoped(read.delta) : {};
  const kept = isObject(event) && read.delta ? { ...event, actions: { ...(event.actions as Record<string, unknown>), stateDelta: delta } } : event;
  const text = JSON.stringify(kept);
  if (text.length > MAX_EVENT_BYTES) throw new Refusal(413, `event is ${text.length} bytes; at most ${MAX_EVENT_BYTES} are kept`);
  const existing = sql
    .exec<{ event: string }>("SELECT event FROM events WHERE app_name = ? AND user_id = ? AND session_id = ? AND id = ?", key.appName, key.userId, key.sessionId, read.id)
    .toArray()[0];
  if (existing) {
    // A retried append: the same event again is answered as stored.
    if (existing.event === text) return { lastUpdateTime: row.update_time, stored: true };
    throw new Refusal(409, `event ${read.id} is already stored with other contents`);
  }
  if (row.update_time > lastUpdateTime) throw new Refusal(409, "stale session: it changed after it was read");
  storage.transactionSync(() => {
    if (Object.keys(delta).length > 0) {
      sql.exec("UPDATE sessions SET state = ? WHERE app_name = ? AND user_id = ? AND id = ?", JSON.stringify({ ...readState(row.state), ...delta }), key.appName, key.userId, key.sessionId);
    }
    sql.exec(
      "INSERT INTO events (app_name, user_id, session_id, id, invocation_id, timestamp, event) VALUES (?, ?, ?, ?, ?, ?, ?)",
      key.appName,
      key.userId,
      key.sessionId,
      read.id,
      read.invocationId,
      read.timestamp,
      text,
    );
    sql.exec("UPDATE sessions SET update_time = ? WHERE app_name = ? AND user_id = ? AND id = ?", read.timestamp, key.appName, key.userId, key.sessionId);
  });
  return { lastUpdateTime: read.timestamp, stored: true };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const readBody = async (request: Request): Promise<Record<string, unknown>> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new Refusal(400, "the body must be JSON");
  }
  if (!isObject(body)) throw new Refusal(400, "the body must be a JSON object");
  return body;
};

const readCount = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Refusal(400, "numRecentEvents must be a whole number, 0 or more");
  return n;
};

const readSeconds = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Refusal(400, "afterTimestamp must be a number of seconds");
  return n;
};

const PATH = /^\/apps\/([^/]+)\/users\/([^/]+)\/sessions(?:\/([^/]+)(\/events)?)?$/;

// The `sessions.cos` API for one run: `runUserId` is the run's own user.
export async function handleSessionRequest(storage: DurableObjectStorage, runUserId: string, request: Request, now: () => Date = () => new Date()): Promise<Response> {
  try {
    const url = new URL(request.url);
    const match = PATH.exec(url.pathname);
    if (!match) throw new Refusal(404, "no such session path");
    const [appName, userId, sessionId] = [match[1]!, match[2]!, match[3]].map((s) => (s === undefined ? undefined : decodeURIComponent(s)));
    if (userId !== runUserId) throw new Refusal(403, "this run answers only for its own user");
    const app = appName!;
    const user = userId!;
    const nowSeconds = now().getTime() / 1000;
    if (!sessionId) {
      if (request.method === "GET") return json({ sessions: listSessions(storage.sql, app, user) });
      if (request.method === "POST") {
        const body = await readBody(request);
        if (body.sessionId !== undefined && (typeof body.sessionId !== "string" || !body.sessionId)) throw new Refusal(400, "sessionId must be a non-empty string");
        if (body.state !== undefined && !isObject(body.state)) throw new Refusal(400, "state must be an object");
        return json(
          createSession(
            storage.sql,
            { appName: app, userId: user, ...(body.sessionId ? { sessionId: body.sessionId as string } : {}), ...(body.state ? { state: body.state as Record<string, unknown> } : {}) },
            nowSeconds,
          ),
        );
      }
      throw new Refusal(405, "use GET or POST");
    }
    const key = { appName: app, userId: user, sessionId };
    if (match[4]) {
      if (request.method !== "POST") throw new Refusal(405, "use POST");
      const body = await readBody(request);
      if (typeof body.lastUpdateTime !== "number" || !Number.isFinite(body.lastUpdateTime)) throw new Refusal(400, "lastUpdateTime must be a number of seconds");
      return json(appendEvent(storage, key, body.event, body.lastUpdateTime));
    }
    if (request.method === "GET") {
      const numRecentEvents = readCount(url.searchParams.get("numRecentEvents"));
      const afterTimestamp = readSeconds(url.searchParams.get("afterTimestamp"));
      const session = getSession(storage.sql, key, { ...(numRecentEvents !== undefined ? { numRecentEvents } : {}), ...(afterTimestamp !== undefined ? { afterTimestamp } : {}) });
      return session ? json(session) : json({ error: `session ${sessionId} not found` }, 404);
    }
    if (request.method === "DELETE") {
      deleteSession(storage.sql, key);
      return new Response(null, { status: 204 });
    }
    throw new Refusal(405, "use GET or DELETE");
  } catch (error) {
    if (error instanceof Refusal) return json({ error: error.message }, error.status);
    throw error;
  }
}
