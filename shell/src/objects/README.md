# The Durable Objects (T21, design-v3 2.4, 8.4, 11.2)

Three classes, each object with its own SQLite storage, declared in
`wrangler.jsonc`'s `exports` map and reached through the bindings `CHIEF`,
`RUN` and `OWNER`:

| Class | One per | Named | Holds |
| --- | --- | --- | --- |
| `Chief` (`chief.ts`) | user | the user's id | the user it serves, and the user's runs; later the user's caps, switches, schedule and waiting list (T22, T23) |
| `Run` (`run.ts`) | run | `<user id>/<run id>` (`runObjectName`) | the run's record and its ADK session |
| `Owner` (`owner.ts`) | app | `owner` | nothing yet: the base-tier meter (T23) and the user cap's count (T53) arrive as its first storage steps |

A Chief serves one user and a Run object one run of one user: a call naming
another user or run is refused.

## Declaring a class

A class is added, renamed or deleted only in `wrangler.jsonc`'s `exports`
map, never with the older `migrations` array (a Worker uses one or the
other, and once `exports` is deployed it cannot go back). Each such change
is reviewed on its own, because none can be undone:

- Cloudflare provisions a class's namespace at the first deploy that
  declares it, and a Worker rollback cannot cross that deploy ("Rollbacks
  cannot cross a lifecycle change", Cloudflare's Durable Object class
  exports page, updated 2026-09-28). The release that first declares these
  three classes is the earliest version later releases can roll back to.
- `deleted` removes the class's every object and its storage permanently,
  with no Trash, so it is never released without the owner's word.
- A class's storage type (`sqlite`) is fixed once its namespace exists.

Changing a class's code, including how it uses its storage, needs no change
to `exports`.

## Each object upgrades its own storage

`PRAGMA user_version` is not available in a Durable Object's SQLite, so each
class lists its storage steps in its own file (`CHIEF_STEPS`, `RUN_STEPS`,
`OWNER_STEPS`) and each object records the steps it has applied in its own
`_sql_schema_migrations` table. Its constructor applies the steps its
storage lacks before any request reaches it (`storage.ts`): forward only, in
order, each step and its row in one transaction. The rules for a step:

- **Append, never edit.** Once released, a step is never edited, reordered,
  renamed or removed; a change is a new step at the end. An object whose
  stored steps do not match the code's by number and name refuses to wake.
- **Expand only**, as for D1 (README "Releasing the shell"): add tables,
  columns and rows. The previous Worker, a rollback target, then meets
  storage newer than its code; it applies nothing and still works, because
  it reads nothing a newer step changed. Removing something is a later step,
  once no Worker version that may still run reads it.
- **Small.** The whole upgrade has the 30-second limit of
  `blockConcurrencyWhile`; a long reshaping is a data migration instead
  (`src/data-migrations.ts`).
- **A Run object's session stays readable by its image tag.** A parked run
  resumes on the image tag it started on (T22), so a step that changes the
  session's form keeps the old form readable, and a session-format or ADK
  change ships only in a new image tag (design-v3 2.6, 8.4).

A step that throws rolls back whole, the object is reset, and its next
request tries again. Each object also has Cloudflare's own 30-day
point-in-time restore, one object at a time.

The steps today:

| Class | Step | What it adds |
| --- | --- | --- |
| `Chief` | 1 `chief's user and runs` | `chief` (the user it serves), `runs` (run id, type, image tag, started) |
| `Run` | 1 `run record and ADK session` | `run` (the record), `sessions` and `events` (ADK 2.15's SqliteSessionService layout) |
| `Run` | 2 `run moves` | `run_moves` (each change of the run's state, with its time) |
| `Owner` | none | |

## The run's record, and the seam with the agent image

The agent image, its pipeline and the Worker-to-container seam are T21's
part B; this side records what that side passes it:

- `Chief.startRun({ userId, type, imageTag, promptVersion? })` names a new
  run, lists it in the user's Chief, records it in its `Run` object with
  `Run.begin`, and returns the run's record. Starting its container is the
  caller's next step.
- The **image tag** is fixed at `begin`: the same start again returns the
  record as it is, and another tag, user, type or run is refused. A parked
  run resumes on the tag its record holds.
- The **prompt version label** is recorded at `begin` when the caller knows
  it, or once afterwards with `Run.recordPromptVersion(label)` when the
  container reports it; another label for the same run is refused.
- **States**: `Run.park()`, `Run.resume()` and `Run.finish()` move the run
  `running` -> `parked` -> `running` -> ... -> `finished`, each move a row
  in `run_moves`. What a parked run waits on is the `waiting` key of its
  session state (design-v3 2.5), written by the agent; the waits themselves
  are T22's.
- **`sessions.cos`**, the run's memory: `Run.sessions(request)` answers the
  container's session-service requests, ADK's BaseSessionService over HTTP,
  for that run's user only. The routes, bodies and refusals are in
  `sessions.ts`'s header. Every Worker release keeps answering each route an
  image tag still in use calls (ADR-017): a changed route is a new route
  beside the old one, which goes only once no parked run's image calls it.

## The run storage check (M3 step 10)

Admin · Run storage check, at `/chief-of-staff/admin/checks/run-storage`
(`storage-check.ts`), runs M3 step 10 on the deployed Worker without
touching any real user. **Seed** makes a made-up test user
(`storage-check-<uuid>`, never a users-table id) and run, has that run's
object write a parked run with its storage one step behind the code, and
ends the object's instance. The page it opens wakes a new instance, which
applies the last step in its constructor, and shows what that wake applied
(from step and to step, `Run.wakeUpgrade`), the object's
`_sql_schema_migrations` rows, the run's record and moves, and its session. **Answer the run** resumes it, appends
the answer to its session and finishes it. It writes nothing to D1 and
accepts no id but its own test runs'. Each seed leaves one test object of a
few rows behind; nothing deletes it.

## What it costs

Durable Objects are part of Workers Paid: 1 million requests and 400,000
GB-seconds a month included, then $0.15 a million and $12.50 a million
GB-seconds; SQLite storage 5 GB included (design-v3 12.1). An object is
billed only while it is awake, and these hold a few rows each, so they cost
$0 within the included amounts.
