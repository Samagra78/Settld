// Demo cases for the arbitrator dashboard (MongoDB only). Every record is marked demo: true.
//   npx tsx scripts/demo-cases.ts add      (re-running replaces them)
//   npx tsx scripts/demo-cases.ts remove
// They show on EVERY arbitrator's dashboard: past cases are recorded under arbitrator "demo", open cases list
// with a disabled seat ("Demo case: for show only"). They are not on-chain and are left out of public stats.
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const USDC = 1_000_000;
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString().replace('T', ' ').slice(0, 19);

const cases = [
  // two appeals waiting for arbitrators
  { case_id: 9001, deal_id: 901, clause_id: 0, ai_band: 100, status: 'appealed', panel_open: 1, appealed: 1, appeal_fee: String(30 * USDC),
    reason: 'The video never shows the product. It is only mentioned once in the description.' },
  { case_id: 9002, deal_id: 902, clause_id: 1, ai_band: 0, status: 'appealed', panel_open: 1, appealed: 1, appeal_fee: String(15 * USDC),
    reason: 'The landing page was live on time; the checker hit it during a 2-minute outage.' },
  // past cases of "my" record
  { case_id: 9003, deal_id: 903, clause_id: 0, ai_band: 0, panel_band: 100, final_band: 100, status: 'final', panel_open: 0, appealed: 1, by_humans: 1,
    appeal_fee: String(20 * USDC), finalized_at: ago(30), reason: 'The pull request was merged a day late because the client’s review was late.' },
  { case_id: 9004, deal_id: 904, clause_id: 2, ai_band: 100, panel_band: 0, final_band: 0, status: 'final', panel_open: 0, appealed: 1, by_humans: 1,
    appeal_fee: String(10 * USDC), finalized_at: ago(54), reason: 'The #ad tag was added after the deadline, once the client complained.' },
  { case_id: 9005, deal_id: 905, clause_id: 0, ai_band: 100, status: 'appealed', panel_open: 0, appealed: 1, appeal_fee: String(25 * USDC),
    reason: 'The reel uses a competitor’s product in the first 10 seconds.' },
].map((c, i) => ({ _id: c.case_id, ...c, rounds: 3, extensions: 0, opened_at: ago(80 - i * 12), demo: true }));

const votes = [
  // seats already taken by other (demo) arbitrators on the open cases
  { case_id: 9001, arbitrator: 'demo-seat-a', revealed: 0, band: null, in_majority: null },
  { case_id: 9002, arbitrator: 'demo-seat-a', revealed: 0, band: null, in_majority: null },
  { case_id: 9002, arbitrator: 'demo-seat-b', revealed: 0, band: null, in_majority: null },
  // "my" votes (arbitrator "demo"): with the majority, against it (a strike), and one still sealed
  { case_id: 9003, arbitrator: 'demo', revealed: 1, band: 100, in_majority: 1 },
  { case_id: 9003, arbitrator: 'demo-seat-a', revealed: 1, band: 100, in_majority: 1 },
  { case_id: 9003, arbitrator: 'demo-seat-b', revealed: 1, band: 0, in_majority: 0 },
  { case_id: 9004, arbitrator: 'demo', revealed: 1, band: 100, in_majority: 0 },
  { case_id: 9004, arbitrator: 'demo-seat-a', revealed: 1, band: 0, in_majority: 1 },
  { case_id: 9004, arbitrator: 'demo-seat-b', revealed: 1, band: 0, in_majority: 1 },
  { case_id: 9005, arbitrator: 'demo', revealed: 0, band: null, in_majority: null },
].map((v) => ({ ...v, _id: `${v.case_id}:${v.arbitrator}`, demo: true }));

const uri = process.env.MONGODB_URI?.trim();
if (!uri) throw new Error('MONGODB_URI is not set (server/.env)');
const client = new MongoClient(uri);
await client.connect();
const db = client.db(process.env.MONGODB_DB?.trim() || 'settld');
const removed = [
  (await db.collection('cases').deleteMany({ demo: true })).deletedCount,
  (await db.collection('panel_votes').deleteMany({ demo: true })).deletedCount,
];
if (process.argv[2] === 'add') {
  await db.collection('cases').insertMany(cases as never[]);
  await db.collection('panel_votes').insertMany(votes as never[]);
  console.log(`demo cases added: ${cases.length} cases, ${votes.length} votes (replaced ${removed[0]} + ${removed[1]})`);
} else {
  console.log(`demo cases removed: ${removed[0]} cases, ${removed[1]} votes`);
}
await client.close();
