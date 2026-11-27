// Every result on the model test leads with one plain line of 12 words or
// fewer; the reason and the fix are collapsed under Details (the owner,
// 2026-11-27: "why not make it even more verbose ... so that the users learn
// to read a book in 30seconds?"). Each refusal's result box and each Test all
// models row is rendered, and its visible line counted outside <details>.
import { describe, expect, it } from "vitest";
import { refusalFix, refusalText, type AddRefusal, type OfferRow } from "../src/models/add";
import type { TestAllRun } from "../src/models/test-all";
import { parseModels } from "../src/prices/openrouter";
import { esc } from "../src/prices/page";
import { modelsSection } from "../src/providers/models-panel";
import { openrouterPlugin } from "../src/providers/openrouter";
import { formatCost } from "../src/providers/page";
import { MODELS } from "./fake-sources";
import { testSecrets } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
const plugin = openrouterPlugin({}, testSecrets(), parseModels(MODELS, NOW).catalog);
// A model the app cannot call, so cannot_call shows its longest reason.
const BLOCKED = MODELS.data.find((m) => m.architecture.output_modalities.includes("audio"))!.id;
const REASONS: AddRefusal[] = [
  "not_set_up", "no_credits", "no_such_model", "no_permission", "busy", "app_not_configured", "no_reply", "refused",
  "not_connected", "not_offered", "no_price", "cannot_call", "wrong_model", "budget_spent", "not_passed",
];
const ROW: OfferRow = { model: "openai/gpt-6-luna", location: "global", free: false, callable: true, accountLeftOut: false, notes: [] };

const section = (extra: Partial<Parameters<typeof modelsSection>[0]>) =>
  modelsSection({
    plugin, viewer: "owner", rows: [ROW], plan: { models: [], estimateUsd: 0 }, confirmTestAll: false, testsFilter: "all", formatCost, now: NOW, ...extra,
  });

const visible = (html: string): string => html.replace(/<details[\s\S]*?<\/details>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const words = (text: string): number => text.split(" ").filter(Boolean).length;

describe("a result on the model test", () => {
  it("leads with a line of 12 words or fewer for every refusal, and keeps the reason in Details", () => {
    for (const reason of REASONS) {
      for (const free of [false, true]) {
        const outcome = { kind: "refused" as const, model: BLOCKED, reason, free, reply: { status: 400, errorName: "e", message: "m", repliedModel: "other/model" } };
        const html = section({ outcome });
        const verdict = html.match(/<p class="tc-verdict"><strong>([\s\S]*?)<\/strong>/)![1]!;
        expect(words(visible(verdict)), `${reason}: ${verdict}`).toBeLessThanOrEqual(12);
        const fix = refusalFix(outcome, plugin);
        if (fix) expect(html.match(/<details class="more"><summary>Details<\/summary>[\s\S]*?<\/details>/)![0]).toContain(esc(fix));
      }
    }
  });

  it("moves why the app can't call a model into Details", () => {
    const html = section({ outcome: { kind: "refused", model: BLOCKED, reason: "cannot_call" } });
    expect(visible(html.slice(html.indexOf('<div class="tc tc-bad"')))).not.toContain(plugin.connect.notCallableReason(BLOCKED)!);
    expect(html).toContain(plugin.connect.notCallableReason(BLOCKED)!);
  });

  it("offers Budgets as the one action when this month's budget is spent", () => {
    const html = section({ outcome: { kind: "refused", model: ROW.model, reason: "budget_spent" } });
    expect(html).toMatch(/<div class="row"><a class="btn small" href="[^"]*\/budgets">Budgets<\/a><\/div>/);
  });

  it("shows each Test all models row's line in 12 words or fewer", () => {
    const tests = REASONS.map((reason) => {
      const o = { kind: "refused" as const, model: `${reason}/model`, reason };
      return { model: o.model, state: "failed" as const, result: { reason, text: refusalText(o, plugin), fix: refusalFix(o, plugin) } };
    });
    const run: TestAllRun = { id: 1, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), modelCount: tests.length, estimateUsd: 0, tests, done: tests.length, realCostUsd: 0 };
    const html = section({ run });
    const lines = [...html.matchAll(/<span class="pill warn">[^<]*<\/span> <span class="small">([^<]*)<\/span>/g)].map((m) => m[1]!);
    expect(lines).toHaveLength(REASONS.length);
    for (const line of lines) expect(words(line), line).toBeLessThanOrEqual(12);
  });
});
