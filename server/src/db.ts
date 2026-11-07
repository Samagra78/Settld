// Settld database: SQLite built into Node (node:sqlite), one file at server/data/settld.db.
//
// The chain stays the source of truth. This database keeps:
//   - a fast, queryable copy of the chain (filled by the watcher from contract events), so dashboards
//     don't re-read the chain on every request (and don't hit Arc's RPC rate limits)
//   - things that are NOT on chain: which wallets passed World ID (for the ✓ badge), when, and the
//     archive of every case.
// No personal data: only wallet addresses and World ID nullifiers (anonymous by design).

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_FILE = path.resolve(process.cwd(), 'data', 'settld.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
export const db = new DatabaseSync(DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;

-- every contract event the watcher sees (the raw archive)
CREATE TABLE IF NOT EXISTS events (
  tx_hash    TEXT    NOT NULL,
  log_index  INTEGER NOT NULL,
  block      INTEGER NOT NULL,
  contract   TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  args_json  TEXT    NOT NULL,
  seen_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS events_name ON events(name);

-- wallets that passed World ID (server-verified). nullifier = anonymous "one human" id
CREATE TABLE IF NOT EXISTS people (
  wallet        TEXT PRIMARY KEY,
  nullifier     TEXT NOT NULL,
  verified_at   TEXT NOT NULL DEFAULT (datetime('now')),
  environment   TEXT NOT NULL DEFAULT 'staging',
  arbitrator    INTEGER NOT NULL DEFAULT 0,      -- 1 once registered on JurorRegistry (PersonRegistered)
  registered_at TEXT
);
CREATE INDEX IF NOT EXISTS people_nullifier ON people(nullifier);

-- deals (from escrow events)
CREATE TABLE IF NOT EXISTS deals (
  deal_id     INTEGER PRIMARY KEY,
  client      TEXT,
  freelancer  TEXT,
  total       TEXT,
  accepted    INTEGER NOT NULL DEFAULT 0,
  certified   INTEGER NOT NULL DEFAULT 0,
  funded      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- court cases (AI court + appeal) — the case archive
CREATE TABLE IF NOT EXISTS cases (
  case_id          INTEGER PRIMARY KEY,
  deal_id          INTEGER,
  clause_id        INTEGER,
  client           TEXT,
  freelancer       TEXT,
  disputer         TEXT,
  reason           TEXT,
  deadline         INTEGER,
  rounds           INTEGER NOT NULL DEFAULT 0,
  extensions       INTEGER NOT NULL DEFAULT 0,
  transcript_hash  TEXT,
  ai_band          INTEGER,
  appeal_deadline  INTEGER,
  appealed         INTEGER NOT NULL DEFAULT 0,
  appellant        TEXT,
  appeal_fee       TEXT,
  panel_open       INTEGER NOT NULL DEFAULT 0,
  commit_deadline  INTEGER,
  panel_band       INTEGER,
  final_band       INTEGER,
  by_humans        INTEGER,
  status           TEXT NOT NULL DEFAULT 'ai_deliberating',  -- ai_deliberating | ai_verdict | appealed | final
  opened_at        TEXT NOT NULL DEFAULT (datetime('now')),
  finalized_at     TEXT
);
CREATE INDEX IF NOT EXISTS cases_status ON cases(status);

-- arbitrator seats and votes per case (from JurorRegistry events)
CREATE TABLE IF NOT EXISTS panel_votes (
  case_id      INTEGER NOT NULL,
  arbitrator   TEXT    NOT NULL,
  committed_at TEXT,
  band         INTEGER,           -- revealed band
  revealed     INTEGER NOT NULL DEFAULT 0,
  in_majority  INTEGER,           -- set when the panel closes
  fee_earned   TEXT,              -- USDC units paid on finalize (when known)
  PRIMARY KEY (case_id, arbitrator)
);

-- off-chain steps of a deal's story (contract text → clauses, deadlock check), for the monitor
CREATE TABLE IF NOT EXISTS story (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id  INTEGER NOT NULL,
  at       TEXT NOT NULL DEFAULT (datetime('now')),
  icon     TEXT,
  title    TEXT NOT NULL,
  detail   TEXT
);

-- strikes per human (nullifier), mirrors JurorRegistry Struck events
CREATE TABLE IF NOT EXISTS strikes (
  nullifier  TEXT NOT NULL,
  strikes    INTEGER NOT NULL,
  suspended  INTEGER NOT NULL,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  tx_hash    TEXT
);
`);

const lc = (a: unknown) => String(a ?? '').toLowerCase();
const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
const num = (v: unknown) => (v === undefined || v === null ? null : Number(v));

// ---------------------------------------------------------------- World ID people

export function recordVerifiedPerson(wallet: string, nullifier: string, environment: string) {
  db.prepare(`
    INSERT INTO people (wallet, nullifier, environment) VALUES (?, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET nullifier = excluded.nullifier, verified_at = datetime('now'), environment = excluded.environment
  `).run(lc(wallet), nullifier, environment);
}

export function personOf(wallet: string) {
  return db.prepare('SELECT wallet, nullifier, verified_at, arbitrator, registered_at FROM people WHERE wallet = ?').get(lc(wallet)) as
    | { wallet: string; nullifier: string; verified_at: string; arbitrator: number; registered_at: string | null }
    | undefined;
}

// ---------------------------------------------------------------- chain events → tables

type Ev = { name: string; contract: string; args: Record<string, unknown>; txHash: string; logIndex: number; block: bigint | number };

/** Store a chain event (idempotent) and update the tables it affects. */
export function recordEvent(e: Ev) {
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO events (tx_hash, log_index, block, contract, name, args_json) VALUES (?, ?, ?, ?, ?, ?)
  `).run(e.txHash, e.logIndex, Number(e.block), lc(e.contract), e.name,
    JSON.stringify(e.args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  if (inserted.changes === 0) return; // already applied
  const a = e.args;

  switch (e.name) {
    case 'DealProposed':
      db.prepare('INSERT OR IGNORE INTO deals (deal_id, client, freelancer) VALUES (?, ?, ?)')
        .run(num(a.dealId), lc(a.brand), lc(a.creator));
      break;
    case 'DealAccepted':
      db.prepare('UPDATE deals SET accepted = 1 WHERE deal_id = ?').run(num(a.dealId));
      break;
    case 'DealCertified':
      db.prepare('UPDATE deals SET certified = 1 WHERE deal_id = ?').run(num(a.dealId));
      break;
    case 'DealFunded':
      db.prepare('UPDATE deals SET funded = 1, total = ? WHERE deal_id = ?').run(str(a.total), num(a.dealId));
      break;
    case 'ClauseDisputed':
      db.prepare(`INSERT INTO cases (case_id, deal_id, clause_id, disputer, reason) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(case_id) DO UPDATE SET disputer = excluded.disputer, reason = COALESCE(cases.reason, excluded.reason)`)
        .run(num(a.caseId), num(a.dealId), num(a.clauseId), lc(a.disputer), str(a.reason));
      break;
    case 'CaseOpened':
      db.prepare(`INSERT INTO cases (case_id, deal_id, clause_id, reason, deadline) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(case_id) DO UPDATE SET deadline = excluded.deadline, reason = COALESCE(cases.reason, excluded.reason)`)
        .run(num(a.caseId), num(a.dealId), num(a.clauseId), str(a.reason), num(a.deadline));
      db.prepare(`UPDATE cases SET client = (SELECT client FROM deals WHERE deal_id = cases.deal_id),
                  freelancer = (SELECT freelancer FROM deals WHERE deal_id = cases.deal_id) WHERE case_id = ?`).run(num(a.caseId));
      break;
    case 'RoundCompleted':
      db.prepare('UPDATE cases SET rounds = ? + 1, transcript_hash = ? WHERE case_id = ?')
        .run(num(a.round), str(a.transcriptHash), num(a.caseId));
      break;
    case 'ExtensionGranted':
      db.prepare('UPDATE cases SET extensions = extensions + 1, deadline = ? WHERE case_id = ?').run(num(a.deadline), num(a.caseId));
      break;
    case 'AIVerdict':
      db.prepare(`UPDATE cases SET ai_band = ?, appeal_deadline = ?, status = 'ai_verdict' WHERE case_id = ?`)
        .run(num(a.band), num(a.appealDeadline), num(a.caseId));
      break;
    case 'Appealed':
      db.prepare(`UPDATE cases SET appealed = 1, appellant = ?, appeal_fee = ?, status = 'appealed' WHERE case_id = ?`)
        .run(lc(a.by), str(a.fee), num(a.caseId));
      break;
    case 'PanelOpened':
      db.prepare('UPDATE cases SET panel_open = 1, commit_deadline = ? WHERE case_id = ?').run(num(a.commitDeadline), num(a.caseId));
      break;
    case 'VoteCommitted':
      db.prepare(`INSERT OR IGNORE INTO panel_votes (case_id, arbitrator, committed_at) VALUES (?, ?, datetime('now'))`)
        .run(num(a.caseId), lc(a.arbitrator));
      break;
    case 'VoteRevealed':
      db.prepare('UPDATE panel_votes SET band = ?, revealed = 1 WHERE case_id = ? AND arbitrator = ?')
        .run(num(a.band), num(a.caseId), lc(a.arbitrator));
      break;
    case 'PanelClosed': {
      const band = num(a.band);
      db.prepare('UPDATE cases SET panel_open = 0, panel_band = ? WHERE case_id = ?').run(band, num(a.caseId));
      // same rule as the contract: majority = revealed voters with the final band (all revealers if no majority)
      const votes = db.prepare('SELECT arbitrator, band, revealed FROM panel_votes WHERE case_id = ?').all(num(a.caseId)) as
        { arbitrator: string; band: number | null; revealed: number }[];
      const revealed = votes.filter((v) => v.revealed);
      const hasMajority = revealed.filter((v) => v.band === band).length * 2 > revealed.length;
      for (const v of votes) {
        const inMajority = v.revealed && (!hasMajority || v.band === band) && band !== 255 ? 1 : 0;
        db.prepare('UPDATE panel_votes SET in_majority = ? WHERE case_id = ? AND arbitrator = ?').run(inMajority, num(a.caseId), v.arbitrator);
      }
      break;
    }
    case 'Finalized':
      db.prepare(`UPDATE cases SET final_band = ?, by_humans = ?, status = 'final', finalized_at = datetime('now') WHERE case_id = ?`)
        .run(num(a.band), a.byHumans ? 1 : 0, num(a.caseId));
      break;
    case 'PersonRegistered':
      db.prepare(`INSERT INTO people (wallet, nullifier, arbitrator, registered_at) VALUES (?, ?, 1, datetime('now'))
                  ON CONFLICT(wallet) DO UPDATE SET arbitrator = 1, registered_at = datetime('now'), nullifier = excluded.nullifier`)
        .run(lc(a.wallet), str(a.nullifier));
      break;
    case 'Struck':
      db.prepare('INSERT INTO strikes (nullifier, strikes, suspended, tx_hash) VALUES (?, ?, ?, ?)')
        .run(str(a.nullifier), num(a.strikes), a.suspended ? 1 : 0, e.txHash);
      break;
  }
}

// ---------------------------------------------------------------- reads for the API

export const stats = () => ({
  verifiedHumans: (db.prepare('SELECT COUNT(*) n FROM people').get() as { n: number }).n,
  arbitrators: (db.prepare('SELECT COUNT(*) n FROM people WHERE arbitrator = 1').get() as { n: number }).n,
  openPanels: (db.prepare(`SELECT COUNT(*) n FROM cases WHERE panel_open = 1`).get() as { n: number }).n,
  casesDecided: (db.prepare(`SELECT COUNT(*) n FROM cases WHERE status = 'final'`).get() as { n: number }).n,
  decidedByHumans: (db.prepare(`SELECT COUNT(*) n FROM cases WHERE status = 'final' AND by_humans = 1`).get() as { n: number }).n,
});

export const getCaseRow = (caseId: number) =>
  db.prepare('SELECT * FROM cases WHERE case_id = ?').get(caseId) as Record<string, unknown> | undefined;

export const openPanels = () =>
  db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM panel_votes v WHERE v.case_id = c.case_id) AS seats_taken
              FROM cases c WHERE c.panel_open = 1 ORDER BY c.case_id DESC`).all() as Record<string, unknown>[];

export const casesOfArbitrator = (wallet: string) =>
  db.prepare(`SELECT v.*, c.deal_id, c.clause_id, c.reason, c.ai_band, c.panel_band, c.final_band, c.status, c.finalized_at
              FROM panel_votes v JOIN cases c ON c.case_id = v.case_id
              WHERE v.arbitrator = ? ORDER BY v.case_id DESC`).all(lc(wallet)) as Record<string, unknown>[];

export const panelVotes = (caseId: number) =>
  db.prepare('SELECT arbitrator, revealed, band, in_majority FROM panel_votes WHERE case_id = ?').all(caseId) as Record<string, unknown>[];

export const recentCases = (limit = 50) =>
  db.prepare('SELECT * FROM cases ORDER BY case_id DESC LIMIT ?').all(limit) as Record<string, unknown>[];

export const addStory = (dealId: number, icon: string, title: string, detail: string) =>
  db.prepare('INSERT INTO story (deal_id, icon, title, detail) VALUES (?, ?, ?, ?)').run(dealId, icon, title, detail);
