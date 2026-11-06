// AI court transcript store.
//
// WF3 (Chainlink CRE) writes each round's full transcript here, and records only its keccak256 hash
// on-chain (AICourt RoundCompleted.transcriptHash). The next WF3 round fetches it back and checks the
// hash, so this server can store the text but can never change what the judges said.
//
//   POST /api/court/:caseId/transcript  { transcript, hash }  header x-court-token   (WF3 only)
//   GET  /api/court/:caseId/transcript  → the exact stored JSON text (hashed as-is by WF3)  [WF3 token, parties, arbitrators]
//   GET  /api/court/:caseId             → parsed transcript + hash, for the courtroom screen  [parties, arbitrators]

import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { keccak256, toBytes } from 'viem';

const DIR = path.resolve(process.cwd(), 'data', 'court');
const fileOf = (caseId: string) => path.join(DIR, `${caseId}.json`);
const validCase = (s: string) => /^(\d{1,78}|dry-run)$/.test(s);

export type CourtAccess = {
  requireWallet: (req: Request, res: Response, next: () => void) => void;
  partyOrArbitrator: (req: Request, res: Response) => Promise<unknown | null>;
};

export function registerCourtRoutes(app: Express, access?: CourtAccess) {
  fs.mkdirSync(DIR, { recursive: true });

  app.post('/api/court/:caseId/transcript', (req, res) => {
    const token = process.env.COURT_WRITE_TOKEN?.trim();
    if (!token || req.get('x-court-token') !== token) return res.status(401).json({ message: 'Not allowed.' });
    const caseId = String(req.params.caseId);
    if (!validCase(caseId)) return res.status(400).json({ message: 'Invalid case.' });
    const { transcript, hash } = req.body ?? {};
    if (typeof transcript !== 'string' || keccak256(toBytes(transcript)) !== hash) {
      return res.status(400).json({ message: 'Transcript does not match its hash.' });
    }
    let parsed: { caseId?: unknown };
    try {
      parsed = JSON.parse(transcript);
    } catch {
      return res.status(400).json({ message: 'Transcript is not JSON.' });
    }
    if (String(parsed.caseId) !== caseId) return res.status(400).json({ message: 'Transcript is for another case.' });
    fs.writeFileSync(fileOf(caseId), transcript, 'utf8');
    res.json({ ok: true, hash });
  });

  // Readers: Chainlink WF3 (x-court-token), or a signed-in party of the case, or a verified arbitrator.
  const canRead = async (req: Request, res: Response): Promise<boolean> => {
    const token = process.env.COURT_WRITE_TOKEN?.trim();
    if (token && req.get('x-court-token') === token) return true;
    if (!access) { res.status(401).json({ message: 'Not allowed.' }); return false; }
    let signedIn = false;
    access.requireWallet(req, res, () => { signedIn = true; });
    if (!signedIn) return false; // requireWallet already answered 401
    return (await access.partyOrArbitrator(req, res)) !== null; // answered 403/404 itself when not allowed
  };

  app.get('/api/court/:caseId/transcript', async (req, res) => {
    const caseId = String(req.params.caseId);
    if (!validCase(caseId) || !fs.existsSync(fileOf(caseId))) return res.status(404).json({ message: 'No transcript yet.' });
    if (!(await canRead(req, res))) return;
    res.type('application/json').send(fs.readFileSync(fileOf(caseId), 'utf8'));
  });

  app.get('/api/court/:caseId', async (req, res) => {
    const caseId = String(req.params.caseId);
    if (!validCase(caseId) || !fs.existsSync(fileOf(caseId))) return res.status(404).json({ message: 'No transcript yet.' });
    if (!(await canRead(req, res))) return;
    const raw = fs.readFileSync(fileOf(caseId), 'utf8');
    res.json({ caseId, transcriptHash: keccak256(toBytes(raw)), transcript: JSON.parse(raw) });
  });
}
