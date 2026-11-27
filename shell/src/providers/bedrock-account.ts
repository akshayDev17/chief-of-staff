// Bedrock's "Refresh model list" on the Connect screen: Bedrock's own model
// list read again now, and what the user's own AWS account says of the
// models it offers, so each entry of the model list can say what a pick will
// meet before the user picks it.
//
//   refreshBedrockModels(db, plugins, { userId, readCatalog, now }) -> problem | undefined
//   readAccountCheck(db, userId) -> AccountCheck | undefined
//   readAccountStates(fetcher, credentials, region, now, modelIds) -> AccountStates
//   accessNotes(model, check) -> string[]      the entry's notes
//
// Three reads:
// (a) The model list (ListFoundationModels, ListInferenceProfiles) with the
//     app's own role, as the daily refresh reads it (bedrock-catalog.ts), kept
//     with the current price snapshot; read at most once a minute for all
//     users, since it is the owner's list either way.
// (b) Each offered Marketplace-sold model's state in the user's own account,
//     GetFoundationModelAvailability, `GET /foundation-model-availability/{modelId}`:
//     agreementAvailability.status (AVAILABLE | PENDING | NOT_AVAILABLE |
//     ERROR), authorizationStatus (AUTHORIZED | NOT_AUTHORIZED),
//     entitlementAvailability and regionAvailability (AVAILABLE | NOT_AVAILABLE).
//     https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModelAvailability.html
//     Models AWS sells itself need no agreement, so they are not read. Live
//     on the owner's account (2026-11-27): Claude Haiku 4.5 read
//     NOT_AVAILABLE and AUTHORIZED, and its first call accepted the terms by
//     itself; xAI's Grok read all AVAILABLE yet its calls are refused, which
//     only a test call shows. So none of these states blocks a pick.
// (c) Anthropic's one-time use-case form for the account, GetUseCaseForModelAccess,
//     `GET /use-case-for-model-access`: 200 with `formData` once it was filled;
//     the owner's account, never filled, answered "You have not filled out
//     the request form."
//     https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetUseCaseForModelAccess.html
// (b) and (c) run as the user's own role, which may make them from template
// 1.2.0 (bedrock:GetFoundationModelAvailability and
// bedrock:GetUseCaseForModelAccess, both Read with no resource type in the
// service authorization reference,
// https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html,
// read 2026-11-27). An older stack's role is refused them: each state is
// "unknown", with a note to update the stack, never an error.
//
// One refresh per user a minute. A Worker request makes a bounded number of
// subrequests, so (b) reads at most MAX_MODEL_READS models, a few at a time.

import { currentSnapshot, readStoredBedrockCatalog, saveBedrockCatalog } from "../prices/store";
import { readConnection } from "../proxy/connections";
import type { PluginRegistry } from "../proxy/plugin";
import { readCheck } from "./check";
import { signV4, withoutHost, type AwsCredentials } from "./aws";
import { olderTemplate, STACK_NAME } from "./bedrock";
import { readBedrockOffer, REVIEWED, type BedrockCatalog, type CatalogRead, type ReviewedModels } from "./bedrock-catalog";

// The first template whose role can read the account's model states.
export const ACCOUNT_CHECKS_SINCE = "1.2.0";
export const REFRESH_SECONDS = 60;
export const MAX_MODEL_READS = 32;
const CONCURRENT_READS = 4;

export type FormState = "filled" | "not_filled" | "unknown";

export interface ModelAccess {
  agreement?: string;
  authorization?: string;
  entitlement?: string;
  region?: string;
}

export interface AccountStates {
  form: FormState;
  // Keyed by the price table's model name.
  models: Record<string, ModelAccess | "unknown">;
  // The role was refused the reads: a stack older than 1.2.0.
  denied: boolean;
}

export interface AccountCheck {
  checkedAt: string;
  form: FormState;
  models: Record<string, ModelAccess | "unknown">;
  note?: string;
  catalogError?: string;
}

interface AccountCheckRecord {
  checked_at: string;
  form: FormState;
  models: string;
  note: string | null;
  catalog_error: string | null;
}

export async function readAccountCheck(db: D1Database, userId: string): Promise<AccountCheck | undefined> {
  const r = await db.prepare("SELECT * FROM bedrock_account_checks WHERE user_id = ?").bind(userId).first<AccountCheckRecord>();
  return r
    ? { checkedAt: r.checked_at, form: r.form, models: JSON.parse(r.models) as AccountCheck["models"], note: r.note ?? undefined, catalogError: r.catalog_error ?? undefined }
    : undefined;
}

async function saveAccountCheck(db: D1Database, userId: string, c: AccountCheck): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bedrock_account_checks (user_id, checked_at, form, models, note, catalog_error) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (user_id) DO UPDATE SET checked_at = excluded.checked_at, form = excluded.form, models = excluded.models,
         note = excluded.note, catalog_error = excluded.catalog_error`,
    )
    .bind(userId, c.checkedAt, c.form, JSON.stringify(c.models), c.note ?? null, c.catalogError ?? null)
    .run();
}

export async function deleteAccountCheck(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM bedrock_account_checks WHERE user_id = ?").bind(userId).run();
}

// Whether Bedrock sells the model through AWS Marketplace: every provider
// but those Bedrock's model-access page names, and the exceptions it names
// (bedrock-models.json `notMarketplace`).
export function marketplaceSold(modelId: string, providerName: string, reviewed: ReviewedModels = REVIEWED): boolean {
  const { providers, models } = reviewed.notMarketplace;
  return !providers.includes(providerName) && !models.some((prefix) => modelId.startsWith(prefix));
}

async function signedGet(fetcher: typeof fetch, url: string, region: string, credentials: AwsCredentials, now: Date): Promise<{ status: number; body: unknown; errorName: string }> {
  const headers = await signV4({ method: "GET", url, region, service: "bedrock", credentials, now, headers: { accept: "application/json" } });
  const response = await fetcher(url, { method: "GET", headers: withoutHost(headers) });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // AWS's own words as they came.
  }
  return { status: response.status, body, errorName: response.headers.get("x-amzn-errortype")?.split(":")[0] ?? "" };
}

const denied = (r: { status: number; errorName: string }): boolean => r.status === 403 || /AccessDenied/i.test(r.errorName);
const words = (body: unknown): string => (typeof body === "string" ? body : String((body as { message?: unknown; Message?: unknown } | null)?.message ?? (body as { Message?: unknown } | null)?.Message ?? ""));

// (b) and (c), as the user's own role. `modelIds`: price-table name -> the
// Bedrock model ID Bedrock's list gives for it.
export async function readAccountStates(
  fetcher: typeof fetch,
  credentials: AwsCredentials,
  region: string,
  now: Date,
  modelIds: Record<string, string>,
): Promise<AccountStates> {
  const base = `https://bedrock.${region}.amazonaws.com`;
  const unknownAll = (): AccountStates["models"] => Object.fromEntries(Object.keys(modelIds).map((name) => [name, "unknown" as const]));
  const useCase = await signedGet(fetcher, `${base}/use-case-for-model-access`, region, credentials, now);
  if (denied(useCase)) return { form: "unknown", models: unknownAll(), denied: true };
  const form: FormState =
    useCase.status === 200
      ? "filled"
      : useCase.status === 404 || /not filled|ResourceNotFound/i.test(`${useCase.errorName} ${words(useCase.body)}`)
        ? "not_filled"
        : "unknown";

  const models: AccountStates["models"] = {};
  const names = Object.keys(modelIds);
  let refused = false;
  for (let i = 0; i < names.length; i += CONCURRENT_READS) {
    await Promise.all(
      names.slice(i, i + CONCURRENT_READS).map(async (name) => {
        const r = await signedGet(fetcher, `${base}/foundation-model-availability/${encodeURIComponent(modelIds[name]!)}`, region, credentials, now).catch(() => undefined);
        if (r && denied(r)) refused = true;
        const b = r?.status === 200 ? (r.body as { agreementAvailability?: { status?: unknown }; authorizationStatus?: unknown; entitlementAvailability?: unknown; regionAvailability?: unknown }) : undefined;
        const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
        models[name] = b
          ? { agreement: text(b.agreementAvailability?.status), authorization: text(b.authorizationStatus), entitlement: text(b.entitlementAvailability), region: text(b.regionAvailability) }
          : "unknown";
      }),
    );
  }
  return { form, models, denied: refused };
}

const hhmm = (iso: string): string => `${iso.slice(11, 16)} UTC`;

const updateNote = (): string =>
  `Update the stack for live account checks: in AWS CloudFormation, select the “${STACK_NAME}” stack, choose Update, then Replace existing template with the app's template ${ACCOUNT_CHECKS_SINCE}, as the guide's last step says. Until then each model's account state is unknown; choosing one still runs its test call.`;

// The refresh. Returns a plain problem when nothing was read.
export async function refreshBedrockModels(
  db: D1Database,
  plugins: PluginRegistry,
  input: { userId: string; readCatalog?: (now: Date) => Promise<CatalogRead>; now: Date },
): Promise<string | undefined> {
  const { userId, now } = input;
  const plugin = plugins.bedrock;
  const connection = await readConnection(db, userId, "bedrock");
  if (!plugin || !connection) return "Amazon Bedrock is not connected.";
  const last = await readAccountCheck(db, userId);
  const next = last ? new Date(new Date(last.checkedAt).getTime() + REFRESH_SECONDS * 1000) : undefined;
  if (next && next > now) return `The list was refreshed at ${hhmm(last!.checkedAt)}; refresh it again from ${hhmm(next.toISOString())}.`;

  // (a) The model list, at most once a minute for everyone.
  const snapshot = await currentSnapshot(db);
  const stored = snapshot ? await readStoredBedrockCatalog(db, snapshot.id) : undefined;
  let catalog: BedrockCatalog | undefined = stored;
  let catalogError: string | undefined;
  const fresh = stored && now.getTime() - new Date(stored.readAt).getTime() < REFRESH_SECONDS * 1000;
  if (input.readCatalog && !fresh) {
    const read = await input.readCatalog(now);
    if (!read.ok) catalogError = `Bedrock's model list could not be read again (${read.error}); the list read ${stored ? hhmm(stored.readAt) + " on " + stored.readAt.slice(0, 10) : "before"} stays in use.`;
    else if (await saveBedrockCatalog(db, read.catalog)) catalog = read.catalog;
    else catalogError = "The price table has not been read yet, so Bedrock's model list waits for it.";
  }

  // (b) and (c): only the offered Marketplace-sold models.
  const offer = catalog ? await readBedrockOffer(db, catalog.region) : undefined;
  const providerOf = new Map((catalog?.models ?? []).map((m) => [m.modelId, m.providerName]));
  const modelIds: Record<string, string> = {};
  for (const [name, o] of Object.entries(offer?.byName ?? {})) {
    if (o.kind === "callable" && marketplaceSold(o.modelId, providerOf.get(o.modelId) ?? "")) modelIds[name] = o.modelId;
  }
  const names = Object.keys(modelIds).sort();
  const read = Object.fromEntries(names.slice(0, MAX_MODEL_READS).map((n) => [n, modelIds[n]!]));
  const unknownAll = Object.fromEntries(names.map((n) => [n, "unknown" as const]));

  let check: AccountCheck = { checkedAt: now.toISOString(), form: "unknown", models: unknownAll, catalogError };
  const check0 = await readCheck(db, userId, "bedrock");
  try {
    const credential = await plugin.mintCredential(connection, { userId });
    // The stack's template version, read with the same credential.
    const version = (await plugin.connect.readSetupVersion?.(credential, connection).catch(() => undefined)) ?? check0?.templateVersion;
    if (version && check0 && version !== check0.templateVersion) {
      await db.prepare("UPDATE provider_checks SET template_version = ? WHERE user_id = ? AND provider = 'bedrock'").bind(version, userId).run();
    }
    if (version && olderTemplate(version, ACCOUNT_CHECKS_SINCE)) {
      check = { ...check, note: updateNote() };
    } else {
      const states = await plugin.connect.readAccountStates!(credential, read);
      check = {
        ...check,
        form: states.form,
        models: { ...unknownAll, ...states.models },
        note: states.denied ? updateNote() : names.length > MAX_MODEL_READS ? `The account was checked for the first ${MAX_MODEL_READS} of ${names.length} Marketplace models.` : undefined,
      };
    }
  } catch (error) {
    check = { ...check, note: `Your AWS account could not be read: ${error instanceof Error ? error.message.slice(0, 200) : "no answer"}. Choosing a model still runs its test call.` };
  }
  await saveAccountCheck(db, userId, check);
  return undefined;
}

// The entry's notes from the last refresh: what a pick will meet. None of
// them blocks a pick (see (b) above).
export function accessNotes(model: string, check: AccountCheck | undefined): string[] {
  if (!check) return [];
  const notes: string[] = [];
  const access = check.models[model];
  if (access === "unknown") notes.push("account state unknown");
  else if (access) {
    if (access.agreement === "NOT_AVAILABLE") notes.push("accept terms on first pick");
    if (access.agreement === "PENDING") notes.push("terms being accepted, up to 15 minutes");
    if (access.agreement === "ERROR") notes.push("its Marketplace agreement shows an error");
    if (access.authorization === "NOT_AUTHORIZED") notes.push("not authorized in this account");
    if (access.entitlement === "NOT_AVAILABLE") notes.push("no entitlement in this account");
    if (access.region === "NOT_AVAILABLE") notes.push("not available in this region");
  }
  if (check.form === "not_filled" && /^claude\b/i.test(model)) notes.push("needs Anthropic's form");
  return notes;
}
