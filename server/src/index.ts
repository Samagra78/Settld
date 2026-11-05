import 'dotenv/config';
import axios from 'axios';
import cors from 'cors';
import express, { type Response } from 'express';

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

// 4. Token balances for one wallet: returns { tokenBalances: [...] }
app.post('/api/balance', async (req, res) => {
  const { userToken, walletId } = req.body;
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

// 5. Brand lets the escrow pull `amount` USDC
app.post('/api/escrow/approve', async (req, res) => {
  const { userToken, walletId, amount } = req.body;
  reply(res, await contractCall(userToken, walletId, USDC_ADDRESS,
    'approve(address,uint256)', [ESCROW_ADDRESS, String(amount)]));
});

// 6. Brand funds an escrow for a creator
app.post('/api/escrow/fund', async (req, res) => {
  const { userToken, walletId, creator, amount } = req.body;
  reply(res, await contractCall(userToken, walletId, ESCROW_ADDRESS,
    'fund(address,uint256)', [creator, String(amount)]));
});

// 7. Brand releases an escrow to the creator
app.post('/api/escrow/release', async (req, res) => {
  const { userToken, walletId, id } = req.body;
  reply(res, await contractCall(userToken, walletId, ESCROW_ADDRESS,
    'release(uint256)', [String(id)]));
});

// 8. Recent transactions for a wallet (poll this for state + txHash)
app.post('/api/transactions', async (req, res) => {
  const { userToken, walletId } = req.body;
  reply(res, await circle(`/v1/w3s/transactions?walletIds=${walletId}`, { userToken }));
});

// Routes added step by step (see docs/INTERFACES.md):
//   S4  POST /api/deals, GET /api/deals/:specHash
//   S5  POST /api/report/encode
//   S8  POST /api/certify
//   S10 POST /api/worldid

app.listen(PORT, () => {
  console.log(`Settld server running on http://localhost:${PORT}`);
});
