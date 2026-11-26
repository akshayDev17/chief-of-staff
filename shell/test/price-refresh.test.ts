import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import maintainerFile from "../prices/maintainer-read.json";
import { lookupPrice, lookupTier } from "../src/prices/lookup";
import type { MaintainerEntry } from "../src/prices/maintainer";
import { refreshPrices } from "../src/prices/refresh";
import { SNAPSHOTS_KEPT, currentSnapshot, listSnapshots, readSnapshotRows, recentAlerts, rollBackLatestSnapshot } from "../src/prices/store";
import worker from "../src/index";
import type { GoogleFederationEnv } from "../src/google-federation";
import { fakeFetch, googleEnv, type Overrides } from "./fake-sources";
import azure from "./fixtures/azure-retail-eastus2.json";

const entries = maintainerFile.entries as MaintainerEntry[];
const refresh = async (day: string, overrides: Overrides = {}, google?: GoogleFederationEnv) =>
  refreshPrices({ db: env.DB, fetcher: fakeFetch(overrides), google: google ?? (await googleEnv()), maintainerEntries: entries, now: new Date(`${day}T06:00:00Z`) });
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
    expect(await lookupPrice(env.DB, { provider: "foundry", model: "Claude Haiku 4.5", location: "global", tokenKind: "output" }))
      .toEqual({ usdPerMTok: 5, source: "maintainer-read", dateRead: "2026-11-25", stale: false });
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

  it("treats Google before the app's pool exists as a failed source, guessing nothing", async () => {
    const { results } = await refresh("2026-11-24", {}, { ...(await googleEnv()), GOOGLE_WIF_PROVIDER: undefined });
    expect(results.find((r) => r.source === "google-catalog")).toMatchObject({ ok: false, rows: 0, error: "not configured yet: GOOGLE_WIF_PROVIDER" });
    expect(await lookupPrice(env.DB, { provider: "vertex", model: "Claude Sonnet 5.5", location: "global", tokenKind: "input" })).toBeUndefined();
  });

  it("reports Google's own words when the Catalog refuses the price reader, keeps the last prices marked stale, and tries no key", async () => {
    await refresh("2026-11-23");
    const refused = () =>
      Response.json({ error: { code: 401, message: "made-up refusal for this test", status: "UNAUTHENTICATED" } }, { status: 401 });
    const { results } = await refresh("2026-11-24", { google: refused });
    expect(results.find((r) => r.source === "google-catalog")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Cloud Billing Catalog API answered 401 UNAUTHENTICATED: /),
    });
    expect(await lookupPrice(env.DB, { provider: "vertex", model: "Claude Sonnet 5.5", location: "global", tokenKind: "input" }))
      .toMatchObject({ source: "google-catalog", dateRead: "2026-11-23", stale: true });
    expect((await recentAlerts(env.DB))[0]).toMatchObject({ kind: "refresh_failed" });
  });

  it("reports STS's refusal of the price reader as a failed source", async () => {
    const sts = () => Response.json({ error: "invalid_grant", error_description: "The given credential is rejected by the attribute condition." }, { status: 400 });
    const { results } = await refresh("2026-11-24", { sts });
    expect(results.find((r) => r.source === "google-catalog")).toMatchObject({ ok: false, error: "sts.googleapis.com token: 400 invalid_grant" });
  });

  it("stores a smaller read as the vendor lists it: a model no longer listed has no price yet", async () => {
    await refresh("2026-11-23");
    const withoutLuna = () => Response.json({ ...azure, Items: azure.Items.filter((i) => !i.meterName.startsWith("6-luna")) });
    const { results } = await refresh("2026-11-24", { azure: withoutLuna });
    const read = results.find((r) => r.source === "azure-retail");
    expect(read).toMatchObject({ ok: true, added: 0 });
    expect(read!.dropped).toBeGreaterThan(read!.rows);
    expect((await currentSnapshot(env.DB))?.status).toBe("good");
    expect(await lookupPrice(env.DB, { provider: "foundry", model: "GPT-6-luna", location: "global", tokenKind: "input" })).toBeUndefined();
    expect(await lookupPrice(env.DB, { provider: "bedrock", model: "Claude Sonnet 5.5", location: "global", tokenKind: "input" }))
      .toMatchObject({ dateRead: "2026-11-24" });
  });

  it("counts every row as added on the first refresh and none on an unchanged one", async () => {
    const first = await refresh("2026-11-23");
    expect(first.results.every((r) => r.added > 0 && r.dropped === 0)).toBe(true);
    const second = await refresh("2026-11-24");
    expect(second.results.map((r) => [r.added, r.dropped])).toEqual(second.results.map(() => [0, 0]));
  });

  it("keeps the previous snapshot current when the new one cannot be written, and alerts", async () => {
    const first = await refresh("2026-11-23");
    // A negative price breaks the table's CHECK, so the write fails part way.
    const [good] = entries;
    const broken = [{ ...good!, model: "Claude Broken", meters: [{ token_kind: "input" as const, long_prompt: false, usd_per_mtok: -1 }] }];
    await expect(refreshPrices({
      db: env.DB, fetcher: fakeFetch(), google: await googleEnv(), maintainerEntries: [...entries, ...broken], now: new Date("2026-11-24T06:00:00Z"),
    })).rejects.toThrow();
    expect((await currentSnapshot(env.DB))?.id).toBe(first.snapshotId);
    expect(await listSnapshots(env.DB)).toHaveLength(1);
    expect(await lookupPrice(env.DB, { provider: "bedrock", model: "Claude Sonnet 5.5", location: "global", tokenKind: "input" }))
      .toMatchObject({ usdPerMTok: 2, dateRead: "2026-11-23" });
    expect((await recentAlerts(env.DB))[0]).toMatchObject({ kind: "refresh_failed" });
    expect((await recentAlerts(env.DB))[0]?.detail).toContain("could not store the snapshot");
  });

  it("rolls a bad refresh back to the previous snapshot", async () => {
    const first = await refresh("2026-11-23");
    const second = await refresh("2026-11-24");
    const current = await rollBackLatestSnapshot(env.DB);
    expect(current?.id).toBe(first.snapshotId);
    expect(await lookupPrice(env.DB, { provider: "bedrock", model: "Claude Sonnet 5.5", location: "global", tokenKind: "input" }))
      .toMatchObject({ dateRead: "2026-11-23" });
    const [alert] = await recentAlerts(env.DB);
    expect(alert).toMatchObject({ kind: "rolled_back", detail: `snapshot ${second.snapshotId} of 2026-11-24T06:00:00.000Z rolled back` });
    expect(alert!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("refuses a rollback, changing and recording nothing, when no earlier snapshot would stay current", async () => {
    await expect(rollBackLatestSnapshot(env.DB)).rejects.toThrow(/nothing rolled back/);
    const only = await refresh("2026-11-23");
    await expect(rollBackLatestSnapshot(env.DB)).rejects.toThrow(/nothing rolled back/);
    expect((await currentSnapshot(env.DB))?.id).toBe(only.snapshotId);
    expect(await recentAlerts(env.DB)).toEqual([]);

    await refresh("2026-11-24");
    expect((await rollBackLatestSnapshot(env.DB))?.id).toBe(only.snapshotId);
    await expect(rollBackLatestSnapshot(env.DB)).rejects.toThrow(/nothing rolled back/);
    expect((await currentSnapshot(env.DB))?.id).toBe(only.snapshotId);
    expect((await recentAlerts(env.DB)).map((a) => a.kind)).toEqual(["rolled_back"]);
  });

  it("answers one tier per model at each provider", async () => {
    expect(await lookupTier(env.DB, { provider: "bedrock", model: "Claude Sonnet 5.5" })).toBeUndefined();
    await refresh("2026-11-24");
    // Global $2.00 (in-region $2.20): Middle either way, from the Global price.
    expect(await lookupTier(env.DB, { provider: "bedrock", model: "Claude Sonnet 5.5" })).toBe("Middle");
    expect(await lookupTier(env.DB, { provider: "foundry", model: "Claude Fable 5.1" })).toBe("Strongest");
    expect(await lookupTier(env.DB, { provider: "foundry", model: "GPT-6-luna" })).toBe("Smallest");
    expect(await lookupTier(env.DB, { provider: "vertex", model: "GPT-6 Luna" })).toBeUndefined();
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
