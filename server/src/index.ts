import 'dotenv/config';
import axios from 'axios';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

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
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS!;

// Fixed contract + function per route (no generic "call anything" endpoint),
// so this server can only ever prepare approve / fund / release.
const contractCall = (
  userToken: string,
  walletId: string,
  contractAddress: string,
  abiFunctionSignature: string,
  abiParameters: string[],
) =>
  circle('/v1/w3s/user/transactions/contractExecution', {
    method: 'POST',
    userToken,
    body: {
      idempotencyKey: crypto.randomUUID(),
      walletId,
      contractAddress,
      abiFunctionSignature,
      abiParameters,
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    },
  });

// amount is a string in 6-decimal units: 1 USDC = "1000000"

const isUnits = (v: unknown) => /^\d+$/.test(String(v)) && BigInt(String(v)) > 0n;
const isId = (v: unknown) => /^\d+$/.test(String(v));
const bad = (res: Response, message: string) => res.status(400).json({ message });

// 5. Brand lets the escrow pull `amount` USDC
app.post('/api/escrow/approve', requireWallet, async (req, res) => {
  if (!isUnits(req.body.amount)) return bad(res, 'amount must be a positive integer (6-decimal units)');
  const { walletId, userToken } = sessionOf(res);
  reply(res, await contractCall(userToken, walletId, USDC_ADDRESS,
    'approve(address,uint256)', [ESCROW_ADDRESS, String(req.body.amount)]));
});

// 6. Brand funds an escrow for a creator
app.post('/api/escrow/fund', requireWallet, async (req, res) => {
  const { creator, amount } = req.body;
  if (!isAddress(creator)) return bad(res, 'creator must be a wallet address');
  if (!isUnits(amount)) return bad(res, 'amount must be a positive integer (6-decimal units)');
  const { walletId, userToken } = sessionOf(res);
  reply(res, await contractCall(userToken, walletId, ESCROW_ADDRESS,
    'fund(address,uint256)', [creator, String(amount)]));
});

// 7. Brand releases an escrow to the creator
app.post('/api/escrow/release', requireWallet, async (req, res) => {
  if (!isId(req.body.id)) return bad(res, 'id must be a non-negative integer');
  const { walletId, userToken } = sessionOf(res);
  reply(res, await contractCall(userToken, walletId, ESCROW_ADDRESS,
    'release(uint256)', [String(req.body.id)]));
});

// 8. Recent transactions for the signed-in wallet (poll for state + txHash)
app.get('/api/transactions', requireWallet, async (_req, res) => {
  const { walletId, userToken } = sessionOf(res);
  reply(res, await circle(`/v1/w3s/transactions?walletIds=${walletId}`, { userToken }));
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
    const pub = createPublicClient({ chain: arcTestnet, transport: http() });

    const txHash = await wallet.writeContract({
      address: USDC_ADDRESS as Address,
      abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
      functionName: 'transfer',
      args: [to, parseUnits(TOP_UP_USDC, 6)],
    });
    await pub.waitForTransactionReceipt({ hash: txHash });
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
