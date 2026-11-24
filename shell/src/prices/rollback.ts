// Rolling the price table back: the newest snapshot not rolled back is marked
// rolled back, so the one before it is current again, and a rolled_back alert
// records it, only when an earlier snapshot would stay current. Otherwise
// nothing changes, so a repeated or mistaken run never empties the table. The
// last statement answers `rolled_back`, the rows the UPDATE changed (0 or 1);
// both callers report 0 as a refusal. The one
// definition of the rollback, run by the Worker (store.ts) and by the
// maintainers' script against the deployed D1 (scripts/roll-back-prices.mjs,
// through Wrangler). Plain SQL with no bound
// values, so `wrangler d1 execute --command` runs it as it stands.

const LATEST = "(SELECT max(id) FROM price_snapshots WHERE status != 'rolled_back')";
const EARLIER_STAYS = `EXISTS (SELECT 1 FROM price_snapshots WHERE status != 'rolled_back' AND id < ${LATEST})`;

export const ROLL_BACK_STATEMENTS: readonly string[] = [
  `INSERT INTO price_alerts (created_at, kind, detail)
     SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'rolled_back', 'snapshot ' || id || ' of ' || taken_at || ' rolled back'
     FROM price_snapshots WHERE id = ${LATEST} AND ${EARLIER_STAYS}`,
  `UPDATE price_snapshots SET status = 'rolled_back' WHERE id = ${LATEST} AND ${EARLIER_STAYS}`,
  "SELECT changes() AS rolled_back",
];

export const ROLL_BACK_REFUSED =
  "nothing rolled back: no earlier snapshot would stay current, and rolling back the only one would empty the price table";
