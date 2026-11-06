import 'dotenv/config';
import axios from 'axios';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
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
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import addresses from '../../shared/addresses.json' with { type: 'json' };
import clauseEscrowAbi from '../../shared/abi/ClauseEscrow.json' with { type: 'json' };

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors());
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

type Session = {
  address: Address;
  walletId: string;
  blockchain: string;
  userToken: string;
  expiresAt: number;
};
const SESSION_MS = 55 * 60 * 1000; // Circle userTokens last 60 minutes
const COOKIE = 'settld_sid';
const sessions = new Map<string, Session>();

setInterval(() => {
  for (const [sid, s] of sessions) if (s.expiresAt < Date.now()) sessions.delete(sid);
}, 60_000).unref();

const readCookie = (header: string | undefined, name: string) =>
  header
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([k]) => k === name)?.[1];

function getSession(req: Request): Session | undefined {
  const sid = readCookie(req.headers.cookie, COOKIE);
  const s = sid ? sessions.get(sid) : undefined;
  if (!s || s.expiresAt < Date.now()) {
    if (sid) sessions.delete(sid);
    return undefined;
  }
  return s;
}

const requireWallet = (req: Request, res: Response, next: NextFunction) => {
  const s = getSession(req);
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

  // one live session per wallet
  for (const [sid, s] of sessions) {
    if (s.address.toLowerCase() === wallet.address.toLowerCase()) sessions.delete(sid);
  }
  const sid = randomBytes(32).toString('hex');
  sessions.set(sid, {
    address: wallet.address as Address,
    walletId: wallet.id,
    blockchain: wallet.blockchain,
    userToken: req.body.userToken,
    expiresAt: Date.now() + SESSION_MS,
  });
  res.cookie(COOKIE, sid, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MS,
  });
  res.json({ address: wallet.address, walletId: wallet.id, blockchain: wallet.blockchain });
});

// Who am I? Identity = wallet address.
app.get('/api/me', requireWallet, (_req, res) => {
  const { address, walletId, blockchain } = sessionOf(res);
  res.json({ address, walletId, blockchain });
});

app.post('/api/logout', (req, res) => {
  const sid = readCookie(req.headers.cookie, COOKIE);
  if (sid) sessions.delete(sid);
  res.clearCookie(COOKIE);
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
  const { walletId, userToken } = sessionOf(res);
  reply(res, await circle(`/v1/w3s/wallets/${walletId}/balances`, { userToken }));
});

// ---- Escrow transactions (user-controlled) ---------------------------------
// These routes only *prepare* a transaction and return a challengeId.
// The browser SDK then runs the challenge, where the user enters their PIN.

const USDC_ADDRESS = '0x3600000000000000000000000000000000000000'; // 6 decimals
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS?.trim() ?? '';
const escrowAbi = clauseEscrowAbi as Abi;
const escrowUnavailable = 'ClauseEscrow is awaiting its Arc Testnet deployment address.';

// Fixed contract + function per route (no generic "call anything" endpoint),
// so this server can only ever prepare the ClauseEscrow calls below.
const contractCall = (
  userToken: string,
  walletId: string,
  contractAddress: string,
  abiFunctionSignature: string,
  abiParameters: string[],
  refId?: string,
): Promise<CircleResult> => {
  if (!isAddress(ESCROW_ADDRESS) || ESCROW_ADDRESS === zeroAddress) {
    return Promise.resolve({ status: 503, ok: false, json: { message: escrowUnavailable } });
  }
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
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    },
  });
};

// amount is a string in 6-decimal units: 1 USDC = "1000000"

const isUnits = (v: unknown) => /^\d+$/.test(String(v)) && BigInt(String(v)) > 0n;
const isId = (v: unknown) => /^\d+$/.test(String(v));
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
  NotAccepted: 'The creator must accept the deal before it can be funded.',
  NotCertified: 'Chainlink must certify the deal before it can be funded.',
  AlreadyFunded: 'This deal is already funded.',
  NotFunded: 'The deal must be funded before a clause can be released.',
  WrongStatus: 'The clause must be verified and awaiting release.',
  WindowOpen: 'The 120-second dispute window is still open.',
  DependencyNotReleased: 'The clause this depends on must be released first.',
  SafeERC20FailedOperation: 'Check the wallet’s USDC balance and escrow approval.',
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
      arc.readContract({ ...read, functionName: 'getDeal' }) as Promise<{ accepted: boolean; funded: boolean }>,
      arc.readContract({ ...read, functionName: 'certified' }) as Promise<boolean>,
      arc.readContract({ ...read, functionName: 'getClauses' }) as Promise<{ status: number }[]>,
    ]);
    res.set('Cache-Control', 'no-store').json({
      accepted: deal.accepted,
      certified,
      funded: deal.funded,
      clauses: clauses.map(({ status }) => ({ status })),
    });
  } catch (error) {
    const message = escrowError(error);
    res.status(message ? 404 : 502).json({ message: message ?? 'Could not read deal status from Arc Testnet.' });
  }
});

async function checkEscrowAction(res: Response, action: 'fundDeal' | 'release', args: (bigint | number)[]) {
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
      : 'Release could not be simulated. Check the clause status and dispute window.') });
    return false;
  }
}

async function prepareTrackedEscrowAction(res: Response, signature: string, args: string[]) {
  const { walletId, userToken } = sessionOf(res);
  const refId = crypto.randomUUID();
  try {
    const result = await contractCall(userToken, walletId, ESCROW_ADDRESS, signature, args, refId);
    if (!result.ok) return reply(res, result);
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
  const { walletId, userToken } = sessionOf(res);
  reply(res, await contractCall(userToken, walletId, ESCROW_ADDRESS,
    `proposeDeal(address,uint256,${CLAUSE_TUPLE}[])`, [creator, String(total), parsed.terms] as unknown as string[]));
});

// 6b. Creator accepts the exact terms
app.post('/api/escrow/accept', requireWallet, async (req, res) => {
  if (!isId(req.body.dealId)) return bad(res, 'dealId must be a non-negative integer');
  const { walletId, userToken } = sessionOf(res);
  reply(res, await contractCall(userToken, walletId, ESCROW_ADDRESS,
    'acceptDeal(uint256)', [String(req.body.dealId)]));
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
  if (!isId(dealId)) return bad(res, 'dealId must be a non-negative integer');
  if (!isU8(clauseId)) return bad(res, 'clauseId must be 0-255');
  if (typeof videoId !== 'string' || !videoId || videoId.length > 64) return bad(res, 'videoId must be a short string');
  const { walletId, userToken } = sessionOf(res);
  reply(res, await contractCall(userToken, walletId, ESCROW_ADDRESS,
    'submitEvidence(uint256,uint8,string)', [String(dealId), String(clauseId), videoId]));
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
  if (!isId(dealId)) return bad(res, 'dealId must be a non-negative integer');
  if (!isU8(clauseId)) return bad(res, 'clauseId must be 0-255');
  const { walletId, userToken } = sessionOf(res);
  reply(res, await contractCall(userToken, walletId, ESCROW_ADDRESS,
    'refund(uint256,uint8)', [String(dealId), String(clauseId)]));
});

// 8. Recent transactions for the signed-in wallet (poll for state + txHash)
app.get('/api/transactions', requireWallet, async (_req, res) => {
  const { walletId, userToken } = sessionOf(res);
  const query = new URLSearchParams({ walletIds: walletId, includeAll: 'true', pageSize: '50' });
  reply(res, await circle(`/v1/w3s/transactions?${query}`, { userToken }));
});

// ---- Mock "add funds" (testnet only) ----------------------------------------
// Pretends to be a card top-up. A test-only treasury wallet sends 10 test USDC
// to the signed-in user's wallet. The treasury key is a plain test key
// (TREASURY_PRIVATE_KEY in server/.env); never reuse it on mainnet.

const TOP_UP_USDC = '10';
const TOP_UP_COOLDOWN_MS = 30_000;
const lastTopUp = new Map<string, number>();

const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network'] } },
});
const arc = createPublicClient({ chain: arcTestnet, transport: http() });
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
    lastTopUp.set(to.toLowerCase(), Date.now());

    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });

    const txHash = await wallet.writeContract({
      address: USDC_ADDRESS as Address,
      abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
      functionName: 'transfer',
      args: [to, parseUnits(TOP_UP_USDC, 6)],
    });
    await arc.waitForTransactionReceipt({ hash: txHash });
    res.json({ txHash, amount: TOP_UP_USDC, to });
  } catch (e) {
    console.error('funds/add failed:', e);
    res.status(500).json({ message: (e as Error).message.split('\n')[0] });
  }
});

// Routes added step by step (see docs/INTERFACES.md):
//   S4  POST /api/deals, GET /api/deals/:specHash
//   S5  POST /api/report/encode
//   S8  POST /api/certify
//   S10 POST /api/worldid

app.listen(PORT, () => {
  console.log(`Settld server running on http://localhost:${PORT}`);
});
