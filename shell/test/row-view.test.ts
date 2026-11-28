// What a model's row and the result under it show, for every combination of
// the one rule's inputs (models/ready.ts rowState, models-table.ts
// describeRow): the model's latest call (none, passed, failed when used, failed
// when tested, or a failure on an earlier key, which marks nothing), whether
// the account has credit, whether something blocks the row, and this page's
// own Test of it (none, a recorded result, or each kind of refusal that
// records nothing). Each is rendered as the page renders it, for an owner and
// for a friend.
import { describe, expect, it } from "vitest";
import { listOfferRow } from "./result-copy-helpers";
import type { LatestTest, TestRecord } from "../src/models/latest-tests";
import { rowState } from "../src/models/ready";
import { MODEL_HELP_REASONS, refusalFix, refusalText, type Refused, type TestRefusal } from "../src/models/test-model";
import { parseModels } from "../src/prices/openrouter";
import { esc } from "../src/prices/page";
import { modelParts, type ModelsTableInput } from "../src/providers/models-table";
import { openrouterPlugin } from "../src/providers/openrouter";
import { MODELS } from "./fake-sources";
import { testSecrets } from "./test-plugin";

const NOW = new Date("2026-11-27T10:00:00Z");
const plugin = openrouterPlugin({}, testSecrets(), parseModels(MODELS, NOW).catalog);
const MODEL = "openai/gpt-6-luna";
const AT = NOW.toISOString();

const FAILED: TestRecord = { reason: "no_such_model", text: "Not on OpenRouter any more.", reply: { status: 404, message: "No endpoints found" }, fix: "Refresh model list." };
const WORKS: TestRecord = { text: "Works now.", test: { at: AT, location: "global", status: 200, costUsd: 0.000001 } };

// Each kind of refusal from a Test that records nothing.
const KINDS: Array<{ name: string; reason: TestRefusal }> = [
  { name: "busy", reason: "busy" },
  { name: "needs credit", reason: "no_credits" },
  { name: "budget spent", reason: "budget_spent" },
  { name: "not connected", reason: "not_connected" },
  { name: "no key", reason: "not_set_up" },
  { name: "app setup", reason: "app_not_configured" },
  { name: "no credential", reason: "no_reply" },
];
const record = (reason: TestRefusal): TestRecord => {
  const o: Refused = { kind: "refused", model: MODEL, reason };
  const fix = refusalFix(o, plugin);
  return { reason, text: refusalText(o, plugin), ...(fix ? { fix } : {}) };
};
const ACTIONS: Partial<Record<TestRefusal, string>> = { no_credits: "Add credits", busy: "Test again", budget_spent: "Budgets" };

type Latest = "none" | "passed" | "failed-used" | "failed-tested" | "earlier-failed";
type Test = "none" | "recorded" | TestRefusal;
type Case = { latest: Latest; credit: boolean; blocked: boolean; test: Test };

const cases: Case[] = [];
for (const latest of ["none", "passed", "failed-used", "failed-tested", "earlier-failed"] as const)
  for (const credit of [true, false])
    for (const blocked of [false, true])
      for (const test of ["none", "recorded", ...KINDS.map((k) => k.reason)] as Test[]) cases.push({ latest, credit, blocked, test });

const latestOf = (c: Case): LatestTest | undefined => {
  if (c.latest === "none") return undefined;
  if (c.latest === "passed") return { model: MODEL, state: "passed", testedAt: AT, result: WORKS };
  return { model: MODEL, state: "failed", testedAt: AT, result: c.latest === "failed-used" ? { ...FAILED, used: true } : FAILED, ...(c.latest === "earlier-failed" ? { earlierKey: true as const } : {}) };
};

function render(c: Case, viewer: "owner" | "friend"): string {
  const offer = listOfferRow(MODEL, c.blocked ? { accountLeftOut: true } : {});
  const latest = latestOf(c);
  const current = latest && !latest.earlierKey ? latest : undefined;
  const row = { ...offer, state: rowState(offer, c.credit), ...(current ? { latest: current } : {}) };
  const view: ModelsTableInput["view"] = c.test === "none" ? {} : { results: [{ model: MODEL, ...(c.test === "recorded" ? {} : { reason: c.test }) }] };
  return modelParts({ plugin, viewer, rows: [row], usedBy: new Map(), view, now: NOW }).rows;
}

// What the rule says each case shows.
function expected(c: Case) {
  const state = c.blocked ? "step" : !c.credit ? "credit" : "ready";
  const refusal = c.test !== "none" && c.test !== "recorded" ? record(c.test) : undefined;
  const failedNow = !c.blocked && (c.latest === "failed-used" || c.latest === "failed-tested");
  const failed = !refusal && failedNow ? (c.latest === "failed-used" ? "Failed when used" : "Failed when tested") : undefined;
  const lead = refusal?.text ?? (failed ? FAILED.text : undefined);
  const tag = refusal
    ? refusal.reason === "no_credits" ? "Needs credit" : state !== "ready" ? undefined : refusal.reason === "busy" ? "Busy" : "Couldn't test"
    : state === "credit" ? "Needs credit" : undefined;
  const actions = refusal && ACTIONS[refusal.reason!] ? [ACTIONS[refusal.reason!]!] : [];
  const passed = c.test === "recorded" && c.latest === "passed";
  const askReason = refusal?.reason ?? (failed ? FAILED.reason : undefined);
  const ask = lead && askReason && MODEL_HELP_REASONS.has(askReason) ? askReason : undefined;
  return { state, lead, failed, tag, actions, passed, ask, again: failedNow };
}

const label = (c: Case) => `${c.latest} latest, ${c.credit ? "credit" : "no credit"}, ${c.blocked ? "blocked" : "open"} row, test ${c.test}`;
const labels = (html: string) => [...html.matchAll(/>(Add credits|Test again|Budgets|Ask Admin for help)</g)].map((m) => m[1]);

describe("a model's row and its result", () => {
  it(`shows what the one rule says, in all ${cases.length} combinations`, () => {
    expect(cases.length).toBe(5 * 2 * 2 * (2 + KINDS.length));
    for (const c of cases) {
      const e = expected(c);
      const name = label(c);
      const row = render(c, "owner");
      expect(row.match(/data-state="([a-z]+)"/)![1], name).toBe(e.state);
      expect([...row.matchAll(/<span class="pill[^"]*">([^<]+)<\/span>/g)].map((m) => m[1]!.replace(/&#39;/g, "'")), name).toEqual(e.tag ? [e.tag] : []);
      // Try again in place of Test, on a row whose latest call failed.
      expect(row.includes('<span class="lbl">Try again</span>'), name).toBe(e.again);
      expect(row, name).not.toContain("earlier key");
      // With no result open, the reason line leads the row.
      const why = row.match(/<span class="meta why">([\s\S]*?) · <button[^>]*>Details<\/button><\/span>/);
      if (c.test === "none" && e.lead && !c.blocked) expect(why?.[1], name).toBe(`<span class="fw">${e.failed}</span> · ${esc(e.lead)}`);
      else if (c.test === "none") expect(why, name).toBeNull();
      if (c.test === "none") continue;
      // The result under it, for the owner.
      if (e.passed) expect(row, name).toContain("passed.</strong> It answered just now.");
      else expect(row, name).not.toContain("passed.</strong>");
      const box = row.match(/<div class="result[^"]*" role="alert">([\s\S]*?)<\/div><\/div><\/li>/)?.[1];
      if (!e.lead) {
        expect(box, name).toBeUndefined();
        continue;
      }
      expect(box!.match(/<strong>([\s\S]*?)<\/strong>/)![1], name).toBe(e.failed ? `${e.failed} · ${esc(e.lead)}` : esc(e.lead));
      expect(labels(box!.split("<details>")[0]!), name).toEqual(e.actions);
      const det = box!.match(/<details><summary>Details<\/summary>([\s\S]*)<\/details>/)?.[1] ?? "";
      if (e.failed) expect(det, name).toContain(esc(FAILED.fix!));
      // A friend's Ask Admin sends the reason shown, one the model-help form takes.
      const friend = render(c, "friend");
      const asks = [...friend.matchAll(/name="reason" value="([^"]*)"><button[^>]*>Ask Admin for help/g)];
      expect(asks.map((a) => a[1]), name).toEqual(e.ask ? [e.ask] : []);
    }
  });

  it("never changes the case of a refusal's text", () => {
    const c: Case = { latest: "none", credit: true, blocked: false, test: "not_connected" };
    expect(render(c, "owner")).toContain(`<strong>${esc(plugin.connect.guide.name)} is not connected.</strong>`);
  });
});
