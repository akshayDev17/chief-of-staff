// Where the app lives: every page and API path is under one
// path on akshayprabhakant.com, set up by the portfolio-app tool (README
// "Cloudflare Access"). The Worker route is `akshayprabhakant.com/chief-of-staff*`
// (wrangler.jsonc), which also matches sibling paths such as
// `/chief-of-staff.html` or `/chief-of-staffx`; those are not the app's and
// go to the origin untouched (index.ts).
//
// Every absolute path the Worker serves or renders is built from BASE_PATH
// here, so the prefix is written once.

export const BASE_PATH = "/chief-of-staff";

// `/chief-of-staff` itself or anything under `/chief-of-staff/`; never a
// sibling such as `/chief-of-staffx`.
export const isAppPath = (pathname: string): boolean => pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`);

// The app's home: `/chief-of-staff` and `/chief-of-staff/`.
export const isHomePath = (pathname: string): boolean => pathname === BASE_PATH || pathname === `${BASE_PATH}/`;

export const HEALTH_PATH = `${BASE_PATH}/health`;
export const PRICE_TABLE_PATH = `${BASE_PATH}/admin/price-table`;
export const PROVIDERS_PATH = `${BASE_PATH}/models/setup/providers`;
export const BUDGETS_PATH = `${BASE_PATH}/models/setup/budgets`;
export const ADD_MODEL_PATH = `${BASE_PATH}/models/setup/add`;
export const TASK_MODELS_PATH = `${BASE_PATH}/models/setup/tasks`;
export const USAGE_PATH = `${BASE_PATH}/models/usage`;
