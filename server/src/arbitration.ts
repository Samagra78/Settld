// Arbitration backend: the court section is ONLY for World ID-verified arbitrators.
//
// Who is an arbitrator: a wallet registered on JurorRegistry (registerPerson with a World ID attestation).
// Checked against the chain (nullifierOf != 0), cached for 30 s; the database only speeds up lists.
//
// Arbitrators (requireArbitrator):
//   GET  /api/arbitrator/dashboard          profile (cases, right/wrong calls, strikes, suspended, fees) + history
//   GET  /api/arbitrator/cases              appealed cases with an open panel (+ whether I can take a seat)
//   GET  /api/arbitrator/cases/:caseId      full case file: clause terms, evidence, reason, AI debate, AI verdict, panel
//   POST /api/arbitrator/commit | reveal    (existing routes in worldid.ts, now arbitrator-only)
// Parties (client / freelancer of that deal):
//   POST /api/escrow/dispute                { dealId, clauseId, reason }  → Circle challenge (PIN)
//   GET  /api/court/:caseId/status          AI verdict, appeal window, fee, final band (parties + arbitrators)
//   POST /api/court/:caseId/approve-fee     approve the 10% appeal fee (USDC) → Circle challenge
//   POST /api/court/:caseId/appeal          appeal to human arbitrators → Circle challenge
// Anyone signed in:
//   GET  /api/arbitrator/me                 am I verified / an arbitrator? (to show or hide the court tab)
// Public:
//   GET  /api/arbitrators/stats             how many verified humans / arbitrators, open panels, cases decided
//   GET  /api/worldid/status/:wallet        { verified } for the ✓ badge (no nullifier exposed)

import type { Express, NextFunction, Request, Response } from 'express';
import { isAddress, parseAbi, zeroAddress, type Abi, type Address, type PublicClient } from 'viem';
import * as store from './store.js';

type CircleResult = { status: number; ok: boolean; json: any };
type Session = { address: string; walletId: string; userToken: string };

export type ArbitrationDeps = {
  requireWallet: (req: Request, res: Response, next: NextFunction) => void;
  sessionOf: (res: Response) => Session;
  contractCall: (
    userToken: string, walletId: string, contractAddress: string,
    abiFunctionSignature: string, abiParameters: unknown[], refId?: string,
  ) => Promise<CircleResult>;
  reply: (res: Response, r: CircleResult) => void;
  arc: PublicClient;
  escrow: string;
  court?: string;
  registry?: string;
  usdc: string;
  escrowAbi: Abi;
};

const registryAbi = parseAbi([
  'function nullifierOf(address) view returns (uint256)',
  'function profile(uint256 nullifier) view returns (uint32 cases, uint32 withMajority, uint8 strikes, bool suspended)',
  'function getPanel(uint256 caseId) view returns (address client, address freelancer, uint64 commitDeadline, uint64 revealEnd, uint8 commits, uint8 reveals, bool opened, bool closed, uint8 band, address[3] seats)',
  'function seated(uint256 caseId, uint256 nullifier) view returns (bool)',
]);
const courtAbi = parseAbi([
  'struct Case { uint256 dealId; address client; uint64 openedAt; address freelancer; uint64 deadline; uint16 wordBudget; uint8 clauseId; uint8 extensions; uint8 nextRound; bool aiSet; uint8 aiBand; uint64 appealDeadline; bool appealed; address appellant; uint64 appealedAt; uint256 feePaid; bool feeSettled; bool finalized; uint8 finalBand; bool byHumans; }',
  'function getCase(uint256 caseId) view returns (Case)',
  'function appealFee(uint256 caseId) view returns (uint256)',
]);

const lc = (a: string) => a.toLowerCase();
const isId = (v: unknown) => /^\d{1,30}$/.test(String(v));
const toJson = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const transcriptOf = async (caseId: string) => {
  const raw = await store.getTranscript(caseId);
  return raw ? JSON.parse(raw) : null;
};

export function registerArbitrationRoutes(app: Express, d: ArbitrationDeps) {
  const registry = d.registry && isAddress(d.registry) && d.registry !== zeroAddress ? (d.registry as Address) : undefined;
  const court = d.court && isAddress(d.court) && d.court !== zeroAddress ? (d.court as Address) : undefined;

  // ---------- who is an arbitrator (chain truth, 30 s cache) ----------
  const cache = new Map<string, { nullifier: bigint; at: number }>();
  const nullifierOf = async (wallet: string): Promise<bigint> => {
    const hit = cache.get(lc(wallet));
    if (hit && Date.now() - hit.at < 30_000) return hit.nullifier;
    if (!registry) return 0n;
    const n = await d.arc.readContract({ address: registry, abi: registryAbi, functionName: 'nullifierOf', args: [wallet as Address] });
    // only cache a yes: a fresh registration must show up straight away
    if (n !== 0n) cache.set(lc(wallet), { nullifier: n, at: Date.now() });
    return n;
  };

  const requireArbitrator = async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const n = await nullifierOf(d.sessionOf(res).address);
      if (n === 0n) {
        return res.status(403).json({ message: 'The court is only open to World ID-verified arbitrators. Verify with World ID and register first.' });
      }
      res.locals.nullifier = n;
      next();
    } catch {
      res.status(502).json({ message: 'Could not check your arbitrator status on Arc.' });
    }
  };

  // parties of a case (from the chain), for party-only and party-or-arbitrator routes
  const caseOnChain = async (caseId: string) => {
    if (!court) throw new Error('court not configured');
    return d.arc.readContract({ address: court, abi: courtAbi, functionName: 'getCase', args: [BigInt(caseId)] });
  };
  const isParty = (c: { client: string; freelancer: string }, wallet: string) =>
    lc(c.client) === lc(wallet) || lc(c.freelancer) === lc(wallet);

  // arbitrator-only gate for the vote routes defined in worldid.ts (registered before them, so it runs first)
  app.use(['/api/arbitrator/commit', '/api/arbitrator/reveal', '/api/arbitrator/panel'], d.requireWallet, requireArbitrator);

  // ---------- public ----------
  app.get('/api/arbitrators/stats', async (_req, res) => res.json(await store.stats()));

  app.get('/api/worldid/status/:wallet', async (req, res) => {
    const w = String(req.params.wallet);
    if (!isAddress(w)) return res.status(400).json({ message: 'Invalid wallet.' });
    const p = await store.personOf(w);
    res.json({ wallet: lc(w), verified: !!p, arbitrator: !!p?.arbitrator, verifiedAt: p?.verified_at ?? null });
  });

  // ---------- anyone signed in ----------
  app.get('/api/arbitrator/me', d.requireWallet, async (_req, res) => {
    const wallet = d.sessionOf(res).address;
    try {
      const n = await nullifierOf(wallet);
      res.json({ wallet: lc(wallet), verified: !!(await store.personOf(wallet)), arbitrator: n !== 0n, canAccessCourt: n !== 0n });
    } catch {
      res.status(502).json({ message: 'Could not check your arbitrator status on Arc.' });
    }
  });

  // ---------- arbitrators only ----------
  app.get('/api/arbitrator/dashboard', d.requireWallet, requireArbitrator, async (_req, res) => {
    const wallet = d.sessionOf(res).address;
    try {
      const [cases, withMajority, strikes, suspended] = await d.arc.readContract({
        address: registry!, abi: registryAbi, functionName: 'profile', args: [res.locals.nullifier as bigint],
      });
      const history = await Promise.all((await store.casesOfArbitrator(wallet)).map(async (row) => {
        const closed = row.in_majority !== null && row.in_majority !== undefined;
        const majority = closed ? (await store.panelVotes(Number(row.case_id))).filter((v) => v.in_majority === 1).length : 0;
        const fee = row.in_majority === 1 && row.status === 'final' && majority
          ? (BigInt(String((await store.getCase(Number(row.case_id)))?.appeal_fee ?? '0')) / BigInt(majority)).toString()
          : '0';
        return {
          caseId: row.case_id, dealId: row.deal_id, clauseId: row.clause_id, reason: row.reason,
          myBand: row.revealed ? row.band : null, revealed: !!row.revealed,
          aiBand: row.ai_band, panelBand: row.panel_band, finalBand: row.final_band,
          outcome: !closed ? 'pending' : row.in_majority === 1 ? 'with_majority' : 'against_majority',
          feeEarnedUnits: fee, status: row.status, finalizedAt: row.finalized_at,
        };
      }));
      const decided = history.filter((h) => h.outcome !== 'pending');
      res.json({
        wallet: lc(wallet),
        profile: { cases, withMajority, strikes, suspended },
        totals: {
          casesTaken: history.length,
          casesDecided: decided.length,
          rightCalls: decided.filter((h) => h.outcome === 'with_majority').length,
          wrongCalls: decided.filter((h) => h.outcome === 'against_majority').length,
          pending: history.length - decided.length,
          feesEarnedUnits: history.reduce((s, h) => s + BigInt(h.feeEarnedUnits), 0n).toString(),
        },
        history,
      });
    } catch {
      res.status(502).json({ message: 'Could not load the arbitrator dashboard.' });
    }
  });

  app.get('/api/arbitrator/cases', d.requireWallet, requireArbitrator, async (_req, res) => {
    const wallet = d.sessionOf(res).address;
    const nullifier = res.locals.nullifier as bigint;
    try {
      const out = [];
      for (const row of await store.openPanels()) {
        const caseId = BigInt(String(row.case_id));
        const [client, freelancer, commitDeadline, revealEnd, commits, reveals, , closed] = await d.arc.readContract({
          address: registry!, abi: registryAbi, functionName: 'getPanel', args: [caseId],
        });
        if (closed) continue;
        const mySeat = await d.arc.readContract({ address: registry!, abi: registryAbi, functionName: 'seated', args: [caseId, nullifier] });
        const party = isParty({ client, freelancer }, wallet);
        const now = Math.floor(Date.now() / 1000);
        out.push({
          caseId: row.case_id, dealId: row.deal_id, clauseId: row.clause_id, reason: row.reason, aiBand: row.ai_band,
          commitDeadline: Number(commitDeadline), revealDeadline: Number(revealEnd), seatsTaken: commits, reveals,
          mySeat, canJoin: !mySeat && !party && commits < 3 && now <= Number(commitDeadline),
          blockedReason: party ? 'You are a party to this deal' : commits >= 3 && !mySeat ? 'Panel full' : null,
        });
      }
      res.json({ cases: out });
    } catch {
      res.status(502).json({ message: 'Could not load open cases.' });
    }
  });

  app.get('/api/arbitrator/cases/:caseId', d.requireWallet, requireArbitrator, async (req, res) => {
    const caseId = String(req.params.caseId);
    if (!isId(caseId)) return res.status(400).json({ message: 'Invalid case.' });
    try {
      const c = await caseOnChain(caseId);
      if (!c.appealed) return res.status(404).json({ message: 'This case was not appealed, so it is not in the human court.' });
      if (isParty(c, d.sessionOf(res).address)) return res.status(403).json({ message: 'You are a party to this deal and cannot judge it.' });
      const clause = await d.arc.readContract({ address: d.escrow as Address, abi: d.escrowAbi, functionName: 'getClause', args: [c.dealId, c.clauseId] });
      const evidence = await d.arc.readContract({ address: d.escrow as Address, abi: d.escrowAbi, functionName: 'evidenceOf', args: [c.dealId, c.clauseId] });
      const [, , commitDeadline, revealEnd, commits, reveals, opened, closed, band] = await d.arc.readContract({
        address: registry!, abi: registryAbi, functionName: 'getPanel', args: [BigInt(caseId)],
      });
      const row = await store.getCase(Number(caseId));
      res.json(toJson({
        caseId, dealId: c.dealId, clauseId: c.clauseId, clause, evidence, reason: row?.reason ?? null,
        aiVerdict: { band: c.aiBand, rounds: c.nextRound, extensions: c.extensions },
        aiTranscript: await transcriptOf(caseId),
        appeal: { appellant: c.appellant, feePaid: c.feePaid, appealedAt: c.appealedAt },
        panel: {
          opened, closed, commitDeadline, revealDeadline: revealEnd, seatsTaken: commits, reveals,
          // votes stay hidden until the panel closes
          band: closed ? band : null, votes: closed ? await store.panelVotes(Number(caseId)) : null,
        },
        final: { finalized: c.finalized, band: c.finalized ? c.finalBand : null, byHumans: c.byHumans },
      }));
    } catch {
      res.status(502).json({ message: 'Could not load the case.' });
    }
  });

  // ---------- parties ----------
  app.post('/api/escrow/dispute', d.requireWallet, async (req, res) => {
    const { dealId, clauseId, reason } = req.body ?? {};
    if (!isId(dealId) || !/^\d{1,3}$/.test(String(clauseId)) || Number(clauseId) > 255) {
      return res.status(400).json({ message: 'Send dealId and clauseId.' });
    }
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) {
      return res.status(400).json({ message: 'Give a reason (1–500 characters).' });
    }
    const { userToken, walletId, address } = d.sessionOf(res);
    try {
      await d.arc.simulateContract({
        address: d.escrow as Address, abi: d.escrowAbi, functionName: 'dispute',
        args: [BigInt(dealId), Number(clauseId), reason.trim()], account: address as Address,
      });
    } catch {
      return res.status(422).json({ message: 'This clause cannot be disputed now (only a party, only on a Verified or Failed clause, only inside the 120 s window).' });
    }
    d.reply(res, await d.contractCall(userToken, walletId, d.escrow, 'dispute(uint256,uint8,string)', [String(dealId), String(clauseId), reason.trim()]));
  });

  const partyOrArbitrator = async (req: Request, res: Response) => {
    const caseId = String(req.params.caseId);
    if (!isId(caseId)) { res.status(400).json({ message: 'Invalid case.' }); return null; }
    try {
      const c = await caseOnChain(caseId);
      const wallet = d.sessionOf(res).address;
      if (!isParty(c, wallet) && (await nullifierOf(wallet)) === 0n) {
        res.status(403).json({ message: 'Only the parties of this deal and verified arbitrators can see this case.' });
        return null;
      }
      return { caseId, c, wallet };
    } catch {
      res.status(404).json({ message: 'Case not found.' });
      return null;
    }
  };

  app.get('/api/court/:caseId/status', d.requireWallet, async (req, res) => {
    const ok = await partyOrArbitrator(req, res);
    if (!ok) return;
    const fee = await d.arc.readContract({ address: court!, abi: courtAbi, functionName: 'appealFee', args: [BigInt(ok.caseId)] }).catch(() => 0n);
    const now = Math.floor(Date.now() / 1000);
    const c = ok.c;
    res.json(toJson({
      caseId: ok.caseId, dealId: c.dealId, clauseId: c.clauseId, deadline: c.deadline, rounds: c.nextRound, wordBudget: c.wordBudget,
      aiVerdict: c.aiSet ? c.aiBand : null, appealDeadline: c.aiSet ? c.appealDeadline : null,
      canAppeal: c.aiSet && !c.appealed && now <= Number(c.appealDeadline) && isParty(c, ok.wallet),
      appealFeeUnits: fee, appealed: c.appealed, appellant: c.appealed ? c.appellant : null,
      finalized: c.finalized, finalBand: c.finalized ? c.finalBand : null, byHumans: c.byHumans,
    }));
  });

  const partyOnly = async (req: Request, res: Response) => {
    const ok = await partyOrArbitrator(req, res);
    if (!ok) return null;
    if (!isParty(ok.c, ok.wallet)) { res.status(403).json({ message: 'Only the client or the freelancer can appeal.' }); return null; }
    return ok;
  };

  app.post('/api/court/:caseId/approve-fee', d.requireWallet, async (req, res) => {
    const ok = await partyOnly(req, res);
    if (!ok) return;
    const fee = await d.arc.readContract({ address: court!, abi: courtAbi, functionName: 'appealFee', args: [BigInt(ok.caseId)] });
    const { userToken, walletId } = d.sessionOf(res);
    d.reply(res, await d.contractCall(userToken, walletId, d.usdc, 'approve(address,uint256)', [court!, fee.toString()]));
  });

  app.post('/api/court/:caseId/appeal', d.requireWallet, async (req, res) => {
    const ok = await partyOnly(req, res);
    if (!ok) return;
    try {
      await d.arc.simulateContract({
        address: court!, abi: parseAbi(['function appeal(uint256 caseId)']), functionName: 'appeal',
        args: [BigInt(ok.caseId)], account: ok.wallet as Address,
      });
    } catch {
      return res.status(422).json({ message: 'Appeal not possible now: approve the fee first, and appeal within 120 s of the AI verdict.' });
    }
    const { userToken, walletId } = d.sessionOf(res);
    d.reply(res, await d.contractCall(userToken, walletId, court!, 'appeal(uint256)', [ok.caseId]));
  });

  return { requireArbitrator, partyOrArbitrator };
}
