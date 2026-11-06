// Live backend monitor (developer page, not part of the app UI): http://localhost:3000/monitor
// Shows the watcher/keeper activity, deals and cases from the database, and every archived contract event.
// Not served in production.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { db, stats } from './db.js';

export function registerMonitor(app: Express, contracts: Record<string, string | undefined>, explorer: string) {
  if (process.env.NODE_ENV === 'production') return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  app.get('/monitor', (_req, res) => res.sendFile(path.join(here, '..', 'public', 'monitor.html')));
  app.get('/api/monitor', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      contracts, explorer,
      stats: stats(),
      deals: db.prepare('SELECT * FROM deals ORDER BY deal_id DESC LIMIT 20').all(),
      cases: db.prepare('SELECT * FROM cases ORDER BY case_id DESC LIMIT 20').all(),
      votes: db.prepare('SELECT * FROM panel_votes ORDER BY case_id DESC LIMIT 30').all(),
      events: db.prepare('SELECT tx_hash, log_index, block, contract, name, args_json, seen_at FROM events ORDER BY block DESC, log_index DESC LIMIT 60').all(),
    });
  });
}
