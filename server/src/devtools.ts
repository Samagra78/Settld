// Developer-only helpers for the Circle PIN test page (/circle-test). Never served in production.
//   GET  /api/dev/circle-config        → { appId, freelancer }  (Circle app id is public)
//   POST /api/dev/test-freelancer      { dealId, action: 'accept' | 'submit', evidence? }
//        plays the freelancer with the scripts' TEST wallet, so one person can run the whole client flow.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { createWalletClient, http, type Abi, type Address, type Chain, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export function registerDevTools(app: Express, d: { arc: PublicClient; chain: Chain; escrow: string; escrowAbi: Abi }) {
  if (process.env.NODE_ENV === 'production') return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  app.get('/circle-test', (_req, res) => res.sendFile(path.join(here, '..', 'public', 'circle-test.html')));
  app.get('/circle-test/sdk.js', (_req, res) =>
    res.type('application/javascript').sendFile(path.join(here, '..', 'public', 'vendor', 'w3s-pw-web-sdk.js')));

  const testerKey = (() => {
    try {
      const env = fs.readFileSync(path.resolve(process.cwd(), '..', 'scripts', '.env'), 'utf8');
      return (env.match(/^TESTER_PRIVATE_KEY=(.+)$/m)?.[1].trim() ?? '') as Hex;
    } catch {
      return '' as Hex;
    }
  })();
  const tester = testerKey ? createWalletClient({ account: privateKeyToAccount(testerKey), chain: d.chain, transport: http(undefined, { retryCount: 6, retryDelay: 1500 }) }) : null;

  app.get('/api/dev/circle-config', (_req, res) => {
    res.json({ appId: process.env.CIRCLE_APP_ID?.trim() ?? '', freelancer: tester?.account.address ?? null, escrow: d.escrow });
  });

  app.post('/api/dev/test-freelancer', async (req, res) => {
    if (!tester) return res.status(503).json({ message: 'No TESTER_PRIVATE_KEY in scripts/.env' });
    const { dealId, action, evidence } = req.body ?? {};
    if (!/^\d+$/.test(String(dealId)) || !['accept', 'submit'].includes(action)) {
      return res.status(400).json({ message: 'Send dealId and action accept|submit.' });
    }
    try {
      const args = action === 'accept' ? [BigInt(dealId)] : [BigInt(dealId), 0, String(evidence || 'https://example.com')];
      const functionName = action === 'accept' ? 'acceptDeal' : 'submitEvidence';
      const { request } = await d.arc.simulateContract({ account: tester.account, address: d.escrow as Address, abi: d.escrowAbi, functionName, args } as never);
      const hash = await tester.writeContract(request as never);
      const r = await d.arc.waitForTransactionReceipt({ hash });
      res.json({ ok: r.status === 'success', txHash: hash });
    } catch (e) {
      res.status(422).json({ message: (e as Error).message.split('\n')[0] });
    }
  });
}
