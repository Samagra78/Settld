import 'dotenv/config';
import axios from 'axios';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  isAddress,
  maxUint256,
  parseAbi,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import addresses from '../../shared/addresses.json' with { type: 'json' };
import clauseEscrowAbi from '../../shared/abi/ClauseEscrow.json' with { type: 'json' };
import certifyConfig from '../../cre/wf0-certify/config.staging.json' with { type: 'json' };
import type { PublicClient } from 'viem';
import { registerWorldIdRoutes } from './worldid.js';
import { registerCourtRoutes } from './court.js';
import { registerAutomation } from './automation.js';
import { registerArbitrationRoutes } from './arbitration.js';
import { deleteSession, getState, initStore, loadSession, recordEvent, saveSession, setState, touchSession, type StoredSession } from './store.js';
import { registerMonitor } from './monitor.js';
import { registerExtractRoutes } from './extract.js';
import { registerDevTools } from './devtools.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// Hosted with the frontend on another domain: FRONTEND_ORIGIN=https://your-site (comma-separated) allows it to
// call the API with the login cookie. Unset = same-origin / local dev (Vite proxy).
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(FRONTEND_ORIGINS.length ? cors({ origin: FRONTEND_ORIGINS, credentials: true }) : cors());
app.set('trust proxy', 1); // behind the host's HTTPS proxy
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'settld-server' });
});

app.get('/api/hello', (_req, res) => {
  res.json({ message: 'hello from settld' });
});

const CIRCLE = 'https://api.circle.com';

// Thin wrapper around Circle's REST API. The API key stays on the server.
// User-scoped calls also send the user's token in X-User-Token.
type CircleOpts = {
  method?: 'GET' | 'POST';
  userToken?: string;
  body?: Record<string, unknown>;
};
type CircleResult = {
  status: number;
  ok: boolean;
  json: { data?: unknown; [key: string]: unknown };
};

async function circle(
  path: string,
  { method = 'GET', userToken, body }: CircleOpts = {},
): Promise<CircleResult> {
  const res = await axios.request({
    baseURL: CIRCLE,
    url: path,
    method,
    headers: {
      Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
      ...(userToken && { 'X-User-Token': userToken }),
    },
    data: body,
    // axios throws on non-2xx by default; we want to pass Circle's error body through
    validateStatus: () => true,
  });
  return { status: res.status, ok: res.status >= 200 && res.status < 300, json: res.data };
}

// Circle wraps success in { data }; errors are passed through unchanged
// (the frontend needs error codes, e.g. 155106 = user already initialized).
const reply = (res: Response, r: CircleResult) =>
  res.status(r.status).json(r.ok ? r.json.data : r.json);

// ---- Sessions: the server identifies the user by their wallet address -------
// Circle login proves who controls a wallet (email OTP + PIN). POST /api/session
// exchanges the short-lived Circle userToken for our own httpOnly cookie session
// keyed to that wallet. Protected routes then act ONLY as the session's wallet:
// the client can't pass a different walletId, address or userToken.

// Sessions are stored in MongoDB (store.ts), so redeploys and restarts don't sign anyone out.
// The expiry slides: every signed-in request pushes it SESSION_IDLE_MS into the future.
// The Circle userToken inside still dies 60 min after sign-in; routes that need it (PIN actions)
// then fail and the frontend asks for a fresh email code, which updates this same session.
type Session = StoredSession & { address: Address };
const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_HOURS || 12) * 3600_000;
const CIRCLE_TOKEN_MS = 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60_000; // write the new expiry at most once a minute per session
const COOKIE = 'settld_sid';
// small in-process cache in front of the store; the store stays the source of truth
const sessionCache = new Map<string, { s: Session; touchedAt: number }>();
// the database only ever sees a hash of the cookie, so a leaked sessions collection can't be replayed
const sessionKey = (sid: string) => createHash('sha256').update(sid).digest('hex');

const readCookie = (header: string | undefined, name: string) =>
  header
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([k]) => k === name)?.[1];

const cookieOpts = () => ({
  httpOnly: true,
  sameSite: (FRONTEND_ORIGINS.length ? 'none' : 'lax') as 'none' | 'lax', // cross-site frontend needs none (+ secure)
  secure: process.env.NODE_ENV === 'production' || FRONTEND_ORIGINS.length > 0,
  maxAge: SESSION_IDLE_MS,
});

async function getSession(req: Request, res: Response): Promise<Session | undefined> {
  const sid = readCookie(req.headers.cookie, COOKIE);
  if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return undefined;
  const key = sessionKey(sid);
  let hit = sessionCache.get(key);
  if (!hit) {
    const stored = await loadSession(key).catch(() => undefined);
    if (stored) hit = { s: stored as Session, touchedAt: 0 }; // 0: write the slid expiry back on this first use
  }
  if (!hit || hit.s.expiresAt < Date.now()) {
    sessionCache.delete(key);
    if (hit) await deleteSession(key).catch(() => {});
    return undefined;
  }
  // slide the expiry (cookie every time, database at most once a minute)
  hit.s.expiresAt = Date.now() + SESSION_IDLE_MS;
  if (Date.now() - hit.touchedAt > TOUCH_EVERY_MS) {
    hit.touchedAt = Date.now();
    void touchSession(key, hit.s.expiresAt).catch(() => {});
  }
  sessionCache.set(key, hit);
  res.cookie(COOKIE, sid, cookieOpts());
  return hit.s;
}

const requireWallet = async (req: Request, res: Response, next: NextFunction) => {
  const s = await getSession(req, res);
  if (!s) return res.status(401).json({ message: 'Not signed in' });
  res.locals.session = s;
  next();
};
const sessionOf = (res: Response) => res.locals.session as Session;

// Sign in: userToken (from Circle login) -> session for that user's wallet
app.post('/api/session', async (req, res) => {
  const w = await circle('/v1/w3s/wallets', { userToken: req.body.userToken });
  if (!w.ok) return reply(res, w);
  const wallets =
    (w.json.data as { wallets?: { id: string; address: string; blockchain: string }[] })
      .wallets ?? [];
  const wallet = wallets.find((x) => x.blockchain === 'ARC-TESTNET') ?? wallets[0];
  if (!wallet) return res.status(404).json({ message: 'No wallet yet' });

  // Several sessions per wallet are fine (tabs, devices). Signing in again in a browser that already has a
  // session for this wallet (e.g. a fresh email code after the Circle token expired) updates that session in place.
  const current = readCookie(req.headers.cookie, COOKIE);
  const existing = current && /^[0-9a-f]{64}$/.test(current)
    ? await loadSession(sessionKey(current)).catch(() => undefined) : undefined;
  const sid = existing && existing.address.toLowerCase() === wallet.address.toLowerCase()
    ? current! : randomBytes(32).toString('hex');
  const session: Session = {
    address: wallet.address as Address,
    walletId: wallet.id,
    blockchain: wallet.blockchain,
    userToken: req.body.userToken,
    tokenExpiresAt: Date.now() + CIRCLE_TOKEN_MS,
    expiresAt: Date.now() + SESSION_IDLE_MS,
  };
  try {
    await saveSession(sessionKey(sid), session);
  } catch {
    return res.status(503).json({ message: 'Could not save your sign-in. Try again.' });
  }
  sessionCache.set(sessionKey(sid), { s: session, touchedAt: Date.now() });
  res.cookie(COOKIE, sid, cookieOpts());
  res.json({ address: wallet.address, walletId: wallet.id, blockchain: wallet.blockchain });
});

// Who am I? Identity = wallet address.
app.get('/api/me', requireWallet, (_req, res) => {
  const { address, walletId, blockchain } = sessionOf(res);
  res.json({ address, walletId, blockchain });
});

app.post('/api/logout', async (req, res) => {
  const sid = readCookie(req.headers.cookie, COOKIE);
  if (sid) {
    sessionCache.delete(sessionKey(sid));
    await deleteSession(sessionKey(sid)).catch(() => {});
  }
  res.clearCookie(COOKIE, { ...cookieOpts(), maxAge: undefined });
  res.json({ ok: true });
});

// 1. Email OTP: returns { deviceToken, deviceEncryptionKey, otpToken }
app.post('/api/auth/email', async (req, res) => {
  const { deviceId, email } = req.body;
  reply(res, await circle('/v1/w3s/users/email/token', {
    method: 'POST',
    body: { idempotencyKey: crypto.randomUUID(), deviceId, email },
  }));
});

// 2. Create/initialize the user: returns { challengeId }
app.post('/api/user/initialize', async (req, res) => {
  reply(res, await circle('/v1/w3s/user/initialize', {
    method: 'POST',
    userToken: req.body.userToken,
    body: {
      idempotencyKey: crypto.randomUUID(),
      accountType: 'SCA',
      blockchains: ['ARC-TESTNET'],
    },
  }));
});

// 3. Wallets for the user: returns { wallets: [...] }
app.post('/api/wallets', async (req, res) => {
  reply(res, await circle('/v1/w3s/wallets', { userToken: req.body.userToken }));
});

// 4. Token balances for the signed-in wallet: returns { tokenBalances: [...] }
app.get('/api/balance', requireWallet, async (_req, res) => {
  const { walletId, userToken, tokenExpiresAt, address } = sessionOf(res);
  if (Date.now() < tokenExpiresAt) {
    const r = await circle(`/v1/w3s/wallets/${walletId}/balances`, { userToken });
    if (r.ok || (r.status !== 401 && r.status !== 403)) return reply(res, r);
  }
  // the session outlives the 60-min Circle token: read the balance straight from Arc, in Circle's shape
  try {
    const bal = await arc.readContract({
      address: USDC_ADDRESS as Address, abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf', args: [address],
    });
    res.json({ tokenBalances: [{ token: { symbol: 'USDC', decimals: 6, tokenAddress: USDC_ADDRESS }, amount: formatUnits(bal, 6) }], source: 'arc' });
  } catch {
    res.status(502).json({ message: 'Could not read your balance from Arc. Try again.' });
  }
});

// ---- Escrow transactions (user-controlled) ---------------------------------
// These routes only *prepare* a transaction and return a challengeId.
// The browser SDK then runs the challenge, where the user enters their PIN.

const USDC_ADDRESS = addresses.usdc; // 6 decimals
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS?.trim() || addresses.clauseEscrow.address;
const escrowAbi = clauseEscrowAbi as Abi;
const escrowUnavailable = 'ClauseEscrow is awaiting its Arc Testnet deployment address.';
const runFile = promisify(execFile);
const creProject = fileURLToPath(new URL('../../cre/', import.meta.url));
let certifying = false;

// Fixed contract + function per route (no generic "call anything" endpoint),
// so this server can only ever prepare the ClauseEscrow calls below.
const contractCall = (
  userToken: string,
  walletId: string,
  contractAddress: string,
  abiFunctionSignature: string,
  abiParameters: unknown[],
  refId?: string,
): Promise<CircleResult> => {
  if (!isAddress(ESCROW_ADDRESS) || ESCROW_ADDRESS === zeroAddress) {
    return Promise.resolve({ status: 503, ok: false, json: { message: escrowUnavailable } });
  }
  // Circle's PIN screen shows a blank amount for contract calls (nothing is sent with them); that's expected.
  return circle('/v1/w3s/user/transactions/contractExecution', {
    method: 'POST',
    userToken,
    body: {
      idempotencyKey: refId ?? crypto.randomUUID(),
      ...(refId && { refId }),
      walletId,
      contractAddress,
      abiFunctionSignature,
      abiParameters,
      // user-controlled wallets take a flat feeLevel; the nested `fee` object is ignored and Circle
      // then rejects the call ("gasPrice may not be empty when FeeLevel ... are not set")
      feeLevel: 'MEDIUM',
    },
  });
};

// amount is a string in 6-decimal units: 1 USDC = "1000000"

const isUnits = (v: unknown) => /^\d+$/.test(String(v)) && BigInt(String(v)) > 0n;
const isDealId = (v: unknown): v is string | number => (
  (typeof v === 'string' || (typeof v === 'number' && Number.isSafeInteger(v)))
  && /^\d{1,78}$/.test(String(v)) && BigInt(v) <= maxUint256
);
const bad = (res: Response, message: string) => res.status(400).json({ message });

// 5. Brand lets the escrow pull `amount` USDC
app.post('/api/escrow/approve', requireWallet, async (req, res) => {
  if (!isUnits(req.body.amount)) return bad(res, 'amount must be a positive integer (6-decimal units)');
  const { walletId, userToken, blockchain } = sessionOf(res);
  if (blockchain !== 'ARC-TESTNET') return bad(res, 'Approval requires an Arc Testnet wallet');
  reply(res, await contractCall(userToken, walletId, USDC_ADDRESS,
    'approve(address,uint256)', [ESCROW_ADDRESS, String(req.body.amount)]));
});

// ---- ClauseEscrow routes (see contracts/README.md) ----
// Ids are plain integers; the contract itself enforces who may call what.

const isU8 = (v: unknown) => /^\d+$/.test(String(v)) && Number(v) <= 255;

const escrowErrors: Record<string, string> = {
  UnknownDeal: 'This deal does not exist.',
  UnknownClause: 'This clause does not exist on the deal.',
  NotBrand: 'Only the brand wallet can fund this deal.',
  NotCreator: 'Only the creator wallet can perform this action.',
  AlreadyAccepted: 'The creator has already accepted the deal.',
  NotAccepted: 'The creator must accept the deal before it can be funded.',
  NotCertified: 'Chainlink must certify the deal before it can be funded.',
  AlreadyFunded: 'This deal is already funded.',
  NotFunded: 'The deal must be funded before a clause can be released.',
  InvalidClauseStatus: 'The clause must be verified and awaiting release.',
  ReleaseWindowActive: 'The 120-second dispute window is still open.',
  DependencyNotReleased: 'The clause this depends on must be released first.',
  RefundNotAllowed: 'This clause is not eligible for a refund.',
  DeadlinePassed: 'The submission deadline has passed.',
  SafeERC20FailedOperation: 'Check the wallet’s USDC balance and escrow approval.',
  InvalidCreator: 'The freelancer must be a different wallet from yours.',
  InvalidClauseCount: 'A deal needs 1 to 5 clauses.',
  ZeroClauseAmount: 'Every clause needs an amount above 0.',
  InvalidDependency: 'A clause can only depend on an earlier clause.',
  TotalMismatch: 'The clause amounts must add up exactly to the deal total.',
};

function escrowError(error: unknown) {
  const revert = error instanceof BaseError
    ? error.walk((cause) => cause instanceof ContractFunctionRevertedError)
    : undefined;
  return revert instanceof ContractFunctionRevertedError && revert.data?.errorName
    ? escrowErrors[revert.data.errorName]
    : undefined;
}

app.get('/api/escrow/deals/:dealId', requireWallet, async (req, res) => {
  if (!isDealId(req.params.dealId)) return bad(res, 'Enter a valid deal ID.');
  if (!isAddress(ESCROW_ADDRESS) || ESCROW_ADDRESS === zeroAddress) {
    return res.status(503).json({ message: escrowUnavailable });
  }
  const args = [BigInt(req.params.dealId)];
  const read = { address: ESCROW_ADDRESS, abi: escrowAbi, args };
  try {
    const [deal, certified, clauses] = await Promise.all([
      arc.readContract({ ...read, functionName: 'getDeal' }) as Promise<{
        brand: Address; creator: Address; total: bigint; accepted: boolean; funded: boolean;
      }>,
      arc.readContract({ ...read, functionName: 'certified' }) as Promise<boolean>,
      arc.readContract({ ...read, functionName: 'getClauses' }) as Promise<{
        status: number; amount: bigint; deadline: bigint; checkType: number; param: string; dependsOn: number; onFail: number;
      }[]>,
    ]);
    res.set('Cache-Control', 'no-store').json({
      brand: deal.brand,
      creator: deal.creator,
      accepted: deal.accepted,
      funded: deal.funded,
      total: formatUnits(deal.total, 6),
      certified,
      clauses: clauses.map(({ status, amount, deadline, checkType, param, dependsOn, onFail }) => ({
        status, amount: formatUnits(amount, 6), deadline: deadline.toString(), checkType, param, dependsOn, onFail,
      })),
    });
  } catch (error) {
    const message = escrowError(error);
    res.status(message ? 404 : 502).json({ message: message ?? 'Could not read deal status from Arc Testnet.' });
  }
});

// The signed-in wallet's deals (as client or freelancer), newest first, with each clause's status and
// dispute-window end. Scans the most recent 60 deals; enough for the demo, no indexer needed.
app.get('/api/escrow/my-deals', requireWallet, async (_req, res) => {
  if (!isAddress(ESCROW_ADDRESS) || ESCROW_ADDRESS === zeroAddress) {
    return res.status(503).json({ message: escrowUnavailable });
  }
  const me = sessionOf(res).address.toLowerCase();
  const base = { address: ESCROW_ADDRESS, abi: escrowAbi } as const;
  try {
    const count = Number(await arc.readContract({ ...base, functionName: 'dealCount' }) as bigint);
    const ids = Array.from({ length: Math.min(count, 60) }, (_, i) => BigInt(count - i)).filter((id) => id > 0n);
    const deals = await Promise.all(ids.map(async (id) => {
      const deal = await arc.readContract({ ...base, functionName: 'getDeal', args: [id] }) as {
        brand: Address; creator: Address; total: bigint; accepted: boolean; funded: boolean;
      };
      const role = deal.brand.toLowerCase() === me ? 'client' : deal.creator.toLowerCase() === me ? 'freelancer' : null;
      if (!role) return null;
      const [certified, clauses] = await Promise.all([
        arc.readContract({ ...base, functionName: 'certified', args: [id] }) as Promise<boolean>,
        arc.readContract({ ...base, functionName: 'getClauses', args: [id] }) as Promise<{
          status: number; amount: bigint; deadline: bigint; checkType: number; param: string; dependsOn: number; onFail: number;
        }[]>,
      ]);
      const windows = await Promise.all(clauses.map((_c, i) =>
        (arc.readContract({ ...base, functionName: 'disputeWindowEnd', args: [id, i] }) as Promise<bigint>).catch(() => 0n)));
      // court case of each disputed (or court-settled) clause; 0 = never disputed
      const cases = await Promise.all(clauses.map((c, i) => c.status >= 4
        ? (arc.readContract({ ...base, functionName: 'caseOf', args: [id, i] }) as Promise<bigint>).catch(() => 0n)
        : Promise.resolve(0n)));
      return {
        dealId: id.toString(), role, client: deal.brand, freelancer: deal.creator,
        total: formatUnits(deal.total, 6), accepted: deal.accepted, funded: deal.funded, certified,
        clauses: clauses.map((c, i) => ({
          status: c.status, amount: formatUnits(c.amount, 6), deadline: c.deadline.toString(), checkType: c.checkType,
          param: c.param, dependsOn: c.dependsOn, onFail: c.onFail, disputeWindowEnd: windows[i].toString(),
          caseId: cases[i].toString(),
        })),
      };
    }));
    res.set('Cache-Control', 'no-store').json({ deals: deals.filter(Boolean) });
  } catch {
    res.status(502).json({ message: 'Could not read your deals from Arc Testnet.' });
  }
});

app.get('/api/escrow/proposals/:txHash', requireWallet, async (req, res) => {
  const { txHash } = req.params;
  if (typeof txHash !== 'string' || !/^0x[\da-f]{64}$/i.test(txHash)) return bad(res, 'Invalid transaction hash.');
  try {
    const receipt = await arc.getTransactionReceipt({ hash: txHash as Hex });
    const events = parseEventLogs({ abi: escrowAbi, eventName: 'DealProposed', logs: receipt.logs.filter(
      (log) => log.address.toLowerCase() === ESCROW_ADDRESS.toLowerCase(),
    ) });
    const brand = sessionOf(res).address.toLowerCase();
    for (const event of events) {
      const args = event.args as { dealId?: bigint; brand?: Address } | undefined;
      if (args?.brand?.toLowerCase() === brand && args.dealId !== undefined) {
        return res.json({ dealId: args.dealId.toString() });
      }
    }
    res.status(404).json({ message: 'No deal proposal was found in this transaction.' });
  } catch {
    res.status(502).json({ message: 'Could not read the proposal receipt from Arc Testnet.' });
  }
});

app.post('/api/certify', requireWallet, async (req, res) => {
  if (!isDealId(req.body.dealId)) return bad(res, 'Enter a valid deal ID.');
  if (process.env.CRE_CERTIFY_ENABLED !== 'true') {
    return res.status(503).json({ message: 'WF0 certification is disabled on this server.' });
  }
  if (!isAddress(ESCROW_ADDRESS) || ESCROW_ADDRESS.toLowerCase() !== certifyConfig.escrowAddress.toLowerCase()) {
    return res.status(503).json({ message: 'WF0 and the server must use the same ClauseEscrow deployment.' });
  }
  if (certifying) return res.status(429).json({ message: 'Another certification is running. Try again shortly.' });

  const { address, blockchain } = sessionOf(res);
  if (blockchain !== 'ARC-TESTNET') return bad(res, 'Use an Arc Testnet wallet for certification.');
  const dealId = BigInt(req.body.dealId);
  const read = { address: ESCROW_ADDRESS, abi: escrowAbi, args: [dealId] };
  certifying = true;
  try {
    const deal = await arc.readContract({ ...read, functionName: 'getDeal' }) as { brand: Address; accepted: boolean };
    if (deal.brand.toLowerCase() !== address.toLowerCase()) {
      return res.status(403).json({ message: 'Only the brand wallet can request certification.' });
    }
    if (!deal.accepted) return res.json({ ok: false, reason: 'The creator must accept the deal before certification.' });
    const isCertified = () => arc.readContract({ ...read, functionName: 'certified' });
    if (await isCertified()) return res.json({ ok: true });

    const { stdout } = await runFile(process.env.CRE_BINARY?.trim() || 'cre', [
      'workflow', 'simulate', './wf0-certify', '--target', 'staging-settings', '--non-interactive',
      '--trigger-index', '0', '--http-payload', JSON.stringify({ dealId: dealId.toString() }), '--broadcast',
    ], { cwd: creProject, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true });

    // WF0 returns a JSON string. The CLI may render it as a JSON-quoted string.
    const output = stripVTControlCharacters(stdout).split('Workflow Simulation Result:').at(-1)?.trim() ?? '';
    let result: { certified?: boolean; reasons?: unknown; txHash?: string } | undefined;
    try {
      const parsed = JSON.parse(output);
      result = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
    } catch {
      // The on-chain state below remains authoritative if the CLI format changes.
    }
    if (await isCertified()) {
      const txHash = result?.txHash;
      return res.json({ ok: true, ...(txHash && /^0x[\da-f]{64}$/i.test(txHash) && { txHash }) });
    }
    const reasons = result?.certified === false && Array.isArray(result.reasons)
      ? result.reasons.filter((reason): reason is string => typeof reason === 'string').join(' ') : '';
    res.json({ ok: false, reason: reasons || 'Certification is not visible on Arc yet. Reload the deal before retrying.' });
  } catch (error) {
    const message = escrowError(error);
    res.status(message ? 404 : 502).json({ message: message ?? 'WF0 could not complete. Check the server’s CRE setup and the deal status.' });
  } finally {
    certifying = false;
  }
});

async function checkEscrowAction(res: Response, action: string, args: unknown[]) {
  if (!isAddress(ESCROW_ADDRESS) || ESCROW_ADDRESS === zeroAddress) {
    res.status(503).json({ message: escrowUnavailable });
    return false;
  }
  const { address: account, blockchain } = sessionOf(res);
  if (blockchain !== 'ARC-TESTNET') {
    bad(res, 'Use an Arc Testnet wallet for escrow.');
    return false;
  }
  try {
    await arc.simulateContract({ address: ESCROW_ADDRESS, abi: escrowAbi, functionName: action, args, account });
    return true;
  } catch (error) {
    const message = escrowError(error);
    res.status(422).json({ message: message ?? (action === 'fundDeal'
      ? 'Funding could not be simulated. Check the deal status, USDC balance, and approval.'
      : 'This action could not be simulated. Check the deal and clause status.') });
    return false;
  }
}

// Circle's transaction list for user-controlled wallets does not echo our refId back, so the server remembers each
// tracked action (wallet, contract, refId, time) and tags the matching transaction in GET /api/transactions.
const trackedActions = new Map<string, { refId: string; at: number; contract: string }[]>();

const prepareTrackedEscrowAction = (res: Response, signature: string, args: unknown[]) =>
  prepareTrackedAction(res, ESCROW_ADDRESS, signature, args);

async function prepareTrackedAction(res: Response, contract: string, signature: string, args: unknown[]) {
  const { walletId, userToken } = sessionOf(res);
  const refId = crypto.randomUUID();
  try {
    const result = await contractCall(userToken, walletId, contract, signature, args, refId);
    if (!result.ok) return reply(res, result);
    const list = (trackedActions.get(walletId) ?? []).filter((a) => Date.now() - a.at < 30 * 60_000);
    list.push({ refId, at: Date.now() - 5_000, contract: contract.toLowerCase() });
    trackedActions.set(walletId, list.slice(-20));
    res.status(result.status).json({ ...(result.json.data as { challengeId: string }), refId });
  } catch {
    res.status(502).json({ message: 'Could not reach Circle to prepare the transaction.' });
  }
}
const isU64 = (v: unknown) => /^\d+$/.test(String(v)) && BigInt(String(v)) < 2n ** 64n;
const MAX_CLAUSES = 5;
const NO_DEPENDENCY = 255;

// Returns the contract's ClauseTerms tuples as string arrays, or an error message.
// Field order must match ClauseTerms / shared/spec.ts:
//   kind, checkType, param, deadline, amount, dependsOn, onFail, vestDays
function parseClauses(raw: unknown): { terms: (string | number)[][] } | { error: string } {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CLAUSES) {
    return { error: `clauses must be an array of 1 to ${MAX_CLAUSES}` };
  }
  const terms: (string | number)[][] = [];
  for (const [i, c] of raw.entries()) {
    if (!isU8(c?.kind) || !isU8(c?.checkType) || !isU8(c?.onFail)) {
      return { error: `clause ${i}: kind, checkType and onFail must be 0-255` };
    }
    if (typeof (c.param ?? '') !== 'string') return { error: `clause ${i}: param must be a string` };
    if (Number(c.checkType) === 0 && !String(c.param ?? '').trim()) {
      return { error: `Promise ${i + 1} (YouTube posted) needs the freelancer's channel, e.g. @handle or a channel link. Otherwise anyone's video would pass.` };
    }
    if (!isU64(c.deadline)) return { error: `clause ${i}: deadline must be unix seconds` };
    if (!isUnits(c.amount)) return { error: `clause ${i}: amount must be a positive integer (6-decimal units)` };
    const dependsOn = c.dependsOn ?? NO_DEPENDENCY;
    if (!isU8(dependsOn)) return { error: `clause ${i}: dependsOn must be 0-255 (255 = none)` };
    if (!/^\d+$/.test(String(c.vestDays ?? 0))) return { error: `clause ${i}: vestDays must be a non-negative integer` };
    terms.push([
      Number(c.kind), Number(c.checkType), c.param ?? '', String(c.deadline),
      String(c.amount), Number(dependsOn), Number(c.onFail), Number(c.vestDays ?? 0),
    ]);
  }
  return { terms };
}

const CLAUSE_TUPLE = '(uint8,uint8,string,uint64,uint256,uint8,uint8,uint32)';

// 6a. Brand proposes a deal: body { creator, total, clauses: [...] }
app.post('/api/escrow/propose', requireWallet, async (req, res) => {
  const { creator, total, clauses } = req.body;
  if (!isAddress(creator)) return bad(res, 'creator must be a wallet address');
  if (!isUnits(total)) return bad(res, 'total must be a positive integer (6-decimal units)');
  const parsed = parseClauses(clauses);
  if ('error' in parsed) return bad(res, parsed.error);
  if (String(creator).toLowerCase() === sessionOf(res).address.toLowerCase()) {
    return bad(res, 'The freelancer must be a different wallet from yours.');
  }
  // placeholders (0x…01, 0x…dead, 0x1111…) pass isAddress and the contract, but nobody can ever accept them
  const hex = String(creator).slice(2).toLowerCase();
  if ((hex.match(/0/g)?.length ?? 0) >= 30 || new Set(hex).size <= 2 || /dead$/.test(hex)) {
    return bad(res, 'That looks like a placeholder address, not a real wallet. Use the freelancer’s own wallet address.');
  }
  // the client must already hold the deal total (nothing is locked now; funding happens after accept + certify)
  try {
    const balance = await arc.readContract({
      address: USDC_ADDRESS as Address, abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf', args: [sessionOf(res).address as Address],
    });
    if (balance < BigInt(total)) {
      return bad(res, `You need ${formatUnits(BigInt(total), 6)} USDC in your wallet to propose this deal (you have ${formatUnits(balance, 6)}). Nothing is charged now — you fund it after the freelancer accepts.`);
    }
  } catch {
    return res.status(502).json({ message: 'Could not check your USDC balance on Arc. Try again.' });
  }
  // dry-run first, so a deal the contract would reject fails here with the reason, not after the PIN
  const termsForSim = parsed.terms.map((t) => ({
    kind: Number(t[0]), checkType: Number(t[1]), param: String(t[2]), deadline: BigInt(t[3]),
    amount: BigInt(t[4]), dependsOn: Number(t[5]), onFail: Number(t[6]), vestDays: Number(t[7]),
  }));
  if (!await checkEscrowAction(res, 'proposeDeal', [creator, BigInt(total), termsForSim])) {
    console.warn('[propose] rejected before PIN:', JSON.stringify({ total: String(total), clauses: parsed.terms }).slice(0, 600));
    return;
  }
  await prepareTrackedEscrowAction(res, `proposeDeal(address,uint256,${CLAUSE_TUPLE}[])`,
    [creator, String(total), parsed.terms]);
});

// 6b. Creator accepts the exact terms
app.post('/api/escrow/accept', requireWallet, async (req, res) => {
  if (!isDealId(req.body.dealId)) return bad(res, 'Enter a valid deal ID.');
  if (!await checkEscrowAction(res, 'acceptDeal', [BigInt(req.body.dealId)])) return;
  await prepareTrackedEscrowAction(res, 'acceptDeal(uint256)', [String(req.body.dealId)]);
});

// 6c. Brand funds the deal (needs accepted + certified + approved USDC)
app.post('/api/escrow/fund', requireWallet, async (req, res) => {
  if (!isDealId(req.body.dealId)) return bad(res, 'Enter a valid deal ID.');
  if (!await checkEscrowAction(res, 'fundDeal', [BigInt(req.body.dealId)])) return;
  await prepareTrackedEscrowAction(res, 'fundDeal(uint256)', [String(req.body.dealId)]);
});

// 6d. Creator submits a video for a clause
app.post('/api/escrow/submit', requireWallet, async (req, res) => {
  const { dealId, clauseId, videoId } = req.body;
  if (!isDealId(dealId)) return bad(res, 'Enter a valid deal ID.');
  if (!isU8(clauseId)) return bad(res, 'clauseId must be 0-255');
  // evidence is any link (post, reel, video, site, GitHub PR) or an IPFS id of a screenshot
  if (typeof videoId !== 'string' || !videoId.trim() || videoId.length > 512) return bad(res, 'Send the link to your work (up to 512 characters).');
  if (!await checkEscrowAction(res, 'submitEvidence', [BigInt(dealId), Number(clauseId), videoId])) return;
  await prepareTrackedEscrowAction(res, 'submitEvidence(uint256,uint8,string)', [String(dealId), String(clauseId), videoId]);
});

// 7a. Anyone releases a verified clause to the creator (after the dispute window)
app.post('/api/escrow/release', requireWallet, async (req, res) => {
  const { dealId, clauseId } = req.body;
  if (!isDealId(dealId)) return bad(res, 'Enter a valid deal ID.');
  if (!isU8(clauseId)) return bad(res, 'clauseId must be 0-255');
  if (!await checkEscrowAction(res, 'release', [BigInt(dealId), Number(clauseId)])) return;
  await prepareTrackedEscrowAction(res, 'release(uint256,uint8)', [String(dealId), String(clauseId)]);
});

// 7b. Anyone refunds a failed clause to the brand
app.post('/api/escrow/refund', requireWallet, async (req, res) => {
  const { dealId, clauseId } = req.body;
  if (!isDealId(dealId)) return bad(res, 'Enter a valid deal ID.');
  if (!isU8(clauseId)) return bad(res, 'clauseId must be 0-255');
  if (!await checkEscrowAction(res, 'refund', [BigInt(dealId), Number(clauseId)])) return;
  await prepareTrackedEscrowAction(res, 'refund(uint256,uint8)', [String(dealId), String(clauseId)]);
});

// 7c. Send USDC from the signed-in wallet: body { to: 0x address, amount: 6-decimal units }.
// Returns { challengeId, refId }; the user approves with their PIN, then polls /api/transactions for refId.
// Any well-formed address can receive on-chain, so "does this wallet exist" can't be proven; we refuse the
// cases that are certainly wrong (not an address, placeholders, yourself, the escrow/USDC contracts, short balance).
app.post('/api/wallet/send', requireWallet, async (req, res) => {
  const to = String(req.body?.to ?? '').trim();
  const amount = String(req.body?.amount ?? '');
  if (!isAddress(to, { strict: false })) return bad(res, 'Send to a wallet address: 0x followed by 40 characters. Emails aren’t supported yet.');
  if (!isUnits(amount)) return bad(res, 'Enter an amount above 0.');
  const hex = to.slice(2).toLowerCase();
  if ((hex.match(/0/g)?.length ?? 0) >= 30 || new Set(hex).size <= 2 || /dead$/.test(hex)) {
    return bad(res, 'That looks like a placeholder address, not a real wallet. Money sent there is lost.');
  }
  const me = sessionOf(res).address.toLowerCase();
  if (to.toLowerCase() === me) return bad(res, 'That’s your own wallet.');
  if ([ESCROW_ADDRESS, USDC_ADDRESS].some((a) => a.toLowerCase() === to.toLowerCase())) {
    return bad(res, 'That’s a Settld contract address, not a wallet. USDC sent there can’t be recovered.');
  }
  try {
    const balance = await arc.readContract({
      address: USDC_ADDRESS as Address, abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf', args: [me as Address],
    });
    if (balance < BigInt(amount)) {
      return bad(res, `You have ${formatUnits(balance, 6)} USDC, less than the ${formatUnits(BigInt(amount), 6)} you’re sending.`);
    }
  } catch {
    return res.status(502).json({ message: 'Could not check your USDC balance on Arc. Try again.' });
  }
  await prepareTrackedAction(res, USDC_ADDRESS, 'transfer(address,uint256)', [to, amount]);
});

// 8. Recent transactions for the signed-in wallet (poll for state + txHash)
app.get('/api/transactions', requireWallet, async (_req, res) => {
  const { walletId, userToken } = sessionOf(res);
  const query = new URLSearchParams({ walletIds: walletId, includeAll: 'true', pageSize: '50' });
  const r = await circle(`/v1/w3s/transactions?${query}`, { userToken });
  if (!r.ok) return reply(res, r);
  type Tx = { refId?: string; contractAddress?: string; operation?: string; createDate?: string };
  const data = r.json.data as { transactions?: Tx[] };
  const txs = data.transactions ?? [];
  // put our refId back on the transaction each tracked action produced: the first one to the same contract after it
  const callTxs = txs
    .filter((t) => t.operation === 'CONTRACT_EXECUTION')
    .sort((a, b) => Date.parse(a.createDate ?? '') - Date.parse(b.createDate ?? ''));
  const used = new Set<Tx>(callTxs.filter((t) => t.refId));
  // newest action first: an older prepare whose PIN was cancelled never made a transaction, and matching
  // oldest-first let it steal the next real transaction, so the action the user just approved never got tagged
  for (const action of [...(trackedActions.get(walletId) ?? [])].reverse()) {
    if (callTxs.some((t) => t.refId === action.refId)) continue;
    const match = callTxs.find((t) => !used.has(t) && t.contractAddress?.toLowerCase() === action.contract
      && Date.parse(t.createDate ?? '') >= action.at);
    if (match) { match.refId = action.refId; used.add(match); }
  }
  res.status(r.status).json(data);
});

// ---- Mock "add funds" (testnet only) ----------------------------------------
// Pretends to be a card top-up. A test-only treasury wallet sends 10 test USDC
// to the signed-in user's wallet. The treasury key is a plain test key
// (TREASURY_PRIVATE_KEY in server/.env); never reuse it on mainnet.

const TOP_UP_USDC = process.env.TOP_UP_USDC?.trim() || '10';
// USDC is also the gas token on Arc, so the treasury keeps a little back for fees
const TREASURY_GAS_RESERVE = parseUnits('0.05', 6);
const TOP_UP_MIN = parseUnits('1', 6);
const TOP_UP_COOLDOWN_MS = 30_000;
const lastTopUp = new Map<string, number>();

const arcTestnet = defineChain({
  id: addresses.chainId,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL?.trim() || addresses.rpc] } },
});
const arc = createPublicClient({ chain: arcTestnet, transport: http(undefined, { retryCount: 8, retryDelay: 1500 }) });
const pingAbi = parseAbi(['function lastNumber() view returns (uint256)']);

app.get('/api/ping', requireWallet, async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const address = addresses.ping.trim();
  if (!isAddress(address) || address === zeroAddress) {
    return res.status(503).json({ error: 'Set the Arc Testnet Ping contract address in shared/addresses.json.' });
  }

  try {
    const last = await arc.readContract({ address, abi: pingAbi, functionName: 'lastNumber' });
    res.json({ last: last.toString() });
  } catch {
    res.status(502).json({ error: 'Unable to read the Ping contract.' });
  }
});

if (process.env.NODE_ENV === 'development') {
  app.get('/api/wallet/:role', async (req, res) => {
    const { role } = req.params;
    if (role !== 'brand' && role !== 'creator') {
      return res.status(400).json({ error: 'Choose brand or creator.' });
    }

    const walletId = (role === 'brand' ? process.env.CIRCLE_BRAND_WALLET_ID : process.env.CIRCLE_CREATOR_WALLET_ID)?.trim();
    if (!process.env.CIRCLE_API_KEY?.trim() || !walletId) {
      return res.status(503).json({ error: 'Circle wallet configuration is missing for this role.' });
    }

    try {
      const result = await circle(`/v1/w3s/wallets/${encodeURIComponent(walletId)}`);
      const wallet = (result.json.data as { wallet?: { address: string; blockchain: string } } | undefined)?.wallet;
      if (!result.ok || wallet?.blockchain !== 'ARC-TESTNET' || !isAddress(wallet.address)) {
        return res.status(502).json({ error: 'Expected a valid Arc Testnet wallet from Circle.' });
      }
      const balance = await arc.getBalance({ address: wallet.address });
      res.set('Cache-Control', 'no-store').json({
        role,
        address: wallet.address,
        usdcBalance: formatUnits(balance, arcTestnet.nativeCurrency.decimals),
      });
    } catch {
      res.status(502).json({ error: 'Unable to read the wallet or its USDC balance.' });
    }
  });
}

// 9. Send TOP_UP_USDC from the treasury to the caller's own wallet
app.post('/api/funds/add', requireWallet, async (_req, res) => {
  try {
    const key = process.env.TREASURY_PRIVATE_KEY as Hex | undefined;
    if (!key) return res.status(500).json({ message: 'Treasury not configured' });

    // Destination is always the signed-in wallet, never anything from the request
    const to = sessionOf(res).address;

    const last = lastTopUp.get(to.toLowerCase()) ?? 0;
    if (Date.now() - last < TOP_UP_COOLDOWN_MS) {
      return res.status(429).json({ message: 'Please wait a few seconds between top-ups' });
    }

    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(undefined, { retryCount: 8, retryDelay: 1500 }) });
    const usdcAbi = parseAbi([
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address) view returns (uint256)',
    ]);
    const usdc = USDC_ADDRESS as Address;

    // send the full amount if the treasury can, otherwise what it has left (keeping gas)
    const available = await arc.readContract({ address: usdc, abi: usdcAbi, functionName: 'balanceOf', args: [account.address] });
    const spendable = available > TREASURY_GAS_RESERVE ? available - TREASURY_GAS_RESERVE : 0n;
    const wanted = parseUnits(TOP_UP_USDC, 6);
    const amount = spendable >= wanted ? wanted : (spendable / 1_000_000n) * 1_000_000n; // whole USDC
    if (amount < TOP_UP_MIN) {
      return res.status(503).json({
        message: `The demo treasury is out of test USDC (${formatUnits(available, 6)} left). ` +
          `Top it up at faucet.circle.com (Arc Testnet) → ${account.address}`,
      });
    }

    const txHash = await wallet.writeContract({ address: usdc, abi: usdcAbi, functionName: 'transfer', args: [to, amount] });
    await arc.waitForTransactionReceipt({ hash: txHash });
    lastTopUp.set(to.toLowerCase(), Date.now());
    // the chain is the source of truth; Circle's balance index can lag a few seconds behind
    const balance = await arc.readContract({ address: usdc, abi: usdcAbi, functionName: 'balanceOf', args: [to] });
    res.json({ txHash, amount: formatUnits(amount, 6), to, balance: formatUnits(balance, 6) });
  } catch (e) {
    console.error('funds/add failed:', e);
    res.status(500).json({ message: (e as Error).message.split('\n')[0] });
  }
});

// Arbitration (arbitrator-only court, parties' dispute/appeal) — registered BEFORE the World ID routes,
// so its arbitrator gate runs in front of /api/arbitrator/commit|reveal|panel
const shared = addresses as unknown as {
  usdc: string; aiCourt?: { address?: string }; jurorRegistry?: { address?: string }; clauseEscrow?: { deployBlock?: number };
};
// database first (MongoDB when MONGODB_URI is set, otherwise SQLite), then everything that uses it
await initStore();
const savedAutomation = (await getState('automation')) ?? undefined;

const arbitration = registerArbitrationRoutes(app, {
  requireWallet, sessionOf, contractCall, reply,
  arc: arc as unknown as PublicClient,
  escrow: ESCROW_ADDRESS,
  court: shared.aiCourt?.address,
  registry: process.env.JUROR_REGISTRY_ADDRESS?.trim() || shared.jurorRegistry?.address,
  usdc: USDC_ADDRESS,
  escrowAbi,
});
registerCourtRoutes(app, { requireWallet, partyOrArbitrator: arbitration.partyOrArbitrator });
registerAutomation(app, {
  arc: arc as unknown as PublicClient,
  chain: arcTestnet,
  escrowAbi,
  addresses: addresses as never,
  escrowOverride: process.env.ESCROW_ADDRESS?.trim(),
  creProject,
  onEvent: recordEvent,
  initialState: savedAutomation,
  persist: (state) => setState('automation', state),
  archiveFromBlock: shared.clauseEscrow?.deployBlock ? BigInt(shared.clauseEscrow.deployBlock) : undefined,
});
registerExtractRoutes(app, requireWallet);
registerDevTools(app, { arc: arc as unknown as PublicClient, chain: arcTestnet, escrow: ESCROW_ADDRESS, escrowAbi });
registerMonitor(app, { escrow: ESCROW_ADDRESS, court: shared.aiCourt?.address, registry: shared.jurorRegistry?.address }, addresses.explorer);
// World ID + JurorRegistry routes (server/src/worldid.ts, docs/INTERFACES.md)
registerWorldIdRoutes(app, {
  requireWallet,
  sessionOf,
  contractCall,
  reply,
  arc: arc as unknown as PublicClient,
});

app.listen(PORT, () => {
  console.log(`Settld server running on http://localhost:${PORT}`);
});
