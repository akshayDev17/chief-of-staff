// Admin · Price table, rendered on the server (design T02 / T11). Owner only:
// the route sits behind the Cloudflare Access check (src/access.ts, T15) that
// every request to the Worker passes first.
//
// One table row per provider, model, deployment type and price: regions that
// share every price are listed together. Provider, Model, Input and Output
// sort (click a header for ascending, again for descending; default provider
// then model); on a phone, where the table stacks, a "Sort by" list offers the
// same choices. Each row carries its model's one tier at that provider
// (tiers.ts), not one worked out from that row's own price.

import { SOURCES } from "./sources";
import type { Snapshot } from "./store";
import { modelTiers, tierKey } from "./tiers";
import type { PriceRow, Provider } from "./types";

export type SortColumn = "provider" | "model" | "input" | "output";
export type SortDir = "asc" | "desc";

const PROVIDER_NAMES: Record<Provider, string> = { openrouter: "OpenRouter" };

export interface DisplayRow {
  provider: Provider;
  model: string;
  deployment: string;
  regions: string[];
  input?: number;
  output?: number;
  cachedInput?: number;
  cacheWrite?: number;
  longInput?: number;
  longOutput?: number;
  batchInput?: number;
  batchOutput?: number;
  sources: string[];
  dateRead: string;
  stale: boolean;
  disagreement: boolean;
}

export function displayRows(rows: PriceRow[]): DisplayRow[] {
  const byLocation = new Map<string, DisplayRow>();
  for (const r of rows) {
    const key = [r.provider, r.model, r.deployment, r.region].join("|");
    let d = byLocation.get(key);
    if (!d) {
      d = { provider: r.provider, model: r.model, deployment: r.deployment, regions: [r.region], sources: [], dateRead: r.dateRead, stale: false, disagreement: false };
      byLocation.set(key, d);
    }
    const field =
      r.batch ? (r.tokenKind === "input" ? "batchInput" : r.tokenKind === "output" ? "batchOutput" : undefined)
      : r.longPrompt ? (r.tokenKind === "input" ? "longInput" : r.tokenKind === "output" ? "longOutput" : undefined)
      : r.tokenKind === "input" ? "input"
      : r.tokenKind === "output" ? "output"
      : r.tokenKind === "cached_input" ? "cachedInput"
      : r.tokenKind === "cache_write" ? "cacheWrite"
      : undefined;
    if (field) d[field] = r.usdPerMTok;
    if (!d.sources.includes(r.source)) d.sources.push(r.source);
    if (r.dateRead < d.dateRead) d.dateRead = r.dateRead;
    d.stale ||= r.stale;
    d.disagreement ||= r.disagreement;
  }
  // Regions that share every price, source and date collapse into one row.
  const grouped = new Map<string, DisplayRow>();
  for (const d of byLocation.values()) {
    const { regions, ...rest } = d;
    const key = JSON.stringify(rest);
    const g = grouped.get(key);
    if (g) g.regions.push(...regions);
    else grouped.set(key, { ...d, regions: [...regions] });
  }
  for (const g of grouped.values()) g.regions.sort();
  return [...grouped.values()];
}

const text = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
// A row with no price sorts last whichever way the column runs.
const num = (a: number | undefined, b: number | undefined, dir: number) =>
  a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : (a - b) * dir;

export function sortRows(rows: DisplayRow[], column: SortColumn, dir: SortDir): DisplayRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const byDefault = (a: DisplayRow, b: DisplayRow) =>
    text(PROVIDER_NAMES[a.provider], PROVIDER_NAMES[b.provider]) || text(a.model, b.model) ||
    text(a.deployment, b.deployment) || text(a.regions[0] ?? "", b.regions[0] ?? "");
  const primary = (a: DisplayRow, b: DisplayRow): number => {
    switch (column) {
      case "provider": return text(PROVIDER_NAMES[a.provider], PROVIDER_NAMES[b.provider]) * sign;
      case "model": return text(a.model, b.model) * sign;
      case "input": return num(a.input, b.input, sign);
      case "output": return num(a.output, b.output, sign);
    }
  };
  return [...rows].sort((a, b) => primary(a, b) || byDefault(a, b));
}

export function parseSort(params: URLSearchParams): { column: SortColumn; dir: SortDir } {
  const raw = params.get("sort") ?? "";
  const [c, d] = raw.split(":");
  const column: SortColumn = c === "model" || c === "input" || c === "output" ? c : "provider";
  return { column, dir: d === "desc" ? "desc" : "asc" };
}

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
// Exact to the vendor's precision: $0.125 stays $0.125, never rounded to $0.13.
const usd = (n: number | undefined) => {
  if (n === undefined) return "–";
  const [whole, frac = ""] = String(Number(n.toPrecision(12))).split(".");
  return `$${whole}.${frac.padEnd(2, "0")}`;
};
export const nbDate = (d: string) => d.replace(/-/g, "&#8209;");

function extras(r: DisplayRow): string {
  const parts: string[] = [];
  if (r.cachedInput !== undefined) parts.push(`cached ${usd(r.cachedInput)}`);
  if (r.cacheWrite !== undefined) parts.push(`cache write ${usd(r.cacheWrite)}`);
  if (r.longInput !== undefined || r.longOutput !== undefined) parts.push(`long prompt ${usd(r.longInput)} / ${usd(r.longOutput)}`);
  if (r.batchInput !== undefined || r.batchOutput !== undefined) parts.push(`batch ${usd(r.batchInput)} / ${usd(r.batchOutput)}`);
  return parts.length ? parts.map(esc).join("<br>") : "–";
}

const SORT_CHOICES: Array<[string, string]> = [
  ["provider:asc", "Provider, then model"],
  ["provider:desc", "Provider (Z to A)"],
  ["model:asc", "Model (A to Z)"],
  ["model:desc", "Model (Z to A)"],
  ["input:asc", "Input price (lowest first)"],
  ["input:desc", "Input price (highest first)"],
  ["output:asc", "Output price (lowest first)"],
  ["output:desc", "Output price (highest first)"],
];

function header(label: string, column: SortColumn, sort: { column: SortColumn; dir: SortDir }): string {
  const on = sort.column === column;
  const next: SortDir = on && sort.dir === "asc" ? "desc" : "asc";
  const ariaSort = on ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
  const arrow = on ? (sort.dir === "asc" ? "▲" : "▼") : "";
  return `<th aria-sort="${ariaSort}"><a class="th-sort" href="?sort=${column}:${next}">${label}<span class="sort-arrow" aria-hidden="true">${arrow}</span></a></th>`;
}

// OpenRouter's own limits page, read and dated; it states no number for paid
// models, and the note says so rather than guessing.
export const RATE_LIMITS = {
  limits:
    "OpenRouter names no default rate limit for paid models (\"We do however have different rate limits for different models\"). Free (:free) models, which a $0 account can use, allow 20 requests a minute and 50 a day (1,000 once $10 of credits are bought).",
  page: "https://openrouter.ai/docs/api_reference/limits.md",
  read: "2026-11-27 (no date on the page)",
};

export interface PageInput {
  snapshot: Snapshot | undefined;
  rows: PriceRow[];
  alerts: Array<{ createdAt: string; kind: string; detail: string }>;
  sort: { column: SortColumn; dir: SortDir };
}

function refreshBanner(snapshot: Snapshot | undefined): string {
  if (!snapshot) return `<div class="banner warn"><strong>No refresh yet.</strong> Every model shows "no price yet" until the first refresh.</div>`;
  const when = snapshot.takenAt.slice(0, 16).replace("T", " ") + " UTC";
  const parts = snapshot.results.map((r) => {
    const name = SOURCES[r.source].label;
    return r.ok
      ? `${esc(name)}: ok (${r.rows} rows, ${r.added} added and ${r.dropped} dropped against the previous snapshot${r.unmapped ? `, ${r.unmapped} listed models that cannot be chosen, so have no price rows` : ""})`
      : `${esc(name)}: <strong>failed</strong> (${esc(r.error ?? "")}; rows keep their last good price and date; the maintainers were alerted)`;
  });
  const failed = snapshot.results.some((r) => !r.ok);
  return `<div class="banner ${failed ? "warn" : "ok"}" role="status"><strong>Last refresh ${esc(when)}:</strong><ul>${parts.map((p) => `<li>${p}</li>`).join("")}</ul></div>`;
}

export function renderPriceTablePage(input: PageInput): string {
  const rows = sortRows(displayRows(input.rows), input.sort.column, input.sort.dir);
  const tiers = modelTiers(input.rows);
  const body = rows
    .map((r) => {
      const tier = tiers.get(tierKey(r.provider, r.model)) ?? "–";
      const source = r.sources.map((s) => esc(SOURCES[s as keyof typeof SOURCES]?.label ?? s)).join("; ");
      const flags = [
        r.stale ? `<span class="pill warn">refresh failed: last good price kept</span>` : "",
        r.disagreement ? `<span class="pill warn">sources disagree: higher price kept</span>` : "",
      ].join(" ");
      return `<tr>
<td data-l="Provider">${PROVIDER_NAMES[r.provider]}</td>
<td data-l="Model">${esc(r.model)}</td>
<td data-l="Input / M">${r.input === undefined ? `<span class="pill warn">no price yet</span>` : usd(r.input)}</td>
<td data-l="Output / M">${usd(r.output)}</td>
<td data-l="Cached, cache write, long prompt, batch / M">${extras(r)}</td>
<td data-l="Strength (from the input price)">${tier}</td>
<td data-l="Source">${source}</td>
<td data-l="Date read">${nbDate(r.dateRead)} ${flags}</td>
</tr>`;
    })
    .join("\n");
  const options = SORT_CHOICES.map(
    ([v, l]) => `<option value="${v}"${v === `${input.sort.column}:${input.sort.dir}` ? " selected" : ""}>${l}</option>`,
  ).join("");
  const alerts = input.alerts.length
    ? `<section class="card"><h2>Alerts for the maintainers</h2><ul>${input.alerts
        .map((a) => `<li><span class="pill warn">${esc(a.kind.replace(/_/g, " "))}</span> ${nbDate(a.createdAt.slice(0, 10))}: ${esc(a.detail)}</li>`)
        .join("")}</ul></section>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin · Price table · Chief of staff</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="screen">
<h1>Admin</h1>
<h2>Price table</h2>
${refreshBanner(input.snapshot)}
<form class="sort-by" method="get">
<label class="small" for="price-sort">Sort by</label>
<select id="price-sort" name="sort" onchange="this.form.submit()">${options}</select>
<noscript><button type="submit">Sort</button></noscript>
</form>
<div class="tbl-wrap"><table class="stackable" id="price-tbl">
<thead><tr>
${header("Provider", "provider", input.sort)}
${header("Model", "model", input.sort)}
${header("Input / M", "input", input.sort)}
${header("Output / M", "output", input.sort)}
<th>Cached, cache write, long prompt, batch / M</th>
<th>Strength (from the input price)</th>
<th>Source</th>
<th>Date read</th>
</tr></thead>
<tbody>
${body || `<tr><td colspan="8">No prices yet.</td></tr>`}
</tbody></table></div>
<p class="small muted">Prices are OpenRouter's list prices in USD per million tokens, from its models API. OpenRouter routes each call itself, so every row is global. Where OpenRouter prices a model higher above a prompt length or at some times of day, the long-prompt column and the standard columns show the dearest of those prices: a call is costed from this table only when OpenRouter's reply reports no cost, and then never below what OpenRouter can charge. Each model's strength comes from its standard input price: Smallest under $0.50, Middle $0.50 to under $2.50, Strongest $2.50 and up; nobody sets it by hand.</p>
${alerts}
<section class="card"><h2>Rate limits, beside the table</h2>
<p class="small">${esc(RATE_LIMITS.limits)} <a href="${esc(RATE_LIMITS.page)}">${esc(new URL(RATE_LIMITS.page).hostname)}</a>, read ${esc(RATE_LIMITS.read)}.</p></section>
</main>
</body>
</html>`;
}

// The shell's server-rendered pages share these styles.
export const PAGE_CSS = `
:root { color-scheme: light dark; --bg: #f7f5f0; --card: #ffffff; --text: #1d1b18; --muted: #6b665d; --line: #d9d4c9;
  --accent: #2f5d8a; --warn: #8a5a00; --warn-soft: #fbefd5; --ok: #2d6a3e; --ok-soft: #e3f1e6; }
@media (prefers-color-scheme: dark) { :root { --bg: #171614; --card: #201f1c; --text: #ece8e1; --muted: #a39d92; --line: #3a3732;
  --accent: #8db7e0; --warn: #f0c46c; --warn-soft: #3a2f17; --ok: #8fd19e; --ok-soft: #1d3324; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 Georgia, "Iowan Old Style", serif; }
.screen { max-width: 1280px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.5rem; margin: 0 0 8px; } h2 { font-size: 1.15rem; margin: 16px 0 8px; }
a { color: var(--accent); }
.small { font-size: .85rem; } .muted { color: var(--muted); }
.banner { border-radius: 10px; padding: 10px 14px; border: 1px solid var(--line); background: var(--card); margin: 8px 0; }
.banner ul { margin: 4px 0 0; padding-left: 20px; }
.banner.warn { background: var(--warn-soft); border-color: var(--warn); }
.banner.ok { background: var(--ok-soft); border-color: var(--ok); }
.pill { display: inline-block; padding: 2px 9px; border-radius: 8px; font-size: .78rem; background: var(--warn-soft); color: var(--warn); line-height: 1.3; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 4px 14px 14px; margin-top: 16px; }
.tbl-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 7px 10px; border-bottom: 1px solid var(--line); }
th { font-size: .82rem; color: var(--muted); font-weight: 600; }
td[data-l="Input / M"], td[data-l="Output / M"] { white-space: nowrap; font-variant-numeric: tabular-nums; }
.th-sort { white-space: nowrap; color: inherit; text-decoration: none; display: inline-flex; gap: 4px; align-items: center; }
.th-sort:hover { color: var(--accent); }
.th-sort:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.sort-arrow { font-size: .7em; color: var(--accent); min-width: .8em; }
.sort-arrow:empty::after { content: "↕"; color: var(--muted); opacity: .55; }
.sort-by { display: none; gap: 8px; align-items: center; margin: 8px 0; }
.sort-by select { font: inherit; padding: 4px 6px; max-width: 16em; }
@media (max-width: 759px) {
  .sort-by { display: flex; }
  table.stackable thead { display: none; }
  table.stackable, table.stackable tbody, table.stackable tr, table.stackable td { display: block; width: 100%; }
  table.stackable tr { border-bottom: 1px solid var(--line); padding: 6px 0; }
  table.stackable td { border: 0; padding: 3px 12px; }
  table.stackable td::before { content: attr(data-l); display: block; font-size: .75rem; color: var(--muted); font-weight: 600; }
}
`;

// Form controls, sub-tabs and buttons, shared by the Models › Setup pages.
export const CONTROLS_CSS = `
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.subtabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
.subtabs > span { padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; font-size: .85rem; background: var(--card); }
.subtabs > span.on { border-color: var(--accent); }
.subtabs > span[aria-disabled] { color: var(--muted); }
.btn { display: inline-flex; align-items: center; font: inherit; font-weight: 500; font-size: .9rem; padding: 4px 10px; min-height: 30px;
  border-radius: 10px; border: 1px solid var(--accent); background: var(--accent); color: var(--card); cursor: pointer; text-decoration: none; }
.btn.secondary { background: var(--card); color: var(--accent); }
.btn:focus-visible, input.f:focus-visible, select.f:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input.f, select.f { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--text); width: 100%; }
.ok-line { color: var(--ok); font-weight: 500; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;
