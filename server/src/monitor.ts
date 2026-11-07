// Live backend monitor (developer page, not part of the app UI): http://localhost:3000/monitor
// Shows each deal's whole story in plain English (contract text → smart clauses → Arc → Chainlink →
// work → dispute → AI court → parties' chance to question → human arbitrators → payout), plus the raw
// watcher/keeper activity and contract events. Not served in production.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { formatUnits } from 'viem';
import * as store from './store.js';
import { extractClauses } from './extract.js';

type Step = { at: string; icon: string; title: string; detail: string; tx?: string; phase: string };

const usdc = (v: unknown) => `${formatUnits(BigInt(String(v ?? 0)), 6)} USDC`;
const pct = (b: unknown) => (Number(b) === 255 ? 'no decision' : `${b}%`);

async function transcriptRound(caseId: number, round: number) {
  const raw = await store.getTranscript(String(caseId));
  if (!raw) return null;
  const t = JSON.parse(raw);
  const r = t.rounds?.find((x: { round: number }) => x.round === round);
  return r ? { judges: t.judges as string[], round: r } : null;
}

/** Everything that happened to one deal, as plain-English steps in order. */
async function storyOf(dealId: number): Promise<Step[]> {
  const deal = await store.getDeal(dealId);
  const who = (addr: unknown) => {
    const a = String(addr ?? '').toLowerCase();
    return a && a === deal?.client ? 'The client' : a && a === deal?.freelancer ? 'The freelancer' : 'Someone';
  };
  const caseIds = await store.caseIdsOfDeal(dealId);
  const allEvents = await store.listEvents();
  const events = allEvents
    .map((e): Record<string, any> => ({ ...e, args: JSON.parse(e.args_json) }))
    .filter((e) => Number(e.args.dealId) === dealId || (e.args.caseId !== undefined && caseIds.includes(Number(e.args.caseId))));
  const panelTx = new Set(events.filter((e) => e.name === 'PanelClosed').map((e) => e.tx_hash));
  const strikes = allEvents.filter((e) => e.name === 'Struck')
    .filter((e) => panelTx.has(e.tx_hash)).map((e): Record<string, any> => ({ ...e, args: JSON.parse(e.args_json) }));

  const steps: Step[] = (await store.storyOf(dealId))
    .map((s) => ({ at: s.at, icon: s.icon, title: s.title, detail: s.detail, phase: 'Agreeing the contract' }));

  const first = (e: Record<string, any>) => (e.name === 'ClauseDisputed' || e.name === 'Appealed' ? 0 : 1); // the person's action before what it triggers
  for (const e of [...events, ...strikes].sort((x, y) => x.block - y.block || (x.tx_hash === y.tx_hash ? first(x) - first(y) : 0) || x.log_index - y.log_index)) {
    const a = e.args;
    const base = { at: e.seen_at, tx: e.tx_hash };
    const push = (phase: string, icon: string, title: string, detail = '') => steps.push({ ...base, phase, icon, title, detail });
    switch (e.name) {
      case 'DealProposed': push('Agreeing the contract', '📜', 'The contract went on the Arc blockchain', 'The client turned the agreed clauses into a smart contract (ClauseEscrow, built in Arc Studio). From now on, the rules are code: nobody can change them or move the money by hand.'); break;
      case 'DealAccepted': push('Agreeing the contract', '🤝', 'The freelancer accepted the terms'); break;
      case 'DealCertified': push('Agreeing the contract', '✅', 'Chainlink certified it: no money can ever get stuck', 'Chainlink\'s network re-ran the deadlock check on the exact terms stored on Arc and signed a certificate. Only now can the deal be funded.'); break;
      case 'DealFunded': push('Doing the work', '💰', `The client locked ${usdc(a.total)} in escrow`, 'The money sits in the smart contract — not with Settld, not with either party.'); break;
      case 'ClauseSubmitted': push('Doing the work', '📦', `The freelancer submitted the work for clause ${a.clauseId}`, String(a.videoId)); break;
      case 'ClauseVerified': push('Checking the work', '🔎', `Chainlink checked the work: PASSED`, 'Either side now has 2 minutes to question this result before the money moves.'); break;
      case 'ClauseFailed': push('Checking the work', '🔎', `Chainlink checked the work: FAILED`, 'Either side now has 2 minutes to question this result before the client is refunded.'); break;
      case 'ClauseDisputed': push('Questioning the result', '✋', `${who(a.disputer)} questioned the result`, `"${a.reason}" — the money for this clause is frozen and the case goes to the AI court.`); break;
      case 'CaseOpened': push('AI court', '⚖️', `The AI court opened (case #${a.caseId})`, '3 AI judges from 3 different companies — OpenAI (gpt-oss), Google (Gemini) and NVIDIA (Nemotron). First they judge alone, then they debate. 200 words each, 3 minutes (5 at most).'); break;
      case 'RoundCompleted': {
        const r = await transcriptRound(Number(a.caseId), Number(a.round));
        const said = r ? r.round.judges.map((j: any, i: number) =>
          `${r.judges[i]} → ${j.band}%${j.isFinal ? ' (final)' : ''}${j.statement ? `: "${j.statement}"` : ''}`).join('\n') : '';
        push('AI court', '🗣️', Number(a.round) === 0 ? 'Round 0 — each judge decided alone, without seeing the others' : `Round ${a.round} — the judges answered each other`, said);
        break;
      }
      case 'ExtensionGranted': push('AI court', '➕', 'Two judges asked for more room: +100 words each and +60 seconds'); break;
      case 'AIVerdict': push('AI court', '🧑‍⚖️', `AI verdict: the freelancer should get ${pct(a.band)} of this clause`, 'Either side can now question this verdict for 2 minutes by paying 10% to take it to human arbitrators. If nobody does, it becomes final.'); break;
      case 'Appealed': push('Questioning the result', '✋', `${who(a.by)} questioned the AI verdict and paid ${usdc(a.fee)} to go to human arbitrators`); break;
      case 'PanelOpened': push('Human arbitrators', '👥', 'Human arbitrators were called', 'Only World ID-verified people — one seat per real human — who are not part of this deal can take a seat. Their votes stay hidden until everyone has voted.'); break;
      case 'VoteCommitted': push('Human arbitrators', '🔒', 'An arbitrator cast a hidden vote'); break;
      case 'VoteRevealed': push('Human arbitrators', '🔓', `An arbitrator revealed their vote: ${pct(a.band)}`); break;
      case 'PanelClosed': push('Human arbitrators', '👥', `The arbitrators decided: ${pct(a.band)}`, `${a.majoritySize} arbitrator(s) in the majority share the appeal fee.`); break;
      case 'Struck': push('Human arbitrators', '⚠️', `An arbitrator voted against the majority — strike ${a.strikes}${a.suspended ? ' (now suspended)' : ''}`, 'The strike is tied to their World ID, so a new wallet can\'t reset it.'); break;
      case 'Finalized': push('Final decision', '🏁', `Final decision: the freelancer gets ${pct(a.band)}`, a.byHumans ? 'Decided by the human arbitrators.' : 'Nobody questioned the AI verdict, so it stands.'); break;
      case 'ClauseSplit': push('Getting paid', '💸', `Paid out: ${usdc(a.toFreelancer)} to the freelancer, ${usdc(a.toClient)} back to the client`); break;
      case 'ClauseSettled': if (!events.some((x) => x.name === 'ClauseSplit' && x.tx_hash === e.tx_hash)) {
        push('Getting paid', '💸', Number(a.status) === 5 ? `Paid out: ${usdc(a.amount)} to the freelancer` : `Refunded: ${usdc(a.amount)} back to the client`);
      } break;
    }
  }
  return steps;
}

export function registerMonitor(app: Express, contracts: Record<string, string | undefined>, explorer: string) {
  const prod = process.env.NODE_ENV === 'production';
  // hosted: only the read-only monitor, and only when MONITOR_PUBLIC=true (the dev POST helpers stay off)
  if (prod && process.env.MONITOR_PUBLIC !== 'true') return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  app.get('/monitor', (_req, res) => res.sendFile(path.join(here, '..', 'public', 'monitor.html')));
  app.get('/api/monitor', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      contracts, explorer, database: store.backend(),
      stats: await store.stats(),
      deals: await store.listDeals(20),
      cases: await store.listCases(20),
      votes: await store.listVotes(30),
      events: await store.listEvents(60),
    });
  });
  app.get('/api/monitor/story/:dealId', async (req, res) => {
    const dealId = Number(req.params.dealId);
    if (!Number.isInteger(dealId) || dealId < 1) return res.status(400).json({ message: 'Invalid deal.' });
    res.set('Cache-Control', 'no-store').json({ dealId, explorer, steps: await storyOf(dealId) });
  });

  if (prod) return;
  // Dev-only helpers used by scripts/e2e-dispute.ts to record the off-chain start of the story
  app.post('/api/monitor/extract', async (req, res) => {
    const text = String(req.body?.text ?? '');
    if (text.trim().length < 20) return res.status(400).json({ message: 'text required' });
    const r = await extractClauses(text, String(req.body?.startDate ?? ''));
    if (!r) return res.status(502).json({ message: 'The AI models did not answer.' });
    res.json(r);
  });
  app.post('/api/monitor/story', async (req, res) => {
    const { dealId, icon, title, detail } = req.body ?? {};
    if (!Number.isInteger(Number(dealId)) || typeof title !== 'string') return res.status(400).json({ message: 'dealId + title' });
    await store.addStory(Number(dealId), String(icon ?? '•'), title.slice(0, 200), String(detail ?? '').slice(0, 4000));
    res.json({ ok: true });
  });
}
