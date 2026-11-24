// Rolling the price table back: the newest snapshot not rolled back is marked
// rolled back, so the one before it is current again, and a rolled_back alert
// records it. The one definition of the rollback, run by the Worker
// (store.ts) and by the maintainers' script against the deployed D1
// (scripts/roll-back-prices.mjs, through Wrangler). Plain SQL with no bound
// values, so `wrangler d1 execute --command` runs it as it stands.

export const ROLL_BACK_STATEMENTS: readonly string[] = [
  `INSERT INTO price_alerts (created_at, kind, detail)
     SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'rolled_back', 'snapshot ' || id || ' of ' || taken_at || ' rolled back'
     FROM price_snapshots WHERE status != 'rolled_back' ORDER BY id DESC LIMIT 1`,
  `UPDATE price_snapshots SET status = 'rolled_back'
     WHERE id = (SELECT max(id) FROM price_snapshots WHERE status != 'rolled_back')`,
];
