// What a model's row and the result under it show, for every combination of
// the one rule's inputs (models-table.ts describeRow): the latest verdict
// (none, passed, failed), the newest refusal that says nothing about the
// model (none, or each kind, from the user's own Test or from a run), and
// whether the row is open, blocked or being tested in a run. Each is rendered
// as the page renders it, for an owner and for a friend.
import { describe, expect, it } from "vitest";
import { listOfferRow, type ShownLatest } from "./result-copy-helpers";
import type { ShownTest } from "../src/models/test-all";
import { MODEL_HELP_REASONS, refusalFix, refusalText, type Refused, type TestRefusal } from "../src/models/test-model";
import type { TestRecord } from "../src/models/usable";
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

// Each kind of refusal that says nothing about the model; the last is only a run's.
const KINDS: Array<{ name: string; reason: TestRefusal; runOnly?: true; text?: string }> = [
  { name: "busy", reason: "busy" },
  { name: "needs credit", reason: "no_credits" },
  { name: "budget spent", reason: "budget_spent" },
  { name: "not connected", reason: "not_connected" },
  { name: "no key", reason: "not_set_up" },
  { name: "app setup", reason: "app_not_configured" },
  { name: "no credential", reason: "no_reply" },
  { name: "could not run", reason: "no_reply", runOnly: true, text: "The test could not run." },
];
const record = (k: (typeof KINDS)[number]): TestRecord => {
  if (k.text) return { reason: k.reason, text: k.text };
  const o: Refused = { kind: "refused", model: MODEL, reason: k.reason };
  const fix = refusalFix(o, plugin);
  return { reason: k.reason, text: refusalText(o, plugin), ...(fix ? { fix } : {}) };
};
const ACTIONS: Partial<Record<TestRefusal, string>> = { no_credits: "Add credits", busy: "Test again", budget_spent: "Budgets" };
const TAG: Partial<Record<TestRefusal, string>> = { no_credits: "Needs credit", busy: "Busy" };

type Verdict = "none" | "passed" | "failed";
type Row = "open" | "blocked" | "testing";
type Case = { verdict: Verdict; kind?: (typeof KINDS)[number]; from?: "test" | "run"; row: Row };

const cases: Case[] = [];
for (const verdict of ["none", "passed", "failed"] as const) {
  for (const row of ["open", "blocked", "testing"] as const) {
    cases.push({ verdict, row });
    for (const kind of KINDS) for (const from of kind.runOnly ? (["run"] as const) : (["test", "run"] as const)) cases.push({ verdict, kind, from, row });
  }
}

function shownFor(c: Case): Map<string, ShownTest> {
  if (c.row === "testing") return new Map([[MODEL, { state: "testing" }]]);
  const run = c.kind && c.from === "run" ? record(c.kind) : undefined;
  let s: ShownLatest | undefined;
  if (c.verdict === "failed") s = { state: "failed", verdict: "failed", testedAt: AT, result: FAILED, ...(run ? { later: run } : {}) };
  else if (run) s = { state: "failed", ...(c.verdict === "passed" ? { verdict: "passed" as const } : {}), notVerdict: true, testedAt: AT, result: run };
  else if (c.verdict === "passed") s = { state: "passed", verdict: "passed", testedAt: AT, result: WORKS };
  return new Map(s ? [[MODEL, s]] : []);
}

function render(c: Case, viewer: "owner" | "friend", withResult: boolean): string {
  const fromTest = c.kind && c.from === "test" ? c.kind : undefined;
  const view: ModelsTableInput["view"] = withResult ? { results: [{ model: MODEL, ...(fromTest ? { reason: fromTest.reason } : {}) }] } : {};
  const input: ModelsTableInput = {
    plugin, viewer, rows: [{ ...listOfferRow(MODEL), ...(c.row === "blocked" ? { accountLeftOut: true } : {}) }],
    plan: { models: [], estimateUsd: 0 }, retest: { models: [], estimateUsd: 0, skipped: 0 }, shown: shownFor(c), usedBy: new Map(), view, now: NOW,
  };
  return modelParts(input).rows;
}

// What the rule says each case shows.
function expected(c: Case) {
  const failed = c.verdict === "failed" && c.row !== "testing";
  const refusal = c.kind && !(c.row === "testing" && c.from === "run") ? record(c.kind) : undefined;
  const usable = c.verdict === "passed" && c.row === "open";
  const state = c.row === "blocked" ? "blocked" : c.row === "testing" ? "pending" : c.verdict === "passed" ? "works" : c.verdict === "failed" ? "fails" : "pending";
  const tag = failed ? "Doesn't work" : refusal && usable ? (TAG[refusal.reason!] ?? "Couldn't test") : undefined;
  const lead = failed ? FAILED.text : refusal?.text;
  const note = failed && refusal ? `${c.from === "test" ? "This test" : "Latest test"} couldn't run. ${refusal.text}` : undefined;
  const leadActions = failed ? [] : refusal && ACTIONS[refusal.reason!] ? [ACTIONS[refusal.reason!]!] : [];
  const noteActions = note && ACTIONS[refusal!.reason!] ? [ACTIONS[refusal!.reason!]!] : [];
  const passed = !lead && c.verdict === "passed" && c.row !== "testing";
  const askable = (reason: TestRefusal | undefined) => (reason && MODEL_HELP_REASONS.has(reason) ? reason : undefined);
  const refusalAsk = askable(refusal?.reason);
  const ask = !lead
    ? undefined
    : refusalAsk
      ? { reason: refusalAsk, on: note ? "note" : "lead" }
      : failed && askable(FAILED.reason)
        ? { reason: FAILED.reason, on: "lead" }
        : undefined;
  return { state, tag, lead, note, leadActions, noteActions, passed, ask };
}

const label = (c: Case) => `${c.verdict} verdict, ${c.kind ? `${c.kind.name} from ${c.from}` : "no refusal"}, ${c.row} row`;
const labels = (html: string) => [...html.matchAll(/>(Add credits|Test again|Budgets|Ask Admin for help)</g)].map((m) => m[1]);

describe("a model's row and its result", () => {
  it(`shows what the one rule says, in all ${cases.length} combinations`, () => {
    expect(cases.length).toBe(3 * 3 * (1 + 7 * 2 + 1));
    for (const c of cases) {
      const e = expected(c);
      const name = label(c);
      // The row: a refusal from the user's own Test is carried by its result in the view.
      const fromTest = c.from === "test";
      const row = render(c, "owner", fromTest);
      expect(row.match(/data-state="([a-z]+)"/)![1], name).toBe(e.state);
      expect([...row.matchAll(/<span class="pill[^"]*">([^<]+)<\/span>/g)].map((m) => m[1]!.replace(/&#39;/g, "'")), name).toEqual(e.tag ? [e.tag] : []);
      const why = row.match(/<span class="meta why">([\s\S]*?) · <button[^>]*>Details<\/button>(?: · <span class="later">([^<]*)<\/span>)?<\/span>/);
      if (e.lead && c.row !== "blocked" && !fromTest) expect([why?.[1], why?.[2]], name).toEqual([esc(e.lead), e.note && esc(e.note)]);
      else expect(why, name).toBeNull();
      // The result under it, for the owner.
      const result = render(c, "owner", true);
      if (e.passed) expect(result, name).toContain("passed.</strong> Tasks can use it.");
      else expect(result, name).not.toContain("passed.</strong>");
      const box = result.match(/<div class="result[^"]*" role="alert">([\s\S]*?)<\/div><\/div><\/li>/)?.[1];
      if (!e.lead) {
        expect(box, name).toBeUndefined();
        continue;
      }
      expect(box!.match(/<strong>([\s\S]*?)<\/strong>/)![1], name).toBe(esc(e.lead));
      const noteHtml = box!.match(/<div class="later"><p>([^<]*)<\/p>([\s\S]*?)(?=<details>|$)/);
      expect(noteHtml?.[1], name).toBe(e.note && esc(e.note));
      const before = noteHtml ? box!.slice(0, box!.indexOf('<div class="later">')) : box!.split("<details>")[0]!;
      expect(labels(before), name).toEqual(e.leadActions);
      expect(noteHtml ? labels(noteHtml[2]!) : [], name).toEqual(e.noteActions);
      // A failed verdict's own fix, and the refusal's, are in Details.
      const det = box!.match(/<details><summary>Details<\/summary>([\s\S]*)<\/details>/)?.[1] ?? "";
      if (e.lead === FAILED.text) expect(det, name).toContain(esc(FAILED.fix!));
      const refusalFixText = c.kind && e.note ? record(c.kind).fix : undefined;
      if (refusalFixText) expect(det, name).toContain(esc(refusalFixText));
      // A friend's Ask Admin sends the refusal just hit, else the lead's
      // reason, and sits in the block whose reason it sends.
      const friend = render(c, "friend", true);
      const asks = [...friend.matchAll(/name="reason" value="([^"]*)"><button[^>]*>Ask Admin for help/g)];
      expect(asks.length, name).toBe(e.ask ? 1 : 0);
      const asked = asks[0];
      if (asked) {
        const noteAt = friend.indexOf('<div class="later">');
        const on = noteAt >= 0 && asked.index! > noteAt ? "note" : "lead";
        expect({ reason: asked[1], on }, name).toEqual(e.ask);
        // The server's model-help form takes every reason a button sends.
        expect(MODEL_HELP_REASONS.has(asked[1]!), name).toBe(true);
      }
    }
  });

  it("never changes the case of a refusal's text in the note", () => {
    const c: Case = { verdict: "failed", kind: KINDS.find((k) => k.reason === "not_connected"), from: "run", row: "open" };
    expect(render(c, "owner", false)).toContain(`Latest test couldn&#39;t run. ${esc(plugin.connect.guide.name)} is not connected.`);
  });
});
