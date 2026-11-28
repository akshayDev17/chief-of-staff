// What the shell's release pipeline decides about D1 migrations before it
// applies them (design-v3 8.4; README "Releasing the shell"). Pure functions,
// used by scripts/release-migrations.mjs.

// The migration files not yet applied, in the order they apply: every
// `.sql` file in the folder but dotfiles, as `wrangler d1 migrations apply`
// takes them (its default `migrations/*.sql`), whose name D1's
// `d1_migrations` table lacks.
export function pendingMigrations(files: readonly string[], applied: readonly string[]): string[] {
  const done = new Set(applied);
  return files.filter((f) => !f.startsWith(".") && f.endsWith(".sql") && !done.has(f)).sort();
}

// Statements that only add: a new table, index or view, a new column, new
// rows. Anything else may change or remove data that is already there, and
// so does an upsert (`ON CONFLICT ... DO UPDATE`), which rewrites existing rows.
const ADDS_ONLY: readonly RegExp[] = [
  /^CREATE\s+(UNIQUE\s+)?INDEX\b/i,
  /^CREATE\s+TABLE\b/i,
  /^CREATE\s+VIEW\b/i,
  /^ALTER\s+TABLE\s+\S+\s+ADD\b/i,
  /^INSERT\s+INTO\b/i,
];

const statements = (sql: string): string[] =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

// True when the migration may change or remove existing data. The pipeline's
// plan lists such migrations; it records D1's Time Travel bookmark before
// applying any migration, these and the additive ones alike.
export const changesData = (sql: string): boolean =>
  statements(sql).some((s) => /\bDO\s+UPDATE\b/i.test(s) || !ADDS_ONLY.some((re) => re.test(s)));
