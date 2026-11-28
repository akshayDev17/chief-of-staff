// Admin · Run storage check: M3 step 10 on the deployed Worker (T21). A run
// object whose storage is one step behind its code wakes, upgrades its own
// storage, and its parked run goes on and finishes.
//
// Seed makes a new test user id (storage-check-<uuid>, never a users-table
// id, which is a bare UUID) and a run id, and has that run's `Run` object
// write a parked run with storage at the step before the last
// (Run.seedStorageCheck), then ends the instance (Run.evict). Opening the
// check wakes a new instance, whose constructor applies the last step; the
// page shows the object's version table, the run's record and moves, and
// its session. Answer resumes the run, appends the answer to its session and
// finishes it. Nothing is written to D1, and no object but the check's own
// is touched: every id the page accepts must be a check id.
//
// Owner only: behind the Cloudflare Access check (src/access.ts) that every
// request passes first.

import { STORAGE_CHECK_PATH } from "../paths";
import { CONTROLS_CSS, esc, PAGE_CSS } from "../prices/page";
import { isStorageCheckUser, RUN_STEPS, runObjectName, type Run, type RunMove, type RunRecord } from "./run";
import type { Session } from "./sessions";
import type { AppliedStep, StorageUpgrade } from "./storage";

const APP = "storage_check";
const RUN_ID = /^[0-9a-f-]{36}$/;

export interface StorageCheckReport {
  userId: string;
  runId: string;
  codeSteps: number;
  // What the object's current instance applied when it woke.
  wake: StorageUpgrade;
  storage: AppliedStep[];
  run: RunRecord | null;
  moves: RunMove[];
  session: Session | null;
}

const sessionUrl = (userId: string, runId: string, events = false) =>
  `http://sessions.cos/apps/${APP}/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(runId)}${events ? "/events" : ""}`;

const stubFor = (env: { RUN: DurableObjectNamespace<Run> }, userId: string, runId: string) => env.RUN.getByName(runObjectName(userId, runId));

// Reading it wakes the object, so its storage is upgraded first.
export async function readStorageCheck(env: { RUN: DurableObjectNamespace<Run> }, userId: string, runId: string): Promise<StorageCheckReport> {
  const stub = stubFor(env, userId, runId);
  const wake = await stub.wakeUpgrade();
  const storage = await stub.storageSteps();
  const run = await stub.record();
  const moves = run ? await stub.moves() : [];
  const reply = run ? await stub.sessions(new Request(sessionUrl(userId, runId))) : undefined;
  const session = reply?.ok ? ((await reply.json()) as Session) : null;
  return { userId, runId, codeSteps: RUN_STEPS.length, wake, storage, run, moves, session };
}

export async function seedStorageCheck(env: { RUN: DurableObjectNamespace<Run> }, now: Date): Promise<{ userId: string; runId: string }> {
  const userId = `storage-check-${crypto.randomUUID()}`;
  const runId = crypto.randomUUID();
  const stub = stubFor(env, userId, runId);
  await stub.seedStorageCheck({ userId, runId, at: now.toISOString() });
  // Ending the instance fails the call that ends it; the next request wakes
  // a new instance either way.
  await stub.evict().catch(() => undefined);
  return { userId, runId };
}

export async function answerStorageCheck(env: { RUN: DurableObjectNamespace<Run> }, userId: string, runId: string, answer: string, now: Date): Promise<void> {
  const stub = stubFor(env, userId, runId);
  await stub.resume(now);
  const read = await stub.sessions(new Request(sessionUrl(userId, runId)));
  if (!read.ok) throw new Error(`the check run's session did not open: ${read.status}`);
  const session = (await read.json()) as Session;
  const seconds = now.getTime() / 1000;
  const event = {
    id: `answer-${crypto.randomUUID()}`,
    invocationId: "storage-check-answer",
    author: "user",
    timestamp: seconds,
    content: { role: "user", parts: [{ text: answer }] },
    actions: { stateDelta: { waiting: null, answer } },
  };
  const appended = await stub.sessions(
    new Request(sessionUrl(userId, runId, true), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event, lastUpdateTime: session.lastUpdateTime }) }),
  );
  if (!appended.ok) throw new Error(`the answer was not appended: ${appended.status} ${await appended.text()}`);
  await stub.finish(now);
}

const page = (body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin · Run storage check · Chief of staff</title>
<style>${PAGE_CSS}${CONTROLS_CSS}
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: .8rem/1.4 ui-monospace, Menlo, monospace; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
form { margin: 12px 0; }
</style>
</head>
<body>
<main class="screen">
<h1>Admin</h1>
<h2>Run storage check</h2>
${body}
</main>
</body>
</html>`;

const html = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const SEED_FORM = `<form method="post"><input type="hidden" name="action" value="seed"><button type="submit" class="btn">Seed a parked test run, one storage step behind</button></form>`;

function renderReport(report: StorageCheckReport): string {
  const { wake, codeSteps } = report;
  const current = report.storage.length === codeSteps;
  const storage =
    wake.to > wake.from
      ? `This object woke with its storage at step ${wake.from} and upgraded it itself to step ${wake.to} of the ${codeSteps} this Worker knows.`
      : `This object's storage is at step ${report.storage.length} of the ${codeSteps} this Worker knows; it had nothing to upgrade when it woke.`;
  const status = !report.run
    ? `<div class="banner warn" role="status">No run in this object.</div>`
    : `<div class="banner${current ? " ok" : " warn"}" role="status">${storage} The run is ${esc(report.run.state)}.</div>`;
  const answer =
    report.run?.state === "parked"
      ? `<form method="post"><input type="hidden" name="action" value="answer"><input type="hidden" name="user" value="${esc(report.userId)}"><input type="hidden" name="run" value="${esc(report.runId)}"><button type="submit" class="btn">Answer the run</button></form>`
      : "";
  return `${status}${answer}<pre>${esc(JSON.stringify(report, null, 2))}</pre>${SEED_FORM}`;
}

const readIds = (params: URLSearchParams | FormData): { userId: string; runId: string } | undefined => {
  const userId = params.get("user");
  const runId = params.get("run");
  if (typeof userId !== "string" || typeof runId !== "string" || !isStorageCheckUser(userId) || !RUN_ID.test(runId)) return undefined;
  return { userId, runId };
};

export async function handleStorageCheck(request: Request, env: { RUN: DurableObjectNamespace<Run> }, now: () => Date = () => new Date()): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    if (!url.searchParams.has("user")) {
      return html(
        page(
          `<p>Seeds a parked run for a made-up test user in its own Run object, with that object's storage one step behind this Worker's code, then ends the object's instance. Opening the run wakes a new instance, which upgrades its own storage; Answer resumes the run and finishes it. Nothing is written for any real user.</p>${SEED_FORM}`,
        ),
      );
    }
    const ids = readIds(url.searchParams);
    if (!ids) return html(page(`<div class="banner warn" role="alert">Not a storage check run.</div>${SEED_FORM}`), 400);
    return html(page(renderReport(await readStorageCheck(env, ids.userId, ids.runId))));
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return new Response(null, { status: 403 });
  const form = await request.formData();
  const action = form.get("action");
  let ids: { userId: string; runId: string } | undefined;
  if (action === "seed") ids = await seedStorageCheck(env, now());
  else if (action === "answer") {
    ids = readIds(form);
    if (!ids) return html(page(`<div class="banner warn" role="alert">Not a storage check run.</div>${SEED_FORM}`), 400);
    try {
      await answerStorageCheck(env, ids.userId, ids.runId, "Yes, go on.", now());
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return html(page(`<div class="banner warn" role="alert">The answer was not taken: ${esc(why)}</div>${renderReport(await readStorageCheck(env, ids.userId, ids.runId))}`), 409);
    }
  } else return new Response(null, { status: 400 });
  const location = `${url.origin}${STORAGE_CHECK_PATH}?user=${encodeURIComponent(ids.userId)}&run=${encodeURIComponent(ids.runId)}`;
  return new Response(null, { status: 303, headers: { location } });
}
