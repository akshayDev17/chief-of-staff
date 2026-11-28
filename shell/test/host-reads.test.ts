// The hosts a price snapshot's figures wait for, and the background read of
// them (src/prices/host-reads.ts): Refresh model list never reads hundreds of
// endpoints lists inside the user's request; the every-minute run reads a
// fixed batch, and nothing at all when none wait; nothing depends on someone
// pressing Refresh or on the next daily refresh.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { DAILY_CRON, HOST_READ_CRON } from "../src/index";
import wranglerConfig from "../wrangler.jsonc?raw";
import { HOST_READ_LEASE_MS, HOST_READS_PER_RUN, readHostsWaiting, readWaitingHosts } from "../src/prices/host-reads";
import { HOST_READS_NOW, refreshPrices } from "../src/prices/refresh";
import { currentSnapshot, readFigures, readHostReads, readLatestLines } from "../src/prices/store";
import { fakeFetch, MODELS, type Sent } from "./fake-sources";

// The fixture's list and `extra` more paid tool-use models.
const LUNA = MODELS.data.find((m) => m.id === "openai/gpt-6-luna")!;
const listOf = (extra: number) => ({
  data: [...MODELS.data, ...Array.from({ length: extra }, (_, i) => ({ ...LUNA, id: `test/extra-${String(i).padStart(3, "0")}`, name: `Test: Extra ${i}` }))],
});
// The fixture tiers five paid models.
const FIXTURE_PAID = 5;

const modelOf = (s: Sent): string => decodeURI(new URL(s.url).pathname.replace(/^\/api\/v1\/models\//, "").replace(/\/endpoints$/, ""));
// Every model's two hosts, at $1 / $2 and $3 / $4 a million tokens.
const twoHosts = (s: Sent) =>
  Response.json({
    data: {
      id: modelOf(s),
      endpoints: [1, 3].map((p) => ({ pricing: { prompt: String(p / 1e6), completion: String((p + 1) / 1e6) }, service_tier: null, supported_parameters: ["tools"], status: 0 })),
    },
  });
const sources = (extra = 40, more: Parameters<typeof fakeFetch>[0] = {}) => fakeFetch({ models: () => Response.json(listOf(extra)), endpoints: twoHosts, ...more });
const endpointReads = (f: { sent: Sent[] }) => f.sent.filter((s) => s.url.endsWith("/endpoints")).length;

const AT = new Date("2026-11-28T16:10:00Z");
const minute = (n: number) => new Date(AT.getTime() + n * 60_000);

// Refresh model list, as Providers sends it.
const button = (fetcher: typeof fetch, now = AT) => refreshPrices({ db: env.DB, fetcher, now, hostReadsNow: HOST_READS_NOW, hostRetryPauseMs: 0 });
const daily = (fetcher: typeof fetch, now = AT) => refreshPrices({ db: env.DB, fetcher, now, daily: true, hostRetryPauseMs: 0 });
const run = (fetcher: typeof fetch, now = minute(1), db: D1Database = env.DB) => readWaitingHosts({ db, fetcher, now, hostRetryPauseMs: 0 });
const figures = async () => readFigures(env.DB, (await currentSnapshot(env.DB))!.id);

// The database, with every statement it is sent recorded.
function watched(db: D1Database): { db: D1Database; sent: string[] } {
  const sent: string[] = [];
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => (sent.push(sql.trim()), target.prepare(sql));
      if (prop === "batch" || prop === "exec") return (...args: unknown[]) => (sent.push(`<${String(prop)}>`), (target[prop] as (...a: unknown[]) => unknown)(...args));
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, sent };
}

afterEach(() => vi.restoreAllMocks());

describe("Refresh model list", () => {
  it("never reads the full host read inline: with more than HOST_READS_NOW to read, it reads none and leaves them waiting", async () => {
    const fetcher = sources();
    await button(fetcher);
    expect(endpointReads(fetcher)).toBe(0);
    expect(fetcher.sent).toHaveLength(1);
    expect(await readHostsWaiting(env.DB)).toEqual({ waiting: FIXTURE_PAID + 40, done: 0, started: false });
    // Meanwhile each is at its headline price, and no lines are drawn from those.
    const f = await figures();
    expect(f.filter((x) => !x.free).every((x) => x.basis === "unread")).toBe(true);
    expect(await readLatestLines(env.DB)).toBeUndefined();
  });

  it("reads the few that changed while the user waits, and leaves nothing waiting", async () => {
    await daily(sources());
    // Nothing changed: nothing to read.
    const same = sources();
    await button(same, minute(1));
    expect(endpointReads(same)).toBe(0);
    expect(await readHostsWaiting(env.DB)).toBeUndefined();
    // One new model and one whose headline changed: two lists, read now.
    const list = listOf(40);
    const changed = { data: [...list.data.map((m) => (m.id === "test/extra-000" ? { ...m, pricing: { ...m.pricing, prompt: "0.0000002" } } : m)), { ...LUNA, id: "test/new", name: "Test: New" }] };
    const fetcher = sources(40, { models: () => Response.json(changed) });
    await button(fetcher, minute(60));
    expect(fetcher.sent.filter((s) => s.url.endsWith("/endpoints")).map(modelOf).sort()).toEqual(["test/extra-000", "test/new"]);
    expect(await readHostsWaiting(env.DB)).toBeUndefined();
    expect((await figures()).find((x) => x.model === "test/new")).toMatchObject({ basis: "hosts", hosts: 2 });
  });

  it("keeps the waiting hosts waiting when OpenRouter's list cannot be read", async () => {
    await button(sources());
    await button(sources(40, { models: () => new Response("down", { status: 503 }) }), minute(1));
    expect((await currentSnapshot(env.DB))!.status).toBe("partial");
    expect(await readHostsWaiting(env.DB)).toEqual({ waiting: FIXTURE_PAID + 40, done: 0, started: false });
    // And the next run reads them.
    await run(sources(), minute(2));
    expect(await readHostsWaiting(env.DB)).toBeUndefined();
  });
});

describe("the background read", () => {
  it("reads at most HOST_READS_PER_RUN lists a run, storing their figures beside the same snapshot, until none wait; the last run draws the first lines", async () => {
    const paid = FIXTURE_PAID + 130;
    await button(sources(130));
    const id = (await currentSnapshot(env.DB))!.id;
    const reads: number[] = [];
    for (let m = 1; m <= 3; m++) {
      const fetcher = sources(130);
      const batch = await run(fetcher, minute(m));
      reads.push(endpointReads(fetcher));
      expect(batch).toEqual({ snapshotId: id, tried: reads.at(-1), left: paid - reads.reduce((a, b) => a + b, 0) });
      expect((await currentSnapshot(env.DB))!.id).toBe(id);
      if (m < 3) {
        expect(await readHostsWaiting(env.DB)).toEqual({ waiting: paid, done: m * HOST_READS_PER_RUN, started: true });
        expect(await readLatestLines(env.DB)).toBeUndefined();
      }
    }
    expect(reads).toEqual([HOST_READS_PER_RUN, HOST_READS_PER_RUN, paid - 2 * HOST_READS_PER_RUN]);
    const f = await figures();
    expect(f.filter((x) => !x.free).every((x) => x.basis === "hosts" && x.hosts === 2)).toBe(true);
    expect(f.find((x) => x.model === "test/extra-000")).toMatchObject({ input: { min: 1, max: 3 }, output: { min: 2, max: 4 }, readAt: minute(1).toISOString() });
    expect(await readLatestLines(env.DB)).toMatchObject({ month: "2026-11", models: paid });
    expect(await readHostsWaiting(env.DB)).toBeUndefined();
    expect(await readHostReads(env.DB, id)).toEqual({ waiting: paid, done: paid, queuedAt: AT.toISOString(), finishedAt: minute(3).toISOString() });
    // Then a run finds nothing waiting, and reads nothing.
    const idle = sources(130);
    expect(await run(idle, minute(4))).toBeUndefined();
    expect(idle.sent).toEqual([]);
  });

  it("tries a model whose list cannot be read once, at its headline price, and never again in that snapshot", async () => {
    await button(sources());
    const down = sources(40, { endpoints: (s) => (modelOf(s) === "test/extra-000" ? new Response("down", { status: 503 }) : twoHosts(s)) });
    expect(await run(down)).toMatchObject({ left: 0 });
    expect((await figures()).find((x) => x.model === "test/extra-000")).toMatchObject({ basis: "unread", readAt: minute(1).toISOString() });
    expect(await readHostsWaiting(env.DB)).toBeUndefined();
  });

  it("reads the hosts of a snapshot with no figures, one the previous Worker wrote, with no one pressing Refresh", async () => {
    await daily(sources());
    await env.DB.batch([env.DB.prepare("DELETE FROM model_price_figures"), env.DB.prepare("DELETE FROM strength_lines")]);
    expect(await readHostsWaiting(env.DB)).toEqual({ waiting: FIXTURE_PAID + 40, done: 0, started: false });
    const fetcher = sources();
    expect(await run(fetcher)).toMatchObject({ tried: FIXTURE_PAID + 40, left: 0 });
    expect(endpointReads(fetcher)).toBe(FIXTURE_PAID + 40);
    expect((await figures()).filter((x) => !x.free).every((x) => x.basis === "hosts")).toBe(true);
    expect(await readLatestLines(env.DB)).toMatchObject({ month: "2026-11" });
    expect(await readHostsWaiting(env.DB)).toBeUndefined();
  });

  it("when no hosts wait, reads the database once, writes nothing and sends nothing", async () => {
    await daily(sources());
    const { db, sent } = watched(env.DB);
    const fetcher = sources();
    expect(await run(fetcher, minute(1), db)).toBeUndefined();
    expect(fetcher.sent).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^SELECT /);
  });

  it("leaves hosts another run holds to it, and takes over a run that stopped once its lease is over", async () => {
    await button(sources());
    const id = (await currentSnapshot(env.DB))!.id;
    await env.DB.prepare("UPDATE price_host_reads SET started_at = ? WHERE snapshot_id = ?").bind(AT.toISOString(), id).run();
    const busy = sources();
    expect(await run(busy, new Date(AT.getTime() + HOST_READ_LEASE_MS - 1000))).toBeUndefined();
    expect(busy.sent).toEqual([]);
    expect(await readHostsWaiting(env.DB)).toMatchObject({ started: true, done: 0 });
    const takeover = sources();
    expect(await run(takeover, new Date(AT.getTime() + HOST_READ_LEASE_MS + 1000))).toMatchObject({ snapshotId: id, left: 0 });
    expect(endpointReads(takeover)).toBe(FIXTURE_PAID + 40);
  });
});

describe("the Cron Triggers", () => {
  it("are the daily refresh and the every-minute background read, the same strings as wrangler.jsonc", () => {
    const crons = JSON.parse(wranglerConfig.replace(/^\s*\/\/.*$/gm, "")).triggers.crons;
    expect(crons).toEqual([DAILY_CRON, HOST_READ_CRON]);
  });

  it("run one batch of the waiting hosts every minute", async () => {
    await button(sources());
    const fetcher = sources();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetcher);
    await worker.scheduled({ cron: HOST_READ_CRON, scheduledTime: minute(1).getTime(), noRetry: () => {} } as ScheduledController, { DB: env.DB } as never);
    expect(endpointReads(fetcher)).toBe(FIXTURE_PAID + 40);
    expect(await readHostsWaiting(env.DB)).toBeUndefined();
  });
});
