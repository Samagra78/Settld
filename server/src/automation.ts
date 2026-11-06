// Settld automation: nobody has to click to move money.
//
// WATCHER (every WATCH_INTERVAL_MS): reads new Arc logs and runs the matching Chainlink CRE workflow
//   ClauseEscrow DealAccepted     → WF0 certify            (wf0-certify, log trigger 1)
//   ClauseEscrow ClauseSubmitted  → WF1 verify             (wf1-verify,  log trigger 0)
//   AICourt      CaseOpened       → WF3 round 0            (wf3-court,   log trigger 0)
//   AICourt      RoundCompleted   → WF3 next round         (wf3-court,   log trigger 1)
//   JurorRegistry PanelOpened     → remember the panel for the keeper
// Workflows run with `cre workflow simulate --broadcast` (our CRE account has simulation access), one at a time.
//
// KEEPER (every KEEPER_INTERVAL_MS): makes every permissionless "settle" move that the contracts accept:
//   escrow:   release, refund (incl. cascade), expire, resolveDispute, resolveStuckDispute
//   court:    closeCase, finalize, rescueFee
//   registry: closePanel
// Each move is first dry-run with eth_call (simulateContract). Only moves the contract would accept are sent,
// so the keeper follows the contracts' exact rules (windows, deadlines, one-day safety nets) by construction.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters, promisify } from 'node:util';
import type { Express } from 'express';
import {
  createWalletClient, http, isAddress, parseAbi, parseAbiItem, parseEventLogs, zeroAddress,
  type Abi, type AbiEvent, type Address, type Chain, type Hex, type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const runFile = promisify(execFile);
const env = (k: string) => process.env[k]?.trim() ?? '';

type Job = { workflow: string; trigger: number; target: string; txHash: Hex; eventIndex: number; label: string };
type Entry = { at: string; kind: 'workflow' | 'keeper'; label: string; ok: boolean; detail: string };

export type AutomationDeps = {
  arc: PublicClient;
  chain: Chain;
  escrowAbi: Abi;
  addresses: { clauseEscrow?: { address?: string }; aiCourt?: { address?: string }; jurorRegistry?: { address?: string } };
  escrowOverride?: string;
  creProject: string;
  /** Called once for every archived contract event (the database indexer). */
  onEvent?: (e: { name: string; contract: string; args: Record<string, unknown>; txHash: string; logIndex: number; block: bigint }) => void | Promise<void>;
  /** Saved automation state from the database (loaded before start), and how to save it. */
  initialState?: unknown;
  persist?: (state: unknown) => Promise<void>;
  /** Block to backfill the archive from on first start (e.g. the escrow's deploy block). */
  archiveFromBlock?: bigint;
};

// Events archived into the database (by contract). Job triggers above are a subset.
const ARCHIVE = {
  escrow: parseAbi([
    'event DealProposed(uint256 indexed dealId, address indexed brand, address indexed creator, bytes32 specHash)',
    'event DealAccepted(uint256 indexed dealId)',
    'event DealCertified(uint256 indexed dealId)',
    'event DealFunded(uint256 indexed dealId, uint256 total)',
    'event ClauseSubmitted(uint256 indexed dealId, uint8 clauseId, string videoId)',
    'event ClauseDisputed(uint256 indexed dealId, uint8 clauseId, uint256 caseId, address indexed disputer, string reason)',
    'event ClauseVerified(uint256 indexed dealId, uint8 clauseId)',
    'event ClauseFailed(uint256 indexed dealId, uint8 clauseId)',
    'event ClauseSettled(uint256 indexed dealId, uint8 clauseId, uint8 status, uint256 amount)',
    'event ClauseSplit(uint256 indexed dealId, uint8 clauseId, uint256 toFreelancer, uint256 toClient)',
  ]),
  court: parseAbi([
    'event CaseOpened(uint256 indexed caseId, uint256 dealId, uint8 clauseId, string reason, uint64 deadline)',
    'event RoundCompleted(uint256 indexed caseId, uint8 round, bytes32 transcriptHash)',
    'event ExtensionGranted(uint256 indexed caseId, uint16 wordBudget, uint64 deadline)',
    'event AIVerdict(uint256 indexed caseId, uint8 band, uint64 appealDeadline)',
    'event Appealed(uint256 indexed caseId, address by, uint256 fee)',
    'event Finalized(uint256 indexed caseId, uint8 band, bool byHumans)',
  ]),
  registry: parseAbi([
    'event PersonRegistered(uint256 indexed nullifier, address indexed wallet)',
    'event PanelOpened(uint256 indexed caseId, uint64 commitDeadline)',
    'event VoteCommitted(uint256 indexed caseId, address indexed arbitrator)',
    'event VoteRevealed(uint256 indexed caseId, address indexed arbitrator, uint8 band)',
    'event PanelClosed(uint256 indexed caseId, uint8 band, uint8 majoritySize)',
    'event Struck(uint256 indexed nullifier, uint8 strikes, bool suspended)',
  ]),
};

const courtAbi = parseAbi([
  'function closeCase(uint256 caseId)',
  'function finalize(uint256 caseId)',
  'function rescueFee(uint256 caseId)',
]);
const registryAbi = parseAbi(['function closePanel(uint256 caseId)']);
const settleAbi = parseAbi([
  'function release(uint256 dealId, uint8 clauseId)',
  'function refund(uint256 dealId, uint8 clauseId)',
  'function expire(uint256 dealId, uint8 clauseId)',
  'function resolveDispute(uint256 dealId, uint8 clauseId)',
  'function resolveStuckDispute(uint256 dealId, uint8 clauseId)',
]);

const EVENTS = {
  dealAccepted: parseAbiItem('event DealAccepted(uint256 indexed dealId)'),
  clauseSubmitted: parseAbiItem('event ClauseSubmitted(uint256 indexed dealId, uint8 clauseId, string videoId)'),
  caseOpened: parseAbiItem('event CaseOpened(uint256 indexed caseId, uint256 dealId, uint8 clauseId, string reason, uint64 deadline)'),
  roundCompleted: parseAbiItem('event RoundCompleted(uint256 indexed caseId, uint8 round, bytes32 transcriptHash)'),
  panelOpened: parseAbiItem('event PanelOpened(uint256 indexed caseId, uint64 commitDeadline)'),
} as const;

const STATUS = { Pending: 0, Submitted: 1, Verified: 2, Failed: 3, Disputed: 4, Released: 5, Refunded: 6 } as const;
const NO_DEP = 255;

type State = { lastBlock: string; archivedTo?: string; cases: string[]; panels: string[]; settledDeals: string[]; seen: string[]; jobs?: Job[] };

export function registerAutomation(app: Express, d: AutomationDeps) {
  const enabled = env('AUTOMATION_ENABLED') === 'true';
  const addr = (a?: string) => (a && isAddress(a) && a !== zeroAddress ? (a as Address) : undefined);
  const escrow = addr(d.escrowOverride) ?? addr(d.addresses.clauseEscrow?.address);
  const court = addr(d.addresses.aiCourt?.address);
  const registry = addr(d.addresses.jurorRegistry?.address);
  const wf3Target = env('WF3_TARGET') || 'production-settings';
  const recent: Entry[] = [];
  const queue: Job[] = [];
  let running: Job | null = null;

  const log = (e: Omit<Entry, 'at'>) => {
    recent.unshift({ at: new Date().toISOString(), ...e });
    recent.length = Math.min(recent.length, 50);
    console.log(`[automation] ${e.ok ? 'ok' : 'FAIL'} ${e.kind}: ${e.label}${e.detail ? ` — ${e.detail}` : ''}`);
  };

  // ---------- persistent state (survives restarts, so nothing runs twice) ----------
  const stateFile = path.resolve(process.cwd(), 'data', 'automation.json');
  const load = (): State => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as State;
    } catch {
      return { lastBlock: '', cases: [], panels: [], settledDeals: [], seen: [] };
    }
  };
  // state lives in the database when one is given (hosting wipes local files); the old file is the fallback
  const state: State = (d.initialState as State | null | undefined) ?? load();
  // Jobs survive a restart: the one that was running and any still queued are resumed
  if (state.jobs?.length) {
    queue.push(...state.jobs);
    console.log(`[automation] resuming ${state.jobs.length} saved workflow job(s): ${state.jobs.map((j) => j.label).join(', ')}`);
  }
  let saving: Promise<unknown> = Promise.resolve();
  const save = () => {
    state.seen = state.seen.slice(-500);
    state.jobs = [...(running ? [running] : []), ...queue];
    if (d.persist) {
      const snapshot = JSON.parse(JSON.stringify(state)) as State;
      saving = saving.then(() => d.persist!(snapshot)).catch((e) => console.error('[automation] save:', (e as Error).message));
      return;
    }
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  };

  app.get('/api/automation/status', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      enabled,
      contracts: { escrow: escrow ?? null, court: court ?? null, registry: registry ?? null },
      lastBlock: state.lastBlock || null,
      running: running?.label ?? null,
      queued: queue.map((j) => j.label),
      openCases: state.cases,
      openPanels: state.panels,
      recent,
    });
  });

  if (!enabled) {
    console.log('[automation] off (set AUTOMATION_ENABLED=true in server/.env to auto-run Chainlink workflows and the keeper)');
    return;
  }

  // ---------- WATCHER ----------
  const sources: { address?: Address; event: AbiEvent; job?: (l: { args: Record<string, unknown> }) => Omit<Job, 'txHash' | 'eventIndex'>; track?: 'cases' | 'panels' }[] = [
    { address: escrow, event: EVENTS.dealAccepted, job: (l) => ({ workflow: 'wf0-certify', trigger: 1, target: 'staging-settings', label: `WF0 certify deal ${l.args.dealId}` }) },
    { address: escrow, event: EVENTS.clauseSubmitted, job: (l) => ({ workflow: 'wf1-verify', trigger: 0, target: 'staging-settings', label: `WF1 verify deal ${l.args.dealId} clause ${l.args.clauseId}` }) },
    { address: court, event: EVENTS.caseOpened, track: 'cases', job: (l) => ({ workflow: 'wf3-court', trigger: 0, target: wf3Target, label: `WF3 case ${l.args.caseId} round 0` }) },
    { address: court, event: EVENTS.roundCompleted, job: (l) => ({ workflow: 'wf3-court', trigger: 1, target: wf3Target, label: `WF3 case ${l.args.caseId} after round ${l.args.round}` }) },
    { address: registry, event: EVENTS.panelOpened, track: 'panels' },
  ];

  type Log = { address: Address; eventName: string; args: Record<string, unknown>; transactionHash: Hex; logIndex: number; blockNumber: bigint };
  const archiveEvents: { address?: Address; events: AbiEvent[] }[] = [
    { address: escrow, events: ARCHIVE.escrow as unknown as AbiEvent[] },
    { address: court, events: ARCHIVE.court as unknown as AbiEvent[] },
    { address: registry, events: ARCHIVE.registry as unknown as AbiEvent[] },
  ];
  /** One getLogs for all contracts (address filter only — Arc rejects big topic filters), decoded here,
   *  keeping only each event from its own contract. */
  const fetchArchive = async (from: bigint, to: bigint): Promise<Log[]> => {
    const parts = archiveEvents.filter((p) => p.address);
    if (!parts.length) return [];
    const raw = await d.arc.getLogs({ address: parts.map((p) => p.address!), fromBlock: from, toBlock: to } as never);
    const logs = parseEventLogs({ abi: parts.flatMap((p) => p.events), logs: raw as never, strict: false }) as unknown as Log[];
    return logs.filter((l) => parts.some((p) =>
      p.address!.toLowerCase() === l.address.toLowerCase() && p.events.some((e) => e.name === l.eventName)));
  };
  const archive = async (l: Log) => {
    try {
      await d.onEvent?.({ name: l.eventName, contract: l.address, args: l.args, txHash: l.transactionHash, logIndex: l.logIndex, block: l.blockNumber });
    } catch (e) {
      console.error('[automation] archive:', (e as Error).message);
    }
  };

  // First start: backfill the archive (no workflow jobs) from the deploy block, in 2000-block chunks
  const backfill = async (until: bigint) => {
    if (!d.onEvent || !d.archiveFromBlock || state.archivedTo) return;
    let from = d.archiveFromBlock;
    while (from <= until) {
      const to = until - from > 1999n ? from + 1999n : until;
      for (const l of await fetchArchive(from, to)) await archive(l);
      from = to + 1n;
    }
    state.archivedTo = until.toString();
    save();
    console.log(`[automation] archive backfilled from block ${d.archiveFromBlock} to ${until}`);
  };

  let watching = false;
  const watch = async () => {
    if (watching) return;
    watching = true;
    try {
      const latest = await d.arc.getBlockNumber();
      if (!state.lastBlock) {
        state.lastBlock = latest.toString(); // jobs start from now; don't replay history
        save();
        await backfill(latest); // …but the archive gets the history
        return;
      }
      if (!state.archivedTo) await backfill(BigInt(state.lastBlock));
      const from = BigInt(state.lastBlock) + 1n;
      if (from > latest) return;
      const to = latest - from > 1999n ? from + 1999n : latest;

      // ONE log query per tick for every contract and event (Arc's public RPC rate-limits bursts)
      const active = sources.filter((s) => s.address);
      const all = await fetchArchive(from, to);
      for (const l of all) await archive(l);
      for (const s of active) {
        const logs = all.filter((l) => l.eventName === s.event.name && l.address.toLowerCase() === s.address!.toLowerCase());
        for (const l of logs) {
          const key = `${l.transactionHash}:${l.logIndex}`;
          if (state.seen.includes(key)) continue;
          state.seen.push(key);
          if (s.track) {
            const id = String(l.args.caseId);
            if (!state[s.track].includes(id)) state[s.track].push(id);
          }
          if (s.job) {
            // CRE wants the log's position inside its transaction receipt, not the block-wide logIndex
            const receipt = await d.arc.getTransactionReceipt({ hash: l.transactionHash });
            const eventIndex = receipt.logs.findIndex((r) => r.logIndex === l.logIndex);
            queue.push({ ...s.job(l), txHash: l.transactionHash, eventIndex: Math.max(0, eventIndex) });
            save();
          }
        }
      }
      state.lastBlock = to.toString();
      save();
      void drain();
    } catch (e) {
      console.error('[automation] watcher:', (e as Error).message.split('\n')[0]);
    } finally {
      watching = false;
    }
  };

  const runWorkflow = async (j: Job): Promise<{ ok: boolean; detail: string }> => {
    try {
      const { stdout } = await runFile(env('CRE_BINARY') || 'cre', [
        'workflow', 'simulate', `./${j.workflow}`, '--target', j.target, '--non-interactive',
        '--trigger-index', String(j.trigger), '--evm-tx-hash', j.txHash, '--evm-event-index', String(j.eventIndex),
        '--broadcast',
      ], { cwd: d.creProject, timeout: 170_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      const out = stripVTControlCharacters(stdout);
      if (!out.includes('Workflow Simulation Result:')) {
        return { ok: false, detail: (out.match(/✗.*$/gm)?.at(-1) ?? 'no result').slice(0, 300) };
      }
      return { ok: true, detail: (out.split('Workflow Simulation Result:').at(-1)?.trim().split('\n')[0] ?? '').slice(0, 300) };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      const msg = stripVTControlCharacters(`${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message}`);
      return { ok: false, detail: (msg.match(/✗.*$/gm)?.at(-1) ?? msg.match(/error.*$/im)?.[0] ?? 'workflow failed').slice(0, 300) };
    }
  };

  const drain = async () => {
    if (running) return;
    while (queue.length) {
      running = queue.shift()!;
      save();
      const j = running;
      // Retries with back-off: the CRE CLI can time out on its login check, and Arc's public RPC
      // rate-limits (429). Court rounds use short waits so they still land before the case deadline.
      const waits = j.workflow === 'wf3-court' ? [10, 20, 30] : [20, 40, 80];
      for (let attempt = 0; attempt <= waits.length; attempt++) {
        const r = await runWorkflow(j);
        if (r.ok || attempt === waits.length) {
          log({ kind: 'workflow', label: attempt > 0 ? `${j.label} (attempt ${attempt + 1})` : j.label, ok: r.ok, detail: r.detail });
          break;
        }
        console.log(`[automation] ${j.label} failed (${r.detail.slice(0, 120)}), retrying in ${waits[attempt]} s`);
        await new Promise((res) => setTimeout(res, waits[attempt] * 1000));
      }
      running = null;
      save();
    }
  };

  // ---------- KEEPER ----------
  const keyHex = env('KEEPER_PRIVATE_KEY');
  const keeper = keyHex
    ? createWalletClient({ account: privateKeyToAccount((keyHex.startsWith('0x') ? keyHex : `0x${keyHex}`) as Hex), chain: d.chain, transport: http(undefined, { retryCount: 8, retryDelay: 1500 }) })
    : null;
  if (!keeper) console.log('[automation] keeper off: set KEEPER_PRIVATE_KEY (a funded test wallet) in server/.env');

  /** Dry-run, and only send if the contract would accept it. */
  const tryMove = async (address: Address, abi: Abi, functionName: string, args: unknown[], label: string): Promise<boolean> => {
    if (!keeper) return false;
    try {
      const { request } = await d.arc.simulateContract({ account: keeper.account, address, abi, functionName, args } as never);
      const hash = await keeper.writeContract(request as never);
      const receipt = await d.arc.waitForTransactionReceipt({ hash });
      log({ kind: 'keeper', label, ok: receipt.status === 'success', detail: hash });
      return receipt.status === 'success';
    } catch {
      return false; // not allowed yet (window open, no verdict, already done…) — try again next tick
    }
  };

  type ClauseView = { status: number; dependsOn: number; deadline: bigint };
  let keeping = false;
  const keep = async () => {
    if (keeping || !keeper) return;
    keeping = true;
    try {
      // court + panels first, so a final verdict can be paid out in the same tick
      for (const id of [...state.panels]) {
        if (registry && (await tryMove(registry, registryAbi, 'closePanel', [BigInt(id)], `closePanel case ${id}`))) {
          state.panels = state.panels.filter((p) => p !== id);
        }
      }
      for (const id of [...state.cases]) {
        if (!court) break;
        await tryMove(court, courtAbi, 'closeCase', [BigInt(id)], `closeCase ${id} (AI verdict)`);
        if (await tryMove(court, courtAbi, 'finalize', [BigInt(id)], `finalize case ${id}`)) {
          state.cases = state.cases.filter((c) => c !== id);
        } else {
          await tryMove(court, courtAbi, 'rescueFee', [BigInt(id)], `rescueFee case ${id} (1-day safety net)`);
        }
      }

      if (escrow) {
        const count = Number(await d.arc.readContract({ address: escrow, abi: d.escrowAbi, functionName: 'dealCount' }));
        const now = (await d.arc.getBlock()).timestamp;
        for (let dealId = 1; dealId <= count; dealId++) {
          if (state.settledDeals.includes(String(dealId))) continue;
          const clauses = (await d.arc.readContract({
            address: escrow, abi: d.escrowAbi, functionName: 'getClauses', args: [BigInt(dealId)],
          })) as ClauseView[];
          for (let i = 0; i < clauses.length; i++) {
            const c = clauses[i];
            const s = Number(c.status);
            if (s === STATUS.Released || s === STATUS.Refunded) continue;
            const dep = Number(c.dependsOn) === NO_DEP ? undefined : clauses[Number(c.dependsOn)];
            const args = [BigInt(dealId), i];
            const tag = `deal ${dealId} clause ${i}`;
            if (dep && Number(dep.status) === STATUS.Refunded && (await tryMove(escrow, settleAbi, 'refund', args, `refund ${tag} (cascade)`))) continue;
            if (s === STATUS.Verified) await tryMove(escrow, settleAbi, 'release', args, `release ${tag}`);
            else if (s === STATUS.Failed) await tryMove(escrow, settleAbi, 'refund', args, `refund ${tag}`);
            else if (s === STATUS.Disputed) {
              if (!(await tryMove(escrow, settleAbi, 'resolveDispute', args, `resolveDispute ${tag} (court split)`))) {
                await tryMove(escrow, settleAbi, 'resolveStuckDispute', args, `resolveStuckDispute ${tag} (1-day safety net)`);
              }
            } else if ((s === STATUS.Pending || s === STATUS.Submitted) && BigInt(c.deadline) < now) {
              await tryMove(escrow, settleAbi, 'expire', args, `expire ${tag}`);
            }
          }
          const after = (await d.arc.readContract({
            address: escrow, abi: d.escrowAbi, functionName: 'getClauses', args: [BigInt(dealId)],
          })) as ClauseView[];
          if (after.length && after.every((c) => Number(c.status) === STATUS.Released || Number(c.status) === STATUS.Refunded)) {
            state.settledDeals.push(String(dealId));
          }
        }
      }
      save();
    } catch (e) {
      console.error('[automation] keeper:', (e as Error).message.split('\n')[0]);
    } finally {
      keeping = false;
    }
  };

  const watchMs = Number(env("WATCH_INTERVAL_MS")) || 6000;
  const keepMs = Number(env('KEEPER_INTERVAL_MS')) || 30_000;
  setInterval(() => void watch(), watchMs);
  setInterval(() => void keep(), keepMs);
  void watch();
  if (queue.length) void drain(); // resume saved jobs
  console.log(
    `[automation] on — watching escrow ${escrow ?? '-'}, court ${court ?? '-'}, registry ${registry ?? '-'}; ` +
      `keeper ${keeper ? keeper.account.address : 'off'} every ${keepMs / 1000}s`
  );
}
