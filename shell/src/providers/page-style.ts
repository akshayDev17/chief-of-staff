// The stylesheet of Models › Setup › Providers: the approved mockup's
// achromatic ledger (design-taste app sheet) on the app's own palette and
// type (Georgia, the stone ground, the one blue accent), with a dark theme.
// Grid at 1440: column 1152 = list 792 + rail 360.

import { MAKER_FILTER_CSS } from "../models/maker-filter";

export const PAGE_STYLE = `
:root {
  color-scheme: light dark;
  --ground: #f6f5f3; --surface: #ffffff; --raised: #f8f7f5; --active: #ecebe7;
  --border: #e9e7e2; --rule: #f0eeea; --control: #cdc9c1; --control-hover: #a9a49a;
  --text: #1d1b18; --muted: #66615a; --faint: #6b665d; --disabled-ink: #8f897f;
  --accent: #2f5d8a; --accent-line: #b9c9da;
  --primary: #2f5d8a; --primary-hover: #274f76; --primary-ink: #ffffff;
  --positive: #2d6a3e; --pill-positive-bg: #e3f1e6; --pill-positive-ink: #1f4d2c;
  --negative: #a32323; --danger-line: #e3b7b7; --pill-negative-bg: #fbe4e4; --pill-negative-ink: #7d1d1d;
  --pill-warning-bg: #fbefd5; --pill-warning-ink: #74490a; --caution: #a86b12;
  --pill-neutral-bg: #efede9; --pill-neutral-ink: #4a463f; --chip-hover: #e2e0db;
  --mark: #f6e7b0; --shadow: rgba(29, 27, 24, .14);
  --font: Georgia, "Iowan Old Style", serif;
  --figures: "Iowan Old Style", Georgia, serif;
  --fs-title: 24px; --fs-h2: 18px; --fs-body: 15px; --fs-small: 13px;
  --radius-card: 8px; --radius-control: 6px; --radius-chip: 4px;
  --card-pad: 20px; --control-h: 36px; --row-h: 54px; --t: 150ms;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #171614; --surface: #201f1c; --raised: #262522; --active: #302e2a;
    --border: #3a3732; --rule: #2d2b27; --control: #4d4943; --control-hover: #6e695f;
    --text: #ece8e1; --muted: #a39d92; --faint: #9a9489; --disabled-ink: #7d776d;
    --accent: #8db7e0; --accent-line: #3e5872;
    --primary: #3a6b9c; --primary-hover: #447aaf; --primary-ink: #ffffff;
    --positive: #8fd19e; --pill-positive-bg: #1d3324; --pill-positive-ink: #a8e0b5;
    --negative: #f3a6a6; --danger-line: #6b3636; --pill-negative-bg: #3a1f1f; --pill-negative-ink: #f5bcbc;
    --pill-warning-bg: #3a2f17; --pill-warning-ink: #f0c46c; --caution: #e0b35a;
    --pill-neutral-bg: #302e2a; --pill-neutral-ink: #d6d1c8; --chip-hover: #3a3833;
    --mark: #5a4a12; --shadow: rgba(0, 0, 0, .5);
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--ground); color: var(--text); font: var(--fs-body)/1.45 var(--font); }
h1, h2, h3, p, ul, ol { margin: 0; }
ul { padding: 0; list-style: none; }
button, input { font: inherit; color: inherit; }
button { cursor: pointer; }
a { color: var(--accent); }
[hidden] { display: none !important; }
.num { font-family: var(--figures); font-variant-numeric: tabular-nums lining-nums; }
.small { font-size: var(--fs-small); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
form.inline { display: contents; }

.screen { max-width: 1200px; margin: 0 auto; padding: 32px 24px 96px; }
.title-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h1 { font-size: var(--fs-title); line-height: 32px; font-weight: 700; }
.subtabs { display: inline-flex; background: var(--active); border-radius: var(--radius-control); padding: 3px; gap: 2px; }
.subtabs span, .subtabs a { padding: 4px 14px; border-radius: 4px; font-size: var(--fs-small); line-height: 20px; color: var(--muted); text-decoration: none; }
.subtabs .on { background: var(--surface); color: var(--text); }
.subtabs a:hover { color: var(--text); }
.subtabs a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tabs { display: flex; gap: 28px; margin-top: 18px; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none; }
.tabs a, .tabs span { padding: 10px 0 9px; font-size: var(--fs-body); color: var(--muted); white-space: nowrap; border-bottom: 2px solid transparent; margin-bottom: -1px; text-decoration: none; }
.tabs a:hover { color: var(--text); }
.tabs [aria-current] { color: var(--text); font-weight: 700; border-bottom-color: var(--text); }
.banner { margin-top: 20px; padding: 12px 14px; border-radius: var(--radius-card); border: 1px solid var(--border); background: var(--surface); font-size: 14px; }
.banner.warn { background: var(--pill-warning-bg); color: var(--pill-warning-ink); border-color: transparent; }
.banner.ok { background: var(--pill-positive-bg); color: var(--pill-positive-ink); border-color: transparent; }
.banner details { margin-top: 6px; }

.block { margin-top: 40px; }
.block-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
h2 { font-size: var(--fs-h2); line-height: 26px; font-weight: 700; }
.sub { color: var(--muted); font-size: var(--fs-body); }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card); }
.pane { min-width: 0; }

.provider { padding: 18px var(--card-pad); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 24px; align-items: center; }
.provider h3 { font-size: 16px; line-height: 24px; font-weight: 700; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.provider .lines { grid-column: 1; display: grid; gap: 2px; font-size: var(--fs-small); color: var(--muted); }
.provider .lines strong { color: var(--text); font-weight: 400; }
.provider .lines ol { padding-left: 18px; display: grid; gap: 2px; color: var(--text); }
.provider .acts { grid-column: 2; grid-row: 1 / span 2; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.provider .confirm { grid-column: 1 / -1; margin-top: 10px; }
.provider details { grid-column: 1 / -1; font-size: var(--fs-small); }
.ext { white-space: nowrap; }
.ext::after { content: " \\2197"; }

.pill { display: inline-flex; flex: none; align-items: center; height: 22px; padding: 0 8px; border-radius: var(--radius-chip); font-size: 12px; line-height: 1; font-weight: 400; white-space: nowrap; background: var(--pill-neutral-bg); color: var(--pill-neutral-ink); }
.pill.ok { background: var(--pill-positive-bg); color: var(--pill-positive-ink); }
.pill.warn { background: var(--pill-warning-bg); color: var(--pill-warning-ink); }
.pill.bad { background: var(--pill-negative-bg); color: var(--pill-negative-ink); }
.pill.free { background: var(--pill-positive-bg); color: var(--pill-positive-ink); font-weight: 700; }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: var(--control-h); padding: 0 14px; border-radius: var(--radius-control); border: 1px solid var(--control); background: var(--surface); color: var(--text); font-size: 14px; line-height: 1.2; text-decoration: none; white-space: nowrap; transition: background-color var(--t), border-color var(--t), transform 120ms; }
.btn:hover { border-color: var(--control-hover); }
.btn:active { transform: translateY(1px); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-ink); }
.btn.primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
.btn[disabled], .btn[aria-disabled="true"] { cursor: not-allowed; transform: none; color: var(--muted); border-color: var(--border); background: var(--raised); }
.btn.wide { width: 100%; white-space: normal; text-align: center; padding: 8px 14px; }
.btn.small { min-height: 32px; padding: 0 12px; font-size: 13px; }
.btn.danger-o { color: var(--negative); border-color: var(--danger-line); }
.btn.danger-o:hover { border-color: var(--negative); }
.link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; text-underline-offset: 2px; font-size: inherit; }
.link.danger { color: var(--negative); }
.link[disabled] { color: var(--muted); text-decoration: none; cursor: default; }

.toolbar { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; flex-wrap: wrap; }
.search { position: relative; flex: 0 1 340px; min-width: 0; }
.search svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); width: 15px; height: 15px; color: var(--muted); pointer-events: none; }
.search input { width: 100%; height: var(--control-h); padding: 0 34px; border: 1px solid var(--control); border-radius: var(--radius-control); background: var(--surface); font-size: 14px; }
.search input::placeholder { color: var(--faint); }
.search input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); } /* taste-skill-ignore: focus ring, not a shadow */
.search input::-webkit-search-cancel-button { display: none; }
.search .clear-x { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 28px; height: 28px; border: 0; background: none; border-radius: 4px; color: var(--muted); display: none; align-items: center; justify-content: center; }
.search.has-q .clear-x { display: inline-flex; }
.search .clear-x:hover { background: var(--active); }
.count { margin-left: auto; font-size: var(--fs-small); color: var(--muted); white-space: nowrap; }
.count b { color: var(--text); font-weight: 400; }

${MAKER_FILTER_CSS}
.chips { padding: 0 16px 10px; }

.strip-wrap { padding: 2px 16px 14px; }
/* One container split by 1px seams (the border colour showing through the gap). */
.strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: var(--radius-card); overflow: hidden; }
.cell { display: grid; gap: 2px; text-align: left; padding: 10px 12px 9px; background: var(--surface); border: 0; border-bottom: 2px solid transparent; width: 100%; height: 100%; }
.cell:hover { background: var(--raised); }
/* Needs credit: the cell, with Add credits on its own line under the value
   (the row's other cells grow with it). */
.cellx { position: relative; display: grid; }
.cellx .cell:has(+ .cell-act:not([hidden])) { padding-bottom: 31px; }
.cell-act { position: absolute; left: 12px; bottom: 11px; font-size: var(--fs-small); line-height: 18px; text-decoration: none; }
.cell-act:hover { text-decoration: underline; }
.cell .l { font-size: var(--fs-small); color: var(--muted); line-height: 18px; white-space: nowrap; }
.cell .v { font-size: 24px; line-height: 30px; color: var(--text); }
.cell .v.good { color: var(--positive); }
.cell .v.bad { color: var(--negative); }
.cell .v.warn { color: var(--caution); }
.cell[aria-pressed="true"] { border-bottom-color: var(--text); }
.cell[aria-pressed="true"] .l { color: var(--text); }
[data-part="strip"][aria-busy="true"], [data-part="rows"][aria-busy="true"] { opacity: 0.45; cursor: progress; transition: opacity 120ms; }
.bar { margin-top: 10px; height: 8px; border-radius: 999px; background: var(--active); display: flex; overflow: hidden; }
.bar i { display: block; height: 100%; transition: width 200ms linear; }
.bar i.w { background: var(--positive); }
.bar i.c { background: var(--caution); }
.bar i + i { border-left: 2px solid var(--surface); }
.bar i[style^="width:0.000"] { border-left: 0; }
.ends { display: flex; justify-content: space-between; margin-top: 4px; font-size: 12px; color: var(--muted); }

.list-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--border); font-size: var(--fs-small); color: var(--muted); }
.list-head .src { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.list-head .src .link { font-size: 13px; }
.list-head .n { display: none; }
.list-head .unit { white-space: nowrap; text-align: right; margin-right: 116px; }
.err { margin: 12px 16px 0; padding: 12px 14px; border-radius: var(--radius-card); background: var(--raised); border: 1px solid var(--border); display: flex; gap: 10px; align-items: flex-start; font-size: 14px; }
.err > svg { flex: none; width: 16px; height: 16px; color: var(--negative); margin-top: 2px; }
.err > div { flex: 1; display: grid; gap: 4px; }
.tbl-box { position: relative; max-height: calc(var(--row-h) * 10 + 12px); overflow-y: auto; scroll-padding-top: 4px; padding: 4px 8px 8px; outline: none; }
.tbl-box:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); } /* taste-skill-ignore: focus ring */
.row { display: grid; grid-template-columns: minmax(0, 1fr) auto 100px; gap: 2px 16px; align-items: center; min-height: var(--row-h); padding: 7px 8px; border-bottom: 1px solid var(--rule); }
.rows > .row:last-child { border-bottom: 0; }
.row[data-blocked] .nm { color: var(--muted); }
.nm { grid-column: 1; grid-row: 1; font-size: var(--fs-body); line-height: 20px; display: flex; align-items: center; gap: 8px; min-width: 0; }
.nm .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { grid-column: 1; font-size: var(--fs-small); line-height: 18px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta .link { font-size: 13px; }
.meta.capped { display: flex; }
.meta.capped .clip { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.meta.capped .cg { flex: none; white-space: pre; }
.meta.why { color: var(--text); white-space: normal; } /* the reason and its Details link always show whole */
.meta.left { white-space: normal; } /* the settings link and Check again always show whole */
.meta.left .link { white-space: nowrap; }
.meta.why .fw { color: var(--negative); } /* Failed when used: the one red word on the row */
.price { grid-column: 2; grid-row: 1; text-align: right; font-size: 14px; white-space: nowrap; }
.tier { grid-column: 2; grid-row: 2; text-align: right; font-size: var(--fs-small); line-height: 18px; color: var(--muted); white-space: nowrap; }
.capcell { grid-row: 1 / span 2; align-self: center; }
.capbtn { gap: 6px; padding: 0 10px; }
.capbtn svg { width: 13px; height: 13px; flex: none; }
.dash { color: var(--muted); }
mark { background: var(--mark); color: inherit; border-radius: 2px; }
.acts-row { grid-column: 3; grid-row: 1 / span 2; display: flex; justify-content: flex-end; align-items: center; gap: 6px; }
.tbtn { min-height: 32px; padding: 0 12px; font-size: 13px; }
.tbtn .ico { display: none; }
.tbtn .ico svg { width: 13px; height: 13px; display: block; }
.more { grid-column: 1 / -1; margin: 6px 0 2px; }
.det { padding: 8px 10px; background: var(--raised); border-radius: 6px; font-size: var(--fs-small); color: var(--muted); display: grid; gap: 4px; overflow-wrap: anywhere; }
.empty { margin: 8px; padding: 18px 16px; border: 1px dashed var(--control); border-radius: var(--radius-card); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.empty p { flex: 1 1 220px; }
.list-foot { padding: 10px 16px 14px; border-top: 1px solid var(--rule); font-size: var(--fs-small); color: var(--muted); }
details > summary { cursor: pointer; color: var(--accent); width: fit-content; font-size: var(--fs-small); }
.list-foot ul { margin-top: 8px; padding-left: 18px; list-style: disc; display: grid; gap: 4px; }

.result { padding: 12px 14px; border-radius: var(--radius-card); background: var(--raised); border: 1px solid var(--border); font-size: 14px; display: grid; gap: 8px; }
.result .v { display: flex; gap: 8px; align-items: flex-start; }
.result .v svg { flex: none; width: 16px; height: 16px; margin-top: 2px; }
.result.ok .v svg { color: var(--positive); }
.result.bad .v svg { color: var(--negative); }
.result.warn .v svg { color: var(--pill-warning-ink); }
.result .hide { margin-left: auto; font-size: 13px; }
.result .acts { display: flex; gap: 8px; flex-wrap: wrap; }
.result details p { margin-top: 6px; font-size: var(--fs-small); color: var(--muted); overflow-wrap: anywhere; }
.spin { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.capbox { padding: 12px 14px; border-radius: var(--radius-card); background: var(--raised); border: 1px solid var(--border); display: grid; gap: 10px; font-size: 14px; }
.capbox form { display: grid; gap: 10px; }
.capf { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; }
.capf label { display: inline-flex; align-items: center; gap: 6px; }
.capf input { width: 86px; height: 34px; padding: 0 8px; border: 1px solid var(--control); border-radius: var(--radius-control); background: var(--surface); font-family: var(--figures); font-variant-numeric: tabular-nums lining-nums; font-size: 14px; }
.capf input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); } /* taste-skill-ignore: focus ring */
.capf .u { color: var(--muted); font-size: 13px; }
.capbox .acts { display: flex; gap: 12px; align-items: center; }
.cap-err { color: var(--negative); font-size: 13px; }

.stale { margin: 12px 16px 0; padding: 10px 12px 10px 14px; border-radius: var(--radius-card); background: var(--raised); border: 1px solid var(--border); font-size: 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; }
.confirm { padding: 12px 14px; border-radius: var(--radius-card); background: var(--raised); border: 1px solid var(--border); display: grid; gap: 8px; font-size: 14px; }
.confirm .why { font-size: var(--fs-small); color: var(--muted); }
.confirm .acts { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.next-row { margin-top: 40px; display: flex; justify-content: flex-end; }

@media (max-width: 640px) {
  .screen { padding: 20px 16px 72px; }
  .title-row { flex-wrap: wrap; }
  .tabs { gap: 14px; margin-top: 14px; }
  .tabs a, .tabs span { font-size: 13px; }
  .list-head .w { display: none; }
  .list-head .n { display: inline; }
  .list-head .unit { margin-right: 0; }
  .block { margin-top: 32px; }
  .block-head { display: grid; gap: 2px; }
  .provider { grid-template-columns: minmax(0, 1fr); padding: 16px; }
  .provider .acts { grid-column: 1; grid-row: auto; margin-top: 8px; justify-content: flex-start; }
  .toolbar { padding: 12px 12px 8px; }
  .search { flex: 1 1 100%; order: 1; }
  .maker { order: 2; }
  .count { order: 3; }
  .chips { padding: 0 12px 10px; }
  .list-head { padding: 8px 12px; }
  .strip-wrap { padding: 2px 12px 12px; }
  .tbl-box { max-height: calc(64px * 6.5); padding: 4px 4px 6px; }
  .row { grid-template-columns: minmax(0, 1fr) auto; }
  .row .tier { display: none; }
  .acts-row { grid-column: 2; grid-row: 2; gap: 4px; }
  .price.capcell { grid-row: 1; }
  .tbtn { width: 32px; min-height: 32px; padding: 0; }
  .tbtn .lbl { display: none; }
  .tbtn .ico { display: inline-flex; }
  .next-row { justify-content: stretch; }
  .next-row .btn { width: 100%; }
  .err, .stale { margin: 10px 12px 0; }
}
@media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } .bar i, .btn { transition: none; } }
`;

// Without scripts: no search or filters (they need the script), every
// failure's details open, and Check again beside every settings link.
export const NOSCRIPT_STYLE = `.toolbar, .chips { display: none !important; } [data-det-panel][hidden] { display: grid !important; } form[data-check-for][hidden] { display: contents !important; } a[data-allow] + form[data-check-for]::before { content: " · "; } [data-det] { display: none; }`;
