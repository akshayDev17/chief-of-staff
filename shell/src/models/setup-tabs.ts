// Models › Setup's three screens, in the order of their tabs, which is also
// the setup checklist's order (design-v3 11.6: provider and models, then the
// budget) and the order of each screen's Next button (the owner,
// 2026-11-27). Every screen's tab line and its Next button come from this one
// list, so the two cannot drift apart.
//
//   modelsSubtabs(on) -> HTML      the Models tab's two sub-tabs, Setup and Usage
//   setupTabsLine(path) -> HTML    the tab line, the current screen in bold
//   nextAction(path, cls) -> HTML  "Next: <the next screen>"
//
// After the last screen comes the checklist's next item, Connect Gmail (item
// 6, on Job application settings), which is not built yet: its Next names it
// and leads nowhere.

import { BUDGETS_PATH, PROVIDERS_PATH, TASK_MODELS_PATH, USAGE_PATH } from "../paths";

export interface SetupTab {
  // The tab's own label.
  label: string;
  // How a Next button names it: "Next: <nextName>".
  nextName: string;
  href: string;
}

export const SETUP_TABS: readonly SetupTab[] = [
  { label: "Providers and models", nextName: "providers and models", href: PROVIDERS_PATH },
  { label: "Budgets", nextName: "budgets", href: BUDGETS_PATH },
  { label: "Model for each task", nextName: "the model for each task", href: TASK_MODELS_PATH },
];

// The setup checklist's item after the Models tab's (design-v3 11.6, item 6).
export const AFTER_SETUP_TABS = { nextName: "Connect Gmail", built: false } as const;

// The Models tab has exactly two sub-tabs (design-v3 10.1, the owner,
// 2026-11-24: "within models, create 2 sub tabs: setup and usage."). Setup
// opens its first screen.
export function modelsSubtabs(on: "setup" | "usage"): string {
  const tab = (id: "setup" | "usage", label: string, href: string) =>
    id === on ? `<span class="on" aria-current="page">${label}</span>` : `<a href="${href}">${label}</a>`;
  return `<nav class="subtabs" aria-label="Models">${tab("setup", "Setup", SETUP_TABS[0]!.href)}${tab("usage", "Usage", USAGE_PATH)}</nav>`;
}

export function setupTabsLine(path: string): string {
  return `<nav class="small setup-tabs" aria-label="Models setup" style="margin:-4px 0 10px">${SETUP_TABS.map((t) =>
    t.href === path ? `<strong aria-current="page">${t.label}</strong>` : `<a href="${t.href}">${t.label}</a>`,
  ).join(" · ")}</nav>`;
}

// The Next button of the screen at `path`: the next tab, or after the last
// one the checklist's next item, named but not linked while it is not built.
export function nextAction(path: string, cls = "btn"): string {
  const at = SETUP_TABS.findIndex((t) => t.href === path);
  const next = SETUP_TABS[at + 1];
  if (next) return `<a class="${cls}" href="${next.href}" data-next>Next: ${next.nextName}</a>`;
  return `<span class="${cls}" aria-disabled="true" data-next>Next: ${AFTER_SETUP_TABS.nextName} (not built yet)</span>`;
}
