// AI court transcript store.
//
// WF3 (Chainlink CRE) writes each round's full transcript here, and records only its keccak256 hash
// on-chain (AICourt RoundCompleted.transcriptHash). The next WF3 round fetches it back and checks the
// hash, so this server can store the text but can never change what the judges said.
//
//   POST /api/court/:caseId/transcript  { transcript, hash }  header x-court-token   (WF3 only)
//   GET  /api/court/:caseId/transcript  → the exact stored JSON text (hashed as-is by WF3)
//   GET  /api/court/:caseId             → parsed transcript + hash, for the courtroom screen

import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { keccak256, toBytes } from 'viem';

const DIR = path.resolve(process.cwd(), 'data', 'court');
const fileOf = (caseId: string) => path.join(DIR, `${caseId}.json`);
const validCase = (s: string) => /^(\d{1,78}|dry-run)$/.test(s);

export function registerCourtRoutes(app: Express) {
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

  app.get('/api/court/:caseId/transcript', (req, res) => {
    const caseId = String(req.params.caseId);
    if (!validCase(caseId) || !fs.existsSync(fileOf(caseId))) return res.status(404).json({ message: 'No transcript yet.' });
    res.type('application/json').send(fs.readFileSync(fileOf(caseId), 'utf8'));
  });

  app.get('/api/court/:caseId', (req, res) => {
    const caseId = String(req.params.caseId);
    if (!validCase(caseId) || !fs.existsSync(fileOf(caseId))) return res.status(404).json({ message: 'No transcript yet.' });
    const raw = fs.readFileSync(fileOf(caseId), 'utf8');
    res.json({ caseId, transcriptHash: keccak256(toBytes(raw)), transcript: JSON.parse(raw) });
  });
}
