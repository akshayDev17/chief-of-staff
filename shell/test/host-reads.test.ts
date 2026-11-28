// The hosts a price snapshot's figures wait for, and the background read of
// them (src/prices/host-reads.ts): Refresh model list never reads hundreds of
// endpoints lists inside the user's request, and nothing depends on someone
// pressing it or on the next daily refresh.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { DAILY_CRON, HOST_READ_CRON } from "../src/index";
import wranglerConfig from "../wrangler.jsonc?raw";
import { HOST_READ_LEASE_MS, readHostsWaiting, readWaitingHosts } from "../src/prices/host-reads";
import { HOST_READS_NOW, refreshPrices } from "../src/prices/refresh";
import { currentSnapshot, readFigures, readHostReads, readLatestLines } from "../src/prices/store";
import { fakeFetch, MODELS, type Sent } from "./fake-sources";

// The fixture's list and 40 more paid tool-use models: more than Refresh
// reads while the user waits.
const LUNA = MODELS.data.find((m) => m.id === "openai/gpt-6-luna")!;
const EXTRA = Array.from({ length: 40 }, (_, i) => ({ ...LUNA, id: `test/extra-${String(i).padStart(2, "0")}`, name: `Test: Extra ${i}` }));
const MANY = { data: [...MODELS.data, ...EXTRA] };
// Every paid model the list tiers: the fixture's five and the forty.
const PAID = 45;

const modelOf = (s: Sent): string => decodeURI(new URL(s.url).pathname.replace(/^\/api\/v1\/models\//, "").replace(/\/endpoints$/, ""));
// Every model's two hosts, at $1 / $2 and $3 / $4 a million tokens.
const twoHosts = (s: Sent) =>
  Response.json({
    data: {
      id: modelOf(s),
      endpoints: [1, 3].map((p) => ({ pricing: { prompt: String(p / 1e6), completion: String((p + 1) / 1e6) }, service_tier: null, supported_parameters: ["tools"], status: 0 })),
    },
  });
const sources = (extra: Parameters<typeof fakeFetch>[0] = {}) => fakeFetch({ models: () => Response.json(MANY), endpoints: twoHosts, ...extra });
const endpointReads = (f: { sent: Sent[] }) => f.sent.filter((s) => s.url.endsWith("/endpoints")).length;

const AT = new Date("2026-11-28T16:10:00Z");
const LATER = new Date("2026-11-28T16:11:00Z");

// Refresh model list, as Providers sends it.
const button = (fetcher: typeof fetch, now = AT) => refreshPrices({ db: env.DB, fetcher, now, hostReadsNow: HOST_READS_NOW, hostRetryPauseMs: 0 });
const background = (fetcher: typeof fetch, now = LATER) => readWaitingHosts({ db: env.DB, fetcher, now, hostRetryPauseMs: 0 });
const figures = async () => readFigures(env.DB, (await currentSnapshot(env.DB))!.id);

afterEach(() => vi.restoreAllMocks());

describe("Refresh model list", () => {
  it("never reads the full host read inline: with more than HOST_READS_NOW to read, it reads none and leaves them waiting", async () => {
    const fetcher = sources();
    await button(fetcher);
    expect(endpointReads(fetcher)).toBe(0);
    expect(fetcher.sent).toHaveLength(1);
    expect(await readHostsWaiting(env.DB)).toEqual({ waiting: PAID, done: 0, started: false });
    // Meanwhile each is at its headline price, and no lines are drawn from those.
    const f = await figures();
    expect(f.filter((x) => !x.free).every((x) => x.basis === "unread")).toBe(true);
    expect(await readLatestLines(env.DB)).toBeUndefined();
  });

  it("reads the few that changed while the user waits, and leaves nothing waiting", async () => {
    await refreshPrices({ db: env.DB, fetcher: sources(), now: AT, daily: true, hostRetryPauseMs: 0 });
    // Nothing changed: nothing to read.
    const same = sources();
    await button(same, LATER);
    expect(endpointReads(same)).toBe(0);
    expect(await readHostsWaiting(env.DB)).toBeUndefined();
    // One new model and one whose headline changed: two lists, read now.
    const changed = { data: [...MANY.data.map((m) => (m.id === "test/extra-00" ? { ...m, pricing: { ...m.pricing, prompt: "0.0000002" } } : m)), { ...LUNA, id: "test/new", name: "Test: New" }] };
    const fetcher = sources({ models: () => Response.json(changed) });
    await button(fetcher, new Date("2026-11-28T17:00:00Z"));
    expect(fetcher.sent.filter((s) => s.url.endsWith("/endpoints")).map(modelOf).sort()).toEqual(["test/extra-00", "test/new"]);
    expect(await readHostsWaiting(env.DB)).toBeUndefined();
    expect((await figures()).find((x) => x.model === "test/new")).toMatchObject({ basis: "hosts", hosts: 2 });
  });

  it("keeps the waiting hosts waiting when OpenRouter's list cannot be read", async () => {
    await button(sources());
    await button(sources({ models: () => new Response("down", { status: 503 }) }), LATER);
    expect((await currentSnapshot(env.DB))!.status).toBe("partial");
    expect(await readHostsWaiting(env.DB)).toEqual({ waiting: PAID, done: 0, started: false });
  });
});

describe("the background read", () => {
  it("reads every waiting model's hosts, stores the next snapshot with their figures, and draws the first lines", async () => {
    await button(sources());
    const waited = (await currentSnapshot(env.DB))!.id;
    const fetcher = sources();
    const stored = await background(fetcher);
    expect(endpointReads(fetcher)).toBe(PAID);
    expect(stored).toBe((await currentSnapshot(env.DB))!.id);
    expect(stored).toBeGreaterThan(waited);
    const f = await figures();
    expect(f.filter((x) => !x.free).every((x) => x.basis === "hosts" && x.hosts === 2)).toBe(true);
    expect(f.find((x) => x.model === "test/extra-00")).toMatchObject({ input: { min: 1, max: 3 }, output: { min: 2, max: 4 } });
    expect(await readLatestLines(env.DB)).toMatchObject({ month: "2026-11", models: PAID });
    expect(await readHostsWaiting(env.DB)).toBeUndefined();
    // Its progress, as it went: every list tried.
    expect(await readHostReads(env.DB, waited)).toEqual({ waiting: PAID, done: PAID, queuedAt: AT.toISOString(), startedAt: LATER.toISOString() });
  });

  it("reads the hosts of a snapshot with no figures, one the previous Worker wrote, with no one pressing Refresh", async () => {
    await refreshPrices({ db: env.DB, fetcher: sources(), now: AT, daily: true, hostRetryPauseMs: 0 });
    await env.DB.batch([env.DB.prepare("DELETE FROM model_price_figures"), env.DB.prepare("DELETE FROM strength_lines")]);
    expect(await readHostsWaiting(env.DB)).toEqual({ waiting: PAID, done: 0, started: false });
    const fetcher = sources();
    await background(fetcher);
    expect(endpointReads(fetcher)).toBe(PAID);
    expect((await figures()).filter((x) => !x.free).every((x) => x.basis === "hosts")).toBe(true);
    expect(await readHostsWaiting(env.DB)).toBeUndefined();
  });

  it("does nothing, and sends nothing, when no hosts wait", async () => {
    await refreshPrices({ db: env.DB, fetcher: sources(), now: AT, daily: true, hostRetryPauseMs: 0 });
    const before = (await currentSnapshot(env.DB))!.id;
    const fetcher = sources();
    expect(await background(fetcher)).toBeUndefined();
    expect(fetcher.sent).toEqual([]);
    expect((await currentSnapshot(env.DB))!.id).toBe(before);
  });

  it("leaves hosts another run holds to it, and takes over a run that stopped once its lease is over", async () => {
    await button(sources());
    const id = (await currentSnapshot(env.DB))!.id;
    await env.DB.prepare("UPDATE price_host_reads SET started_at = ? WHERE snapshot_id = ?").bind(AT.toISOString(), id).run();
    const busy = sources();
    expect(await background(busy, new Date(AT.getTime() + HOST_READ_LEASE_MS - 1000))).toBeUndefined();
    expect(busy.sent).toEqual([]);
    expect(await readHostsWaiting(env.DB)).toMatchObject({ started: true });
    const takeover = sources();
    expect(await background(takeover, new Date(AT.getTime() + HOST_READ_LEASE_MS + 1000))).toBeGreaterThan(id);
    expect(endpointReads(takeover)).toBe(PAID);
  });

  it("stores nothing when OpenRouter's list cannot be read, so the hosts still wait for the next try", async () => {
    await button(sources());
    const id = (await currentSnapshot(env.DB))!.id;
    await expect(background(sources({ models: () => new Response("down", { status: 503 }) }))).rejects.toThrow("the hosts wait for the next try");
    expect((await currentSnapshot(env.DB))!.id).toBe(id);
    expect(await readHostsWaiting(env.DB)).toMatchObject({ waiting: PAID, started: true });
  });
});

describe("the Cron Triggers", () => {
  it("are the daily refresh and the every-minute background read, the same strings as wrangler.jsonc", () => {
    const crons = JSON.parse(wranglerConfig.replace(/^\s*\/\/.*$/gm, "")).triggers.crons;
    expect(crons).toEqual([DAILY_CRON, HOST_READ_CRON]);
  });

  it("run the background read every minute, which stores the waiting hosts' figures", async () => {
    await button(sources());
    const fetcher = sources();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetcher);
    await worker.scheduled({ cron: HOST_READ_CRON, scheduledTime: LATER.getTime(), noRetry: () => {} } as ScheduledController, { DB: env.DB } as never);
    expect(endpointReads(fetcher)).toBe(PAID);
    expect(await readHostsWaiting(env.DB)).toBeUndefined();
  });
});
