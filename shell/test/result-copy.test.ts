// Every result under a model's row leads with one plain line of 12 words or
// fewer; the reason and the fix are collapsed under Details (the owner,
// 2026-11-27: "why not make it even more verbose ... so that the users learn
// to read a book in 30seconds?"). Each refusal's result is rendered, and its
// visible line counted outside <details>; so is each failed row's line.
import { describe, expect, it } from "vitest";
import { listOfferRow } from "./result-copy-helpers";
import type { TableRow } from "../src/models/ready";
import { refusalFix, refusalText, type Refused, type TestRefusal } from "../src/models/test-model";
import { parseModels } from "../src/prices/openrouter";
import { esc } from "../src/prices/page";
import { modelParts, type ModelsTableInput } from "../src/providers/models-table";
import { openrouterPlugin } from "../src/providers/openrouter";
import { MODELS } from "./fake-sources";
import { testSecrets } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
const plugin = openrouterPlugin({}, testSecrets(), parseModels(MODELS, NOW).catalog);
// A model the app cannot call, so cannot_call shows its longest reason.
const BLOCKED = MODELS.data.find((m) => m.architecture.output_modalities.includes("audio"))!.id;
const REASONS: TestRefusal[] = [
  "not_set_up", "no_credits", "no_such_model", "no_permission", "busy", "app_not_configured", "no_reply", "refused",
  "not_connected", "not_offered", "no_price", "no_cap", "cap_refused", "cannot_call", "wrong_model", "budget_spent",
];
const ROW = listOfferRow("openai/gpt-6-luna");

const rows = (model: string, extra: Partial<TableRow>, view: ModelsTableInput["view"]) =>
  modelParts({ plugin, viewer: "owner", rows: [listOfferRow(model, extra)], usedBy: new Map(), view, now: NOW }).rows;
// The row of a model whose latest call failed with `o`.
const failed = (o: Refused): Partial<TableRow> => ({
  state: "ready",
  latest: { model: o.model, state: "failed", testedAt: NOW.toISOString(), result: { reason: o.reason, text: refusalText(o, plugin), fix: refusalFix(o, plugin), ...(o.reply ? { reply: o.reply } : {}) } },
});

const visible = (html: string): string => html.replace(/<details[\s\S]*?<\/details>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
// The "·" between a row's parts is no word.
const words = (text: string): number => text.split(" ").filter((w) => w && w !== "·").length;

describe("a result under a model's row", () => {
  it("leads with a line of 12 words or fewer for every refusal, and keeps the reason in Details", () => {
    for (const reason of REASONS) {
      for (const free of [false, true]) {
        const outcome: Refused = { kind: "refused", model: BLOCKED, reason, free, reply: { status: 400, errorName: "e", message: "m", repliedModel: "other/model" } };
        const html = rows(BLOCKED, failed(outcome), { results: [{ model: BLOCKED }] });
        const verdict = html.match(/<div class="result[^"]*" role="alert"><p class="v">[\s\S]*?<strong>([\s\S]*?)<\/strong>/)![1]!;
        expect(words(visible(verdict)), `${reason}: ${verdict}`).toBeLessThanOrEqual(12);
        const fix = refusalFix(outcome, plugin);
        if (fix) expect(html.match(/<details><summary>Details<\/summary>[\s\S]*?<\/details>/)![0]).toContain(esc(fix));
      }
    }
  });

  it("moves why the app can't call a model into Details", () => {
    const html = rows(BLOCKED, {}, { results: [{ model: BLOCKED, reason: "cannot_call" }] });
    const box = html.slice(html.indexOf('<div class="result'));
    expect(visible(box)).not.toContain(plugin.connect.notCallableReason(BLOCKED)!);
    expect(box).toContain(esc(plugin.connect.notCallableReason(BLOCKED)!));
  });

  it("offers Budgets as the one action when this month's budget is spent", () => {
    const html = rows(ROW.model, failed({ kind: "refused", model: ROW.model, reason: "budget_spent" }), { results: [{ model: ROW.model }] });
    expect(html).toMatch(/<div class="acts"><a class="btn small outline" href="[^"]*\/budgets">Budgets<\/a><\/div>/);
  });

  it("shows each failed row's line in 12 words or fewer, with its Details collapsed", () => {
    for (const reason of REASONS) {
      const html = rows(ROW.model, failed({ kind: "refused", model: ROW.model, reason }), {});
      const line = visible(html.match(/<span class="meta why">([\s\S]*?) · <button type="button" class="link" data-det=/)![1]!);
      expect(words(line), `${reason}: ${line}`).toBeLessThanOrEqual(12);
      expect(html).toMatch(/<div class="det" id="det-[^"]+" data-det-panel hidden>/);
    }
  });
});
