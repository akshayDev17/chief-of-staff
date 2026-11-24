import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import maintainerFile from "../prices/maintainer-read.json";
import { lookupPrice } from "../src/prices/lookup";
import type { MaintainerEntry } from "../src/prices/maintainer";
import { refreshPrices } from "../src/prices/refresh";
import { SNAPSHOTS_KEPT, currentSnapshot, listSnapshots, readSnapshotRows, recentAlerts, rollBackLatestSnapshot } from "../src/prices/store";
import worker from "../src/index";
import { fakeFetch, type Overrides } from "./fake-sources";

const entries = maintainerFile.entries as MaintainerEntry[];
const refresh = (day: string, overrides: Overrides = {}, googleApiKey: string | null = "test-key") =>
  refreshPrices({ db: env.DB, fetcher: fakeFetch(overrides), googleApiKey: googleApiKey ?? undefined, maintainerEntries: entries, now: new Date(`${day}T06:00:00Z`) });
const failing = () => new Response("upstream down", { status: 503 });

describe("the daily refresh", () => {
  it("stores a good snapshot from every source and answers lookups", async () => {
    const { results } = await refresh("2026-11-24");
    expect(results.map((r) => [r.source, r.ok])).toEqual([
      ["azure-retail", true], ["aws-price-list", true], ["google-catalog", true], ["maintainer-read", true],
    ]);
    expect((await currentSnapshot(env.DB))?.status).toBe("good");

    expect(await lookupPrice(env.DB, { provider: "bedrock", model: "Claude Sonnet 5.5", location: "global", tokenKind: "input" }))
      .toEqual({ usdPerMTok: 2, source: "aws-price-list", dateRead: "2026-11-24", stale: false });
    expect(await lookupPrice(env.DB, { provider: "bedrock", model: "Claude Sonnet 5.5", location: "us-east-1", tokenKind: "output" }))
      .toMatchObject({ usdPerMTok: 11 }); // the region's own (higher) price wins over its global one
    expect(await lookupPrice(env.DB, { provider: "foundry", model: "Claude Haiku 5.5", location: "global", tokenKind: "input", longPrompt: true }))
      .toEqual({ usdPerMTok: 0.5, source: "maintainer-read", dateRead: "2026-11-24", stale: false });
    expect(await lookupPrice(env.DB, { provider: "foundry", model: "GPT-6-luna", location: "data-zone", tokenKind: "input" }))
      .toMatchObject({ usdPerMTok: 0.11, source: "azure-retail" });
  });

  it("answers no price for a model the table does not have", async () => {
    expect(await lookupPrice(env.DB, { provider: "vertex", model: "GPT-6 Luna", location: "global", tokenKind: "input" })).toBeUndefined();
    await refresh("2026-11-24");
    expect(await lookupPrice(env.DB, { provider: "vertex", model: "GPT-6 Luna", location: "global", tokenKind: "input" })).toBeUndefined();
  });

  it("keeps the last good rows of a failed source, with their date read, and alerts", async () => {
    await refresh("2026-11-23");
    const { results } = await refresh("2026-11-24", { azure: failing });
    expect(results.find((r) => r.source === "azure-retail")).toMatchObject({ ok: false });
    const snapshot = await currentSnapshot(env.DB);
    expect(snapshot?.status).toBe("partial");
    expect(await lookupPrice(env.DB, { provider: "foundry", model: "GPT-6-luna", location: "global", tokenKind: "input" }))
      .toEqual({ usdPerMTok: 0.1, source: "azure-retail", dateRead: "2026-11-23", stale: true });
    expect(await lookupPrice(env.DB, { provider: "bedrock", model: "Claude Sonnet 5.5", location: "global", tokenKind: "input" }))
      .toMatchObject({ dateRead: "2026-11-24", stale: false });
    expect((await recentAlerts(env.DB))[0]).toMatchObject({ kind: "refresh_failed" });

    // The next good refresh shows its own date.
    await refresh("2026-11-25");
    expect(await lookupPrice(env.DB, { provider: "foundry", model: "GPT-6-luna", location: "global", tokenKind: "input" }))
      .toMatchObject({ dateRead: "2026-11-25", stale: false });
  });

  it("treats Google without its API key as a failed source, guessing nothing", async () => {
    const { results } = await refresh("2026-11-24", {}, null);
    expect(results.find((r) => r.source === "google-catalog")).toMatchObject({ ok: false, rows: 0 });
    expect(await lookupPrice(env.DB, { provider: "vertex", model: "Claude Sonnet 5.5", location: "global", tokenKind: "input" })).toBeUndefined();
  });

  it("refuses a read far smaller than the last good one", async () => {
    await refresh("2026-11-23");
    const tiny = () => new Response(JSON.stringify({ Items: [], NextPageLink: null }));
    const { results } = await refresh("2026-11-24", { azure: tiny });
    expect(results.find((r) => r.source === "azure-retail")?.ok).toBe(false);
    expect(await lookupPrice(env.DB, { provider: "foundry", model: "GPT-6-luna", location: "global", tokenKind: "input" }))
      .toMatchObject({ dateRead: "2026-11-23", stale: true });
  });

  it("rolls a bad refresh back to the previous snapshot", async () => {
    const first = await refresh("2026-11-23");
    await refresh("2026-11-24");
    const current = await rollBackLatestSnapshot(env.DB, new Date("2026-11-24T08:00:00Z"));
    expect(current?.id).toBe(first.snapshotId);
    expect(await lookupPrice(env.DB, { provider: "bedrock", model: "Claude Sonnet 5.5", location: "global", tokenKind: "input" }))
      .toMatchObject({ dateRead: "2026-11-23" });
    expect((await recentAlerts(env.DB))[0]?.kind).toBe("rolled_back");
  });

  it(`keeps the last ${SNAPSHOTS_KEPT} snapshots`, async () => {
    for (let d = 1; d <= SNAPSHOTS_KEPT + 2; d++) await refresh(`2026-11-${String(d).padStart(2, "0")}`);
    const snapshots = await listSnapshots(env.DB);
    expect(snapshots).toHaveLength(SNAPSHOTS_KEPT);
    const oldest = snapshots.at(-1);
    expect(oldest && (await readSnapshotRows(env.DB, oldest.id)).length).toBeGreaterThan(0);
    const { count } = (await env.DB.prepare("SELECT COUNT(DISTINCT snapshot_id) AS count FROM price_rows").first<{ count: number }>())!;
    expect(count).toBe(SNAPSHOTS_KEPT);
  });
});

describe("the Cron Triggers", () => {
  it("raises the weekly maintainer-reading reminder", async () => {
    await worker.scheduled({ cron: "0 7 * * 1", scheduledTime: Date.parse("2026-11-30T07:00:00Z"), noRetry() {} } as ScheduledController, env);
    const [alert] = await recentAlerts(env.DB);
    expect(alert?.kind).toBe("maintainer_reading_due");
    expect(alert?.detail).toContain("Claude Sonnet 5.5");
  });
});
