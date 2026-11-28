// A model's strength (its tier: Smallest, Middle or Strongest) is worked out
// from prices, never set by hand: no cap and no setting for a normal model
// (the owner, 2026-11-28: "for other models already having a price (range),
// hum kyu ye cap wali bakwas karein?"), and both the input and the output
// price count ("i have always wanted to include both input ranges and output
// ranges to decide which model should be assigned to which category"). The
// rule is B90 of the 2026-11-28 tier report
// (data/cos-models-tier-ranges/report.md, "Rule B90, exactly"):
//
// - A model's figure, its typical price, is its input and output prices per
//   million tokens blended 10 input to 1 output, `blend`, at the median of
//   its standard-speed OpenRouter hosts that take tools and are up
//   (`figureOf`; the hosts come from OpenRouter's endpoints list, read with
//   the price table, src/prices/refresh.ts).
// - Two lines over every priced model in the app's list that is neither a
//   router nor free (`linesOf`): the 33 1/3rd and the 90th percentile of the
//   figure, each rounded to the nearest step of the ladder ..., $0.10, $0.15,
//   $0.20, $0.30, $0.50, $0.75, $1, $1.50, ... (`ladderStep`). They are
//   worked out again at the first daily refresh of each month and kept for
//   the month, so the same lines hold for every user.
// - Smallest below the lower line, Middle below the upper one, Strongest
//   from it up (`tierOf`). A free model is Smallest. A router keeps the
//   user's price cap, and its figure is the same blend of the cap
//   (`capFigure`); it is never proposed (models/tasks.ts).
//
// Every reader takes the figures and lines stored beside the current price
// snapshot (src/prices/strength.ts), so the model list, the task dropdowns,
// the proposals, the strength chip, the ledger's tier and the price table
// all show the same strength.

export type Tier = "Smallest" | "Middle" | "Strongest";

// Input tokens to each output token in the blend: design-v3's task sizes run
// 5:1 to 23:1, and reasoning models spend output tokens beyond them, so 10:1
// (the report, "Combining input and output").
export const INPUT_PER_OUTPUT = 10;

export const blend = (input: number, output: number): number => (INPUT_PER_OUTPUT * input + output) / (INPUT_PER_OUTPUT + 1);

// One of a model's hosts on OpenRouter, from its endpoints list: its standard
// input and output price per million tokens (the app's standard-price rule,
// prices/openrouter.ts modelPrices), whether it runs at standard speed
// (`service_tier` absent), takes tools and is up (`status` 0).
export interface Host {
  input: number;
  output: number;
  standard: boolean;
  tools: boolean;
  up: boolean;
}

export interface Range {
  min: number;
  max: number;
}

// How a model's figure was found: at the median of its standard tool hosts
// that are up (`hosts`), of its standard tool hosts when none is up
// (`any_host`), or at its headline price, the one price the models API lists,
// because no host is a standard tool host (`no_host`) or its hosts were not
// read (`unread`).
export type Basis = "hosts" | "any_host" | "no_host" | "unread";

export interface Figure {
  usd: number;
  basis: Basis;
  // The hosts the median was taken over, and their input and output prices'
  // ranges; none for a figure at the headline.
  hosts: number;
  input?: Range;
  output?: Range;
  // When the hosts were read (or the headline, for a figure at it).
  readAt: string;
}

export const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

// The p-th percentile, interpolated between the two nearest ranks (numpy's
// default, which the report used).
export function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const at = ((s.length - 1) * p) / 100;
  const lo = Math.floor(at);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

// The steps of the ladder in each power of ten: 1, 1.5, 2, 3, 5 and 7.5 times
// it, so $0.10, $0.15, $0.20, $0.30, $0.50, $0.75, $1, $1.50, $2, ....
const STEPS_PER_DECADE: readonly number[] = [1, 1.5, 2, 3, 5, 7.5];

// The ladder's step nearest to `usd`, by ratio: a line a screen can state,
// which also holds while its percentile drifts a little either way.
export function ladderStep(usd: number): number {
  const decade = Math.floor(Math.log10(usd));
  const steps = [decade - 1, decade, decade + 1].flatMap((k) => STEPS_PER_DECADE.map((s) => Number((s * 10 ** k).toPrecision(12))));
  return steps.reduce((best, s) => (Math.abs(Math.log(usd / s)) < Math.abs(Math.log(usd / best)) ? s : best));
}

// The figure of a model from its hosts, or from its headline price where it
// has no standard tool host or its hosts were not read (`hosts` undefined).
export function figureOf(hosts: readonly Host[] | undefined, headline: { input: number; output: number }, readAt: string): Figure {
  const tools = (hosts ?? []).filter((h) => h.standard && h.tools);
  const up = tools.filter((h) => h.up);
  const counted = up.length ? up : tools;
  if (!counted.length) return { usd: blend(headline.input, headline.output), basis: hosts ? "no_host" : "unread", hosts: 0, readAt };
  const range = (xs: number[]): Range => ({ min: Math.min(...xs), max: Math.max(...xs) });
  return {
    usd: median(counted.map((h) => blend(h.input, h.output))),
    basis: up.length ? "hosts" : "any_host",
    hosts: counted.length,
    input: range(counted.map((h) => h.input)),
    output: range(counted.map((h) => h.output)),
    readAt,
  };
}

// The percentiles the two lines sit at: the cheapest third is Smallest, the
// dearest tenth Strongest (the report, "Decision for the owner").
export const LOWER_PERCENTILE = 100 / 3;
export const UPPER_PERCENTILE = 90;

export interface Lines {
  // Per million tokens of the blended price: Smallest below `lower`, Middle
  // below `upper`, Strongest from `upper` up.
  lower: number;
  upper: number;
  // The percentiles before rounding, and how many models they were drawn over.
  lowerRaw: number;
  upperRaw: number;
  models: number;
  // The month they hold for (YYYY-MM, UTC) and when they were worked out.
  month: string;
  computedAt: string;
}

// The lines over `figures` (every priced model's in the app's list that is
// neither a router nor free); undefined when there is none.
export function linesOf(figures: readonly number[], at: Date): Lines | undefined {
  if (!figures.length) return undefined;
  const lowerRaw = percentile(figures, LOWER_PERCENTILE);
  const upperRaw = percentile(figures, UPPER_PERCENTILE);
  return {
    lower: ladderStep(lowerRaw),
    upper: ladderStep(upperRaw),
    lowerRaw,
    upperRaw,
    models: figures.length,
    month: at.toISOString().slice(0, 7),
    computedAt: at.toISOString(),
  };
}

export const tierOf = (usd: number, lines: Pick<Lines, "lower" | "upper">): Tier => (usd < lines.lower ? "Smallest" : usd < lines.upper ? "Middle" : "Strongest");

// A router's figure: the same blend of the user's price cap.
export const capFigure = (cap: { input: number; output: number }): number => blend(cap.input, cap.output);

// The one tier rule every reader goes by: a free model is Smallest; any other
// takes its figure (a router's from its cap) against the lines; none without
// a figure or lines.
export function modelTier(m: { free?: boolean; figure?: number }, lines: Pick<Lines, "lower" | "upper"> | undefined): Tier | undefined {
  if (m.free) return "Smallest";
  return m.figure === undefined || !lines ? undefined : tierOf(m.figure, lines);
}

// A line in a line of copy: $5, $0.30, $7.50, $0.015.
export const lineUsd = (n: number): string => {
  const [whole, frac] = String(Number(n.toPrecision(12))).split(".");
  return frac === undefined ? `$${whole}` : `$${whole}.${frac.padEnd(2, "0")}`;
};

// What strength is, with the lines in force, under the model table and the
// price table (the report's on-screen sentence).
export function strengthSentence(lines: Pick<Lines, "lower" | "upper"> | undefined, provider: string): string {
  const bands = lines
    ? `Smallest under ${lineUsd(lines.lower)}, Middle under ${lineUsd(lines.upper)}, Strongest ${lineUsd(lines.upper)} and up`
    : "Smallest, Middle or Strongest";
  return `Strength is a model's typical price per million tokens (10 input to 1 output, at its middle ${provider} host): ${bands}, the cheapest third and dearest tenth of ${provider}'s tool-use models, rechecked on the 1st of each month; nobody sets it by hand.`;
}

// The strength chip a model's row shows on Models › Setup › Providers, which
// is also the strength each task's lists on Model for each task go by (the
// owner, 2026-11-27: "when suggested strenght == Smallest --> the dropdown
// next to it should only contain all passing run models tagged with the
// smallest chip"): its tier, or "Other fees" for a model at $0 a token that
// is not free, whose token price says nothing of what it costs.
export type StrengthChip = Tier | "Other fees";

export function strengthChip(m: { tier?: Tier; input?: number; output?: number; free: boolean }): StrengthChip | undefined {
  if (m.input === 0 && m.output === 0 && !m.free) return "Other fees";
  return m.tier;
}
