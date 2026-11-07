// Settld data store: ONE async interface, two backends.
//   MONGODB_URI set  → MongoDB (e.g. Atlas free tier) — use this when the server is hosted (hosted disks are wiped)
//   otherwise        → SQLite file server/data/settld.db (built into Node; good for local runs)
//
// The chain stays the source of truth: the watcher archives every contract event here and keeps fast tables for
// deals, court cases, panel votes, strikes, World ID-verified wallets, each deal's story, AI court transcripts
// (their hash is on-chain) and the automation's own state. No personal data: only wallets + anonymous nullifiers.

import fs from 'node:fs';
import path from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import { db as sqlite } from './db.js';

export type Row = Record<string, any>;
export type ChainEvent = { name: string; contract: string; args: Record<string, unknown>; txHash: string; logIndex: number; block: bigint | number };

let mongo: Db | null = null;
export const backend = () => (mongo ? 'mongodb' : 'sqlite');

export async function initStore() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    console.log('[store] SQLite (server/data/settld.db). Set MONGODB_URI to use MongoDB.');
    await importLegacyFiles();
    return;
  }
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    console.error('[store] MONGODB_URI must be the full connection string starting with mongodb+srv:// — using SQLite for now.');
    await importLegacyFiles();
    return;
  }
  try {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
    await client.connect();
    mongo = client.db(process.env.MONGODB_DB?.trim() || 'settld');
  } catch (e) {
    console.error(`[store] could not connect to MongoDB (${(e as Error).message.split('\n')[0]}) — using SQLite for now.`);
    mongo = null;
    await importLegacyFiles();
    return;
  }
  await Promise.all([
    mongo.collection('events').createIndex({ name: 1 }),
    mongo.collection('events').createIndex({ block: 1, log_index: 1 }),
    mongo.collection('people').createIndex({ nullifier: 1 }),
    mongo.collection('cases').createIndex({ deal_id: 1 }),
    mongo.collection('cases').createIndex({ panel_open: 1 }),
    mongo.collection('panel_votes').createIndex({ case_id: 1 }),
    mongo.collection('panel_votes').createIndex({ arbitrator: 1 }),
    mongo.collection('story').createIndex({ deal_id: 1, seq: 1 }),
    // MongoDB deletes a session on its own once expiresAt (a Date) has passed
    mongo.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    mongo.collection('sessions').createIndex({ address: 1 }),
  ]);
  console.log(`[store] MongoDB connected (database "${mongo.databaseName}")`);
  await importLegacyFiles();
  await copySqliteToMongo();
}

/** One-time: AI court transcripts and automation state that older versions kept as files. */
async function importLegacyFiles() {
  const dir = path.resolve(process.cwd(), 'data', 'court');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const caseId = f.replace(/\.json$/, '');
      if (!(await getTranscript(caseId))) await putTranscript(caseId, fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  }
  const stateFile = path.resolve(process.cwd(), 'data', 'automation.json');
  if (fs.existsSync(stateFile) && !(await getState('automation'))) {
    await setState('automation', JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  }
}

/** First MongoDB start on a machine that already has a SQLite archive: copy it across once. */
async function copySqliteToMongo() {
  if (!mongo || (await mongo.collection('events').countDocuments({})) > 0) return;
  const rows = (q: string) => sqlite.prepare(q).all() as Row[];
  const events = rows('SELECT * FROM events ORDER BY block, log_index');
  if (!events.length) return;
  await mongo.collection('events').insertMany(events.map((e) => ({ _id: `${e.tx_hash}:${e.log_index}` as any, ...e })));
  const copy = async (name: string, key: (r: Row) => unknown, list: Row[]) => {
    if (list.length) await mongo!.collection(name).insertMany(list.map((r) => ({ _id: key(r) as any, ...r })), { ordered: false }).catch(() => {});
  };
  await copy('deals', (r) => r.deal_id, rows('SELECT * FROM deals'));
  await copy('cases', (r) => r.case_id, rows('SELECT * FROM cases'));
  await copy('panel_votes', (r) => `${r.case_id}:${r.arbitrator}`, rows('SELECT * FROM panel_votes'));
  await copy('people', (r) => r.wallet, rows('SELECT * FROM people'));
  for (const s of rows('SELECT * FROM story ORDER BY id')) {
    await mongo.collection('story').insertOne({ deal_id: s.deal_id, seq: Number(s.id), at: s.at, icon: s.icon, title: s.title, detail: s.detail });
  }
  for (const s of rows('SELECT * FROM strikes')) await mongo.collection('strikes').insertOne({ ...s });
  for (const t of rows('SELECT * FROM transcripts')) await putTranscript(String(t.case_id), String(t.raw));
  const st = sqlite.prepare("SELECT value FROM kv WHERE key = 'automation'").get() as Row | undefined;
  if (st) await setState('automation', JSON.parse(String(st.value)));
  console.log(`[store] copied the local SQLite archive into MongoDB (${events.length} events)`);
}

const lc = (a: unknown) => String(a ?? '').toLowerCase();
const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
const num = (v: unknown) => (v === undefined || v === null ? null : Number(v));
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const clean = <T extends Row>(d: T | null | undefined) => {
  if (!d) return undefined;
  const { _id, ...rest } = d;
  return rest as Row;
};
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

// SQLite tables that the old db.ts didn't have
sqlite.exec(`
CREATE TABLE IF NOT EXISTS transcripts (case_id TEXT PRIMARY KEY, raw TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// ---------------------------------------------------------------- World ID people

// ---- login sessions ----------------------------------------------------------
// MongoDB when connected (survives redeploys and restarts), otherwise memory only.
// The caller passes the hashed session id, never the cookie value itself.
export type StoredSession = {
  address: string; walletId: string; blockchain: string;
  userToken: string; tokenExpiresAt: number; expiresAt: number;
};
const memSessions = new Map<string, StoredSession>();

export async function saveSession(id: string, s: StoredSession) {
  if (!mongo) { memSessions.set(id, s); return; }
  await mongo.collection('sessions').replaceOne({ _id: id as any },
    { ...s, expiresAt: new Date(s.expiresAt), tokenExpiresAt: new Date(s.tokenExpiresAt) }, { upsert: true });
}

export async function loadSession(id: string): Promise<StoredSession | undefined> {
  if (!mongo) return memSessions.get(id);
  const d = await mongo.collection('sessions').findOne({ _id: id as any });
  if (!d) return undefined;
  return {
    address: d.address, walletId: d.walletId, blockchain: d.blockchain, userToken: d.userToken,
    tokenExpiresAt: new Date(d.tokenExpiresAt).getTime(), expiresAt: new Date(d.expiresAt).getTime(),
  };
}

export async function touchSession(id: string, expiresAt: number) {
  if (!mongo) { const s = memSessions.get(id); if (s) s.expiresAt = expiresAt; return; }
  await mongo.collection('sessions').updateOne({ _id: id as any }, { $set: { expiresAt: new Date(expiresAt) } });
}

export async function deleteSession(id: string) {
  if (!mongo) { memSessions.delete(id); return; }
  await mongo.collection('sessions').deleteOne({ _id: id as any });
}

export async function recordVerifiedPerson(wallet: string, nullifier: string, environment: string) {
  if (mongo) {
    await mongo.collection('people').updateOne({ _id: lc(wallet) as any },
      { $set: { wallet: lc(wallet), nullifier, environment, verified_at: now() }, $setOnInsert: { arbitrator: 0, registered_at: null } }, { upsert: true });
    return;
  }
  sqlite.prepare(`INSERT INTO people (wallet, nullifier, environment) VALUES (?, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET nullifier = excluded.nullifier, verified_at = datetime('now'), environment = excluded.environment`)
    .run(lc(wallet), nullifier, environment);
}

export async function personOf(wallet: string): Promise<Row | undefined> {
  if (mongo) return clean(await mongo.collection('people').findOne({ _id: lc(wallet) as any }));
  return sqlite.prepare('SELECT * FROM people WHERE wallet = ?').get(lc(wallet)) as Row | undefined;
}

// ---------------------------------------------------------------- chain events → tables

/** Store a chain event (idempotent) and update the tables it affects. */
export async function recordEvent(e: ChainEvent) {
  const a = e.args;
  const doc = { tx_hash: e.txHash, log_index: e.logIndex, block: Number(e.block), contract: lc(e.contract), name: e.name, args_json: json(a), seen_at: now() };
  if (!mongo) {
    const r = sqlite.prepare('INSERT OR IGNORE INTO events (tx_hash, log_index, block, contract, name, args_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(doc.tx_hash, doc.log_index, doc.block, doc.contract, doc.name, doc.args_json);
    if (r.changes === 0) return;
  } else {
    try {
      await mongo.collection('events').insertOne({ _id: `${e.txHash}:${e.logIndex}` as any, ...doc });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return; // already applied
      throw err;
    }
  }
  await applyEvent(e.name, a, e.txHash);
}

async function applyEvent(name: string, a: Record<string, unknown>, txHash: string) {
  const dealId = num(a.dealId), caseId = num(a.caseId);
  if (!mongo) return applySqlite(name, a, txHash);
  const deals = mongo.collection('deals'), cases = mongo.collection('cases'), votes = mongo.collection('panel_votes');
  const caseDefaults = { rounds: 0, extensions: 0, appealed: 0, panel_open: 0, status: 'ai_deliberating', opened_at: now() };
  const setCase = (set: Row, insert: Row = {}) => {
    const onInsert = { ...caseDefaults, ...insert, case_id: caseId };
    for (const k of Object.keys(set)) delete (onInsert as Row)[k]; // a field may not be in both $set and $setOnInsert
    return cases.updateOne({ _id: caseId as any }, { $set: set, $setOnInsert: onInsert }, { upsert: true });
  };
  switch (name) {
    case 'DealProposed':
      await deals.updateOne({ _id: dealId as any }, { $setOnInsert: { deal_id: dealId, client: lc(a.brand), freelancer: lc(a.creator), accepted: 0, certified: 0, funded: 0, created_at: now() } }, { upsert: true });
      break;
    case 'DealAccepted': await deals.updateOne({ _id: dealId as any }, { $set: { accepted: 1 } }); break;
    case 'DealCertified': await deals.updateOne({ _id: dealId as any }, { $set: { certified: 1 } }); break;
    case 'DealFunded': await deals.updateOne({ _id: dealId as any }, { $set: { funded: 1, total: str(a.total) } }); break;
    case 'ClauseDisputed': {
      const existing = await cases.findOne({ _id: caseId as any });
      await setCase({ deal_id: dealId, clause_id: num(a.clauseId), disputer: lc(a.disputer), ...(existing?.reason ? {} : { reason: str(a.reason) }) });
      break;
    }
    case 'CaseOpened': {
      const existing = await cases.findOne({ _id: caseId as any });
      const deal = await deals.findOne({ _id: dealId as any });
      await setCase({
        deal_id: dealId, clause_id: num(a.clauseId), deadline: num(a.deadline),
        client: deal?.client ?? null, freelancer: deal?.freelancer ?? null,
        ...(existing?.reason ? {} : { reason: str(a.reason) }),
      });
      break;
    }
    case 'RoundCompleted': await setCase({ rounds: Number(a.round) + 1, transcript_hash: str(a.transcriptHash) }); break;
    case 'ExtensionGranted':
      await cases.updateOne({ _id: caseId as any }, { $inc: { extensions: 1 }, $set: { deadline: num(a.deadline) } });
      break;
    case 'AIVerdict': await setCase({ ai_band: num(a.band), appeal_deadline: num(a.appealDeadline), status: 'ai_verdict' }); break;
    case 'Appealed': await setCase({ appealed: 1, appellant: lc(a.by), appeal_fee: str(a.fee), status: 'appealed' }); break;
    case 'PanelOpened': await setCase({ panel_open: 1, commit_deadline: num(a.commitDeadline) }); break;
    case 'VoteCommitted':
      await votes.updateOne({ _id: `${caseId}:${lc(a.arbitrator)}` as any },
        { $setOnInsert: { case_id: caseId, arbitrator: lc(a.arbitrator), committed_at: now(), revealed: 0, band: null, in_majority: null } }, { upsert: true });
      break;
    case 'VoteRevealed':
      await votes.updateOne({ _id: `${caseId}:${lc(a.arbitrator)}` as any }, { $set: { band: num(a.band), revealed: 1 } });
      break;
    case 'PanelClosed': {
      const band = num(a.band);
      await setCase({ panel_open: 0, panel_band: band });
      const vs = await votes.find({ case_id: caseId }).toArray();
      const revealed = vs.filter((v) => v.revealed);
      const hasMajority = revealed.filter((v) => v.band === band).length * 2 > revealed.length;
      for (const v of vs) {
        const inMajority = v.revealed && (!hasMajority || v.band === band) && band !== 255 ? 1 : 0;
        await votes.updateOne({ _id: v._id }, { $set: { in_majority: inMajority } });
      }
      break;
    }
    case 'Finalized': await setCase({ final_band: num(a.band), by_humans: a.byHumans ? 1 : 0, status: 'final', finalized_at: now() }); break;
    case 'PersonRegistered':
      await mongo.collection('people').updateOne({ _id: lc(a.wallet) as any },
        { $set: { wallet: lc(a.wallet), nullifier: str(a.nullifier), arbitrator: 1, registered_at: now() }, $setOnInsert: { verified_at: now() } }, { upsert: true });
      break;
    case 'Struck':
      await mongo.collection('strikes').insertOne({ nullifier: str(a.nullifier), strikes: num(a.strikes), suspended: a.suspended ? 1 : 0, at: now(), tx_hash: txHash });
      break;
  }
}

function applySqlite(name: string, a: Record<string, unknown>, txHash: string) {
  // same projections as before (db.ts recordEvent), without re-inserting the event row
  const s = sqlite;
  switch (name) {
    case 'DealProposed': s.prepare('INSERT OR IGNORE INTO deals (deal_id, client, freelancer) VALUES (?, ?, ?)').run(num(a.dealId), lc(a.brand), lc(a.creator)); break;
    case 'DealAccepted': s.prepare('UPDATE deals SET accepted = 1 WHERE deal_id = ?').run(num(a.dealId)); break;
    case 'DealCertified': s.prepare('UPDATE deals SET certified = 1 WHERE deal_id = ?').run(num(a.dealId)); break;
    case 'DealFunded': s.prepare('UPDATE deals SET funded = 1, total = ? WHERE deal_id = ?').run(str(a.total), num(a.dealId)); break;
    case 'ClauseDisputed':
      s.prepare(`INSERT INTO cases (case_id, deal_id, clause_id, disputer, reason) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(case_id) DO UPDATE SET disputer = excluded.disputer, reason = COALESCE(cases.reason, excluded.reason)`)
        .run(num(a.caseId), num(a.dealId), num(a.clauseId), lc(a.disputer), str(a.reason));
      break;
    case 'CaseOpened':
      s.prepare(`INSERT INTO cases (case_id, deal_id, clause_id, reason, deadline) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(case_id) DO UPDATE SET deadline = excluded.deadline, reason = COALESCE(cases.reason, excluded.reason)`)
        .run(num(a.caseId), num(a.dealId), num(a.clauseId), str(a.reason), num(a.deadline));
      s.prepare(`UPDATE cases SET client = (SELECT client FROM deals WHERE deal_id = cases.deal_id),
                 freelancer = (SELECT freelancer FROM deals WHERE deal_id = cases.deal_id) WHERE case_id = ?`).run(num(a.caseId));
      break;
    case 'RoundCompleted': s.prepare('UPDATE cases SET rounds = ? + 1, transcript_hash = ? WHERE case_id = ?').run(num(a.round), str(a.transcriptHash), num(a.caseId)); break;
    case 'ExtensionGranted': s.prepare('UPDATE cases SET extensions = extensions + 1, deadline = ? WHERE case_id = ?').run(num(a.deadline), num(a.caseId)); break;
    case 'AIVerdict': s.prepare(`UPDATE cases SET ai_band = ?, appeal_deadline = ?, status = 'ai_verdict' WHERE case_id = ?`).run(num(a.band), num(a.appealDeadline), num(a.caseId)); break;
    case 'Appealed': s.prepare(`UPDATE cases SET appealed = 1, appellant = ?, appeal_fee = ?, status = 'appealed' WHERE case_id = ?`).run(lc(a.by), str(a.fee), num(a.caseId)); break;
    case 'PanelOpened': s.prepare('UPDATE cases SET panel_open = 1, commit_deadline = ? WHERE case_id = ?').run(num(a.commitDeadline), num(a.caseId)); break;
    case 'VoteCommitted': s.prepare(`INSERT OR IGNORE INTO panel_votes (case_id, arbitrator, committed_at) VALUES (?, ?, datetime('now'))`).run(num(a.caseId), lc(a.arbitrator)); break;
    case 'VoteRevealed': s.prepare('UPDATE panel_votes SET band = ?, revealed = 1 WHERE case_id = ? AND arbitrator = ?').run(num(a.band), num(a.caseId), lc(a.arbitrator)); break;
    case 'PanelClosed': {
      const band = num(a.band);
      s.prepare('UPDATE cases SET panel_open = 0, panel_band = ? WHERE case_id = ?').run(band, num(a.caseId));
      const vs = s.prepare('SELECT arbitrator, band, revealed FROM panel_votes WHERE case_id = ?').all(num(a.caseId)) as Row[];
      const revealed = vs.filter((v) => v.revealed);
      const hasMajority = revealed.filter((v) => v.band === band).length * 2 > revealed.length;
      for (const v of vs) {
        const inMajority = v.revealed && (!hasMajority || v.band === band) && band !== 255 ? 1 : 0;
        s.prepare('UPDATE panel_votes SET in_majority = ? WHERE case_id = ? AND arbitrator = ?').run(inMajority, num(a.caseId), v.arbitrator);
      }
      break;
    }
    case 'Finalized': s.prepare(`UPDATE cases SET final_band = ?, by_humans = ?, status = 'final', finalized_at = datetime('now') WHERE case_id = ?`).run(num(a.band), a.byHumans ? 1 : 0, num(a.caseId)); break;
    case 'PersonRegistered':
      s.prepare(`INSERT INTO people (wallet, nullifier, arbitrator, registered_at) VALUES (?, ?, 1, datetime('now'))
                 ON CONFLICT(wallet) DO UPDATE SET arbitrator = 1, registered_at = datetime('now'), nullifier = excluded.nullifier`).run(lc(a.wallet), str(a.nullifier));
      break;
    case 'Struck': s.prepare('INSERT INTO strikes (nullifier, strikes, suspended, tx_hash) VALUES (?, ?, ?, ?)').run(str(a.nullifier), num(a.strikes), a.suspended ? 1 : 0, txHash); break;
  }
}

// ---------------------------------------------------------------- reads

export async function stats() {
  if (mongo) {
    const [verifiedHumans, arbitrators, openPanels, casesDecided, decidedByHumans] = await Promise.all([
      mongo.collection('people').countDocuments({}),
      mongo.collection('people').countDocuments({ arbitrator: 1 }),
      mongo.collection('cases').countDocuments({ panel_open: 1, demo: { $ne: true } }),
      mongo.collection('cases').countDocuments({ status: 'final', demo: { $ne: true } }),
      mongo.collection('cases').countDocuments({ status: 'final', by_humans: 1, demo: { $ne: true } }),
    ]);
    return { verifiedHumans, arbitrators, openPanels, casesDecided, decidedByHumans };
  }
  const n = (q: string) => (sqlite.prepare(q).get() as { n: number }).n;
  return {
    verifiedHumans: n('SELECT COUNT(*) n FROM people'),
    arbitrators: n('SELECT COUNT(*) n FROM people WHERE arbitrator = 1'),
    openPanels: n('SELECT COUNT(*) n FROM cases WHERE panel_open = 1'),
    casesDecided: n(`SELECT COUNT(*) n FROM cases WHERE status = 'final'`),
    decidedByHumans: n(`SELECT COUNT(*) n FROM cases WHERE status = 'final' AND by_humans = 1`),
  };
}

export async function getCase(caseId: number): Promise<Row | undefined> {
  if (mongo) return clean(await mongo.collection('cases').findOne({ _id: caseId as any }));
  return sqlite.prepare('SELECT * FROM cases WHERE case_id = ?').get(caseId) as Row | undefined;
}

export async function getDeal(dealId: number): Promise<Row | undefined> {
  if (mongo) return clean(await mongo.collection('deals').findOne({ _id: dealId as any }));
  return sqlite.prepare('SELECT * FROM deals WHERE deal_id = ?').get(dealId) as Row | undefined;
}

export async function caseIdsOfDeal(dealId: number): Promise<number[]> {
  if (mongo) return (await mongo.collection('cases').find({ deal_id: dealId }).project({ case_id: 1 }).toArray()).map((c) => Number(c.case_id));
  return (sqlite.prepare('SELECT case_id FROM cases WHERE deal_id = ?').all(dealId) as Row[]).map((c) => Number(c.case_id));
}

export async function openPanels(): Promise<Row[]> {
  if (mongo) {
    const cs = await mongo.collection('cases').find({ panel_open: 1 }).sort({ case_id: -1 }).toArray();
    return Promise.all(cs.map(async (c) => ({ ...clean(c), seats_taken: await mongo!.collection('panel_votes').countDocuments({ case_id: c.case_id }) })));
  }
  return sqlite.prepare(`SELECT c.*, (SELECT COUNT(*) FROM panel_votes v WHERE v.case_id = c.case_id) AS seats_taken
                         FROM cases c WHERE c.panel_open = 1 ORDER BY c.case_id DESC`).all() as Row[];
}

export async function casesOfArbitrator(wallet: string): Promise<Row[]> {
  if (mongo) {
    const vs = await mongo.collection('panel_votes').find({ arbitrator: lc(wallet) }).sort({ case_id: -1 }).toArray();
    return Promise.all(vs.map(async (v) => {
      const c = await mongo!.collection('cases').findOne({ _id: v.case_id });
      return { ...clean(v), demo: !!c?.demo, deal_id: c?.deal_id, clause_id: c?.clause_id, reason: c?.reason, ai_band: c?.ai_band, panel_band: c?.panel_band, final_band: c?.final_band, status: c?.status, finalized_at: c?.finalized_at };
    }));
  }
  return sqlite.prepare(`SELECT v.*, c.deal_id, c.clause_id, c.reason, c.ai_band, c.panel_band, c.final_band, c.status, c.finalized_at
                         FROM panel_votes v JOIN cases c ON c.case_id = v.case_id WHERE v.arbitrator = ? ORDER BY v.case_id DESC`).all(lc(wallet)) as Row[];
}

export async function panelVotes(caseId: number): Promise<Row[]> {
  if (mongo) return (await mongo.collection('panel_votes').find({ case_id: caseId }).toArray()).map((v) => clean(v)!);
  return sqlite.prepare('SELECT arbitrator, revealed, band, in_majority FROM panel_votes WHERE case_id = ?').all(caseId) as Row[];
}

export async function listDeals(limit = 20): Promise<Row[]> {
  if (mongo) return (await mongo.collection('deals').find({}).sort({ deal_id: -1 }).limit(limit).toArray()).map((d) => clean(d)!);
  return sqlite.prepare('SELECT * FROM deals ORDER BY deal_id DESC LIMIT ?').all(limit) as Row[];
}
export async function listCases(limit = 20): Promise<Row[]> {
  // the public monitor shows only real, on-chain cases (seeded demo cases stay on the arbitrator dashboard)
  if (mongo) return (await mongo.collection('cases').find({ demo: { $ne: true } }).sort({ case_id: -1 }).limit(limit).toArray()).map((d) => clean(d)!);
  return sqlite.prepare('SELECT * FROM cases ORDER BY case_id DESC LIMIT ?').all(limit) as Row[];
}
export async function listVotes(limit = 30): Promise<Row[]> {
  if (mongo) return (await mongo.collection('panel_votes').find({ demo: { $ne: true } }).sort({ case_id: -1 }).limit(limit).toArray()).map((d) => clean(d)!);
  return sqlite.prepare('SELECT * FROM panel_votes ORDER BY case_id DESC LIMIT ?').all(limit) as Row[];
}
/** Events, newest first (limit) or all in chain order (no limit). */
export async function listEvents(limit?: number): Promise<Row[]> {
  if (mongo) {
    const cur = mongo.collection('events').find({});
    const rows = limit ? await cur.sort({ block: -1, log_index: -1 }).limit(limit).toArray() : await cur.sort({ block: 1, log_index: 1 }).toArray();
    return rows.map((d) => clean(d)!);
  }
  return (limit
    ? sqlite.prepare('SELECT * FROM events ORDER BY block DESC, log_index DESC LIMIT ?').all(limit)
    : sqlite.prepare('SELECT * FROM events ORDER BY block, log_index').all()) as Row[];
}

// ---------------------------------------------------------------- story (off-chain steps of a deal)

export async function addStory(dealId: number, icon: string, title: string, detail: string) {
  if (mongo) {
    await mongo.collection('story').insertOne({ deal_id: dealId, seq: Date.now(), at: now(), icon, title, detail });
    return;
  }
  sqlite.prepare('INSERT INTO story (deal_id, icon, title, detail) VALUES (?, ?, ?, ?)').run(dealId, icon, title, detail);
}
export async function storyOf(dealId: number): Promise<Row[]> {
  if (mongo) return (await mongo.collection('story').find({ deal_id: dealId }).sort({ seq: 1 }).toArray()).map((d) => clean(d)!);
  return sqlite.prepare('SELECT * FROM story WHERE deal_id = ? ORDER BY id').all(dealId) as Row[];
}

// ---------------------------------------------------------------- AI court transcripts (exact text; hash on-chain)

export async function putTranscript(caseId: string, raw: string) {
  if (mongo) {
    await mongo.collection('transcripts').updateOne({ _id: caseId as any }, { $set: { raw, updated_at: now() } }, { upsert: true });
    return;
  }
  sqlite.prepare(`INSERT INTO transcripts (case_id, raw) VALUES (?, ?)
                  ON CONFLICT(case_id) DO UPDATE SET raw = excluded.raw, updated_at = datetime('now')`).run(caseId, raw);
}
export async function getTranscript(caseId: string): Promise<string | null> {
  if (mongo) return ((await mongo.collection('transcripts').findOne({ _id: caseId as any }))?.raw as string) ?? null;
  return ((sqlite.prepare('SELECT raw FROM transcripts WHERE case_id = ?').get(caseId) as Row | undefined)?.raw as string) ?? null;
}

// ---------------------------------------------------------------- small key-value state (automation)

export async function getState<T>(key: string): Promise<T | null> {
  if (mongo) return ((await mongo.collection('kv').findOne({ _id: key as any }))?.value as T) ?? null;
  const r = sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
  return r ? (JSON.parse(String(r.value)) as T) : null;
}
export async function setState(key: string, value: unknown) {
  if (mongo) {
    await mongo.collection('kv').updateOne({ _id: key as any }, { $set: { value } }, { upsert: true });
    return;
  }
  sqlite.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}
