// World ID (IDKit 4.x) + JurorRegistry routes.
//
// Flow (one action "settld-member" for every role):
//   1. GET  /api/worldid/config      → public IDKit settings for the frontend
//   2. POST /api/worldid/rp-context  → backend-signed RP context (IDKit 4 requires it); signal = your wallet
//   3. (browser) IDKitRequestWidget → World App / simulator → IDKit result
//   4. POST /api/worldid/verify      → forward the result to World's v4 verify API → if it succeeds,
//                                     sign an attestation (nullifier, wallet) with ATTESTER_PRIVATE_KEY
//   5. POST /api/jury/register       → Circle tx: JurorRegistry.registerPerson(nullifier, attestation)
//   6. POST /api/jury/vote           → Circle tx: JurorRegistry.vote(dealId, clauseId, payCreator)
//   7. GET  /api/jury/:dealId/:clauseId → current votes / decision
//
// The wallet in the attestation always comes from the signed-in session, never from the request,
// so a proof can only ever be linked to the wallet that asked for it.

import { signRequest } from '@worldcoin/idkit-core/signing';
import type { Express, NextFunction, Request, Response } from 'express';
import { encodePacked, isAddress, keccak256, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

type CircleResult = { status: number; ok: boolean; json: any };
type Session = { address: string; walletId: string; userToken: string };

export type WorldIdDeps = {
  requireWallet: (req: Request, res: Response, next: NextFunction) => void;
  sessionOf: (res: Response) => Session;
  contractCall: (
    userToken: string, walletId: string, contractAddress: string,
    abiFunctionSignature: string, abiParameters: unknown[], refId?: string,
  ) => Promise<CircleResult>;
  reply: (res: Response, r: CircleResult) => void;
  arc: PublicClient;
};

const env = (k: string) => process.env[k]?.trim() ?? '';
const ACTION = () => env('WLD_ACTION') || 'settld-member';
const ENVIRONMENT = () => (env('WLD_ENVIRONMENT') || 'staging') as 'production' | 'staging';
const VERIFY_BASE = () =>
  ENVIRONMENT() === 'staging' ? 'https://staging-developer.worldcoin.org' : 'https://developer.world.org';
const REGISTRY = () => env('JUROR_REGISTRY_ADDRESS');

const registryAbi = parseAbi([
  'function nullifierOf(address) view returns (uint256)',
  'function decision(uint256 dealId, uint8 clauseId) view returns (bool decided, bool payCreator, uint8 votesPay, uint8 votesRefund)',
]);

// nonce → wallet it was issued for (short-lived, in memory)
const pendingNonces = new Map<string, { wallet: string; expiresAt: number }>();

export function registerWorldIdRoutes(app: Express, d: WorldIdDeps) {
  const configured = () => !!(env('WLD_APP_ID') && env('WLD_RP_ID') && env('WLD_RP_SIGNING_KEY') && env('ATTESTER_PRIVATE_KEY'));

  // 1. public settings for IDKit
  app.get('/api/worldid/config', (_req, res) => {
    res.json({
      enabled: configured(),
      appId: env('WLD_APP_ID'),
      action: ACTION(),
      environment: ENVIRONMENT(),
      registry: REGISTRY() || null,
    });
  });

  // 2. RP context (IDKit 4 requires a backend signature for every request)
  app.post('/api/worldid/rp-context', d.requireWallet, (_req, res) => {
    if (!configured()) return res.status(503).json({ message: 'World ID is not configured on the server.' });
    const { sig, nonce, createdAt, expiresAt } = signRequest({
      signingKeyHex: env('WLD_RP_SIGNING_KEY'),
      action: ACTION(),
      ttl: 300,
    });
    const wallet = d.sessionOf(res).address.toLowerCase();
    pendingNonces.set(nonce, { wallet, expiresAt: Number(expiresAt) * 1000 || Date.now() + 300_000 });
    res.json({
      rp_context: { rp_id: env('WLD_RP_ID'), nonce, created_at: createdAt, expires_at: expiresAt, signature: sig },
      signal: wallet, // the frontend must pass this as the preset's signal
      action: ACTION(),
      environment: ENVIRONMENT(),
    });
  });

  // 4. verify the proof with World, then attest (nullifier, wallet)
  app.post('/api/worldid/verify', d.requireWallet, async (req, res) => {
    if (!configured()) return res.status(503).json({ message: 'World ID is not configured on the server.' });
    const result = req.body ?? {};
    const wallet = d.sessionOf(res).address.toLowerCase();

    // the nonce must be one we issued, to this wallet, and not expired
    const pending = pendingNonces.get(String(result.nonce ?? ''));
    if (!pending || pending.wallet !== wallet || pending.expiresAt < Date.now()) {
      return res.status(400).json({ message: 'This World ID request has expired. Please verify again.' });
    }
    if (result.action !== ACTION()) return res.status(400).json({ message: 'Wrong World ID action.' });
    if (result.environment && result.environment !== ENVIRONMENT()) {
      return res.status(400).json({ message: `This proof is for "${result.environment}", expected "${ENVIRONMENT()}".` });
    }
    pendingNonces.delete(String(result.nonce));

    let verification: any;
    try {
      const r = await fetch(`${VERIFY_BASE()}/api/v4/verify/${encodeURIComponent(env('WLD_RP_ID'))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...result, environment: ENVIRONMENT() }),
      });
      verification = await r.json().catch(() => ({}));
      if (!r.ok || verification?.success !== true) {
        return res.status(400).json({ message: 'World ID could not verify this proof.', code: verification?.code, detail: verification?.detail });
      }
    } catch {
      return res.status(502).json({ message: 'Could not reach World ID to verify the proof.' });
    }

    const nullifierHex = String(verification.nullifier ?? result.responses?.[0]?.nullifier ?? '');
    if (!/^0x[0-9a-fA-F]+$/.test(nullifierHex)) return res.status(502).json({ message: 'World ID returned no nullifier.' });
    const nullifier = BigInt(nullifierHex);

    const attester = privateKeyToAccount(env('ATTESTER_PRIVATE_KEY') as Hex);
    const hash = keccak256(encodePacked(['uint256', 'address'], [nullifier, wallet as Address]));
    const signature = await attester.signMessage({ message: { raw: hash } });

    res.json({ nullifier: nullifier.toString(), signature, attester: attester.address, wallet });
  });

  const registryReady = (res: Response) => {
    const r = REGISTRY();
    if (!isAddress(r) || r === zeroAddress) {
      res.status(503).json({ message: 'JurorRegistry address is not configured on the server.' });
      return false;
    }
    return true;
  };

  // 5. link wallet ↔ World ID on-chain (Circle PIN prompt in the browser)
  app.post('/api/jury/register', d.requireWallet, async (req, res) => {
    if (!registryReady(res)) return;
    const { nullifier, signature } = req.body ?? {};
    if (!/^\d+$/.test(String(nullifier)) || !/^0x[0-9a-fA-F]{130}$/.test(String(signature))) {
      return res.status(400).json({ message: 'Verify with World ID first.' });
    }
    const { userToken, walletId } = d.sessionOf(res);
    d.reply(res, await d.contractCall(userToken, walletId, REGISTRY(), 'registerPerson(uint256,bytes)', [String(nullifier), signature]));
  });

  // 6. vote on a disputed clause
  app.post('/api/jury/vote', d.requireWallet, async (req, res) => {
    if (!registryReady(res)) return;
    const { dealId, clauseId, payCreator } = req.body ?? {};
    if (!/^\d+$/.test(String(dealId)) || !/^\d+$/.test(String(clauseId)) || Number(clauseId) > 255 || typeof payCreator !== 'boolean') {
      return res.status(400).json({ message: 'Send dealId, clauseId and payCreator (true/false).' });
    }
    const { userToken, walletId } = d.sessionOf(res);
    d.reply(res, await d.contractCall(userToken, walletId, REGISTRY(), 'vote(uint256,uint8,bool)', [String(dealId), String(clauseId), payCreator]));
  });

  // 7. jury status for a clause (+ whether the signed-in wallet is a registered juror)
  app.get('/api/jury/:dealId/:clauseId', d.requireWallet, async (req, res) => {
    if (!registryReady(res)) return;
    const dealId = String(req.params.dealId), clauseId = String(req.params.clauseId);
    if (!/^\d+$/.test(dealId) || !/^\d+$/.test(clauseId) || Number(clauseId) > 255) return res.status(400).json({ message: 'Invalid deal or clause.' });
    try {
      const address = REGISTRY() as Address;
      const [decided, payCreator, votesPay, votesRefund] = await d.arc.readContract({
        address, abi: registryAbi, functionName: 'decision', args: [BigInt(dealId), Number(clauseId)],
      });
      const myNullifier = await d.arc.readContract({
        address, abi: registryAbi, functionName: 'nullifierOf', args: [d.sessionOf(res).address as Address],
      });
      res.json({ decided, payCreator, votesPay, votesRefund, registered: myNullifier !== 0n });
    } catch {
      res.status(502).json({ message: 'Could not read the jury status.' });
    }
  });
}
