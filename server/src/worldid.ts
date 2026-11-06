// World ID (IDKit 4.x) + JurorRegistry routes.
//
// Flow (one action "settld-member" for every role):
//   1. GET  /api/worldid/config      → public IDKit settings for the frontend
//   2. POST /api/worldid/rp-context  → backend-signed RP context (IDKit 4 requires it); signal = your wallet
//   3. (browser) IDKitRequestWidget → World App / simulator → IDKit result
//   4. POST /api/worldid/verify      → forward the result to World's v4 verify API → if it succeeds,
//                                     sign an attestation (nullifier, wallet) with ATTESTER_PRIVATE_KEY
//   5. POST /api/jury/register       → Circle tx: JurorRegistry.registerPerson(nullifier, attestation)
//   6. POST /api/arbitrator/commit   → Circle tx: JurorRegistry.commitVote(caseId, hidden vote)   (appeal only)
//   7. POST /api/arbitrator/reveal   → Circle tx: JurorRegistry.revealVote(caseId, band, salt)
//   8. GET  /api/arbitrator/panel/:caseId → seats, deadlines, decision
//   9. GET  /api/arbitrator/profile  → my record (cases, with majority, strikes, suspended)
//
// The wallet in the attestation always comes from the signed-in session, never from the request,
// so a proof can only ever be linked to the wallet that asked for it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRequest } from '@worldcoin/idkit-core/signing';
import { recordVerifiedPerson } from './db.js';
import type { Express, NextFunction, Request, Response } from 'express';
import {
  encodeAbiParameters, encodePacked, isAddress, keccak256, parseAbi, parseAbiParameters, zeroAddress,
  type Address, type Hex, type PublicClient,
} from 'viem';
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
// One host for both environments: apps created in the current Developer Portal verify here, staging included
// (the old staging-developer.worldcoin.org host answers "app_not_migrated" for World ID 4.0 apps).
const VERIFY_BASE = () => env('WLD_VERIFY_BASE') || 'https://developer.world.org';
const REGISTRY = () => env('JUROR_REGISTRY_ADDRESS');

const registryAbi = parseAbi([
  'function nullifierOf(address) view returns (uint256)',
  'function profile(uint256 nullifier) view returns (uint32 cases, uint32 withMajority, uint8 strikes, bool suspended)',
  'function decision(uint256 caseId) view returns (bool decided, uint8 band, address[] majority)',
  'function getPanel(uint256 caseId) view returns (address client, address freelancer, uint64 commitDeadline, uint64 revealEnd, uint8 commits, uint8 reveals, bool opened, bool closed, uint8 band, address[3] seats)',
]);

// nonce → wallet it was issued for (short-lived, in memory)
const pendingNonces = new Map<string, { wallet: string; expiresAt: number }>();

export function registerWorldIdRoutes(app: Express, d: WorldIdDeps) {
  const configured = () => !!(env('WLD_APP_ID') && env('WLD_RP_ID') && env('WLD_RP_SIGNING_KEY') && env('ATTESTER_PRIVATE_KEY'));

  // Developer test page for the full IDKit flow (not served in production)
  if (process.env.NODE_ENV !== 'production') {
    const here = path.dirname(fileURLToPath(import.meta.url));
    app.get('/worldid-test', (_req, res) => res.sendFile(path.join(here, '..', 'public', 'worldid-test.html')));
    app.get('/worldid-test/idkit.js', (_req, res) =>
      res.type('application/javascript').sendFile(path.join(here, '..', 'node_modules', '@worldcoin', 'idkit-core', 'dist', 'idkit.global.js')));
  }

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
      const bases = [VERIFY_BASE()];
      let lastError: any = null;
      for (const base of bases) {
        const r = await fetch(`${base}/api/v4/verify/${encodeURIComponent(env('WLD_RP_ID'))}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...result, environment: ENVIRONMENT() }),
        });
        verification = await r.json().catch(() => ({}));
        if (r.ok && verification?.success === true) {
          lastError = null;
          break;
        }
        lastError = { host: base, status: r.status, code: verification?.code, detail: verification?.detail ?? verification };
        console.warn('[worldid] verify rejected:', JSON.stringify(lastError).slice(0, 500));
      }
      if (lastError) {
        return res.status(400).json({
          message: `World ID could not verify this proof (${lastError.code ?? lastError.status}: ${typeof lastError.detail === 'string' ? lastError.detail : 'see server log'}).`,
          ...lastError,
        });
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

    recordVerifiedPerson(wallet, nullifier.toString(), ENVIRONMENT()); // ✓ badge, kept in the database
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

  // 6. hidden vote, step 1: commit. The server derives the salt (so a restart can't lose it)
  //    and remembers the band so the arbitrator only has to press "Reveal" later.
  app.post('/api/arbitrator/commit', d.requireWallet, async (req, res) => {
    if (!registryReady(res)) return;
    const { caseId, band } = req.body ?? {};
    if (!/^\d+$/.test(String(caseId)) || !BANDS.includes(Number(band))) {
      return res.status(400).json({ message: 'Send caseId and band (0, 50, 80 or 100).' });
    }
    const { userToken, walletId, address } = d.sessionOf(res);
    const wallet = address.toLowerCase() as Address;
    const salt = saltFor(String(caseId), wallet);
    const commitment = keccak256(encodeAbiParameters(
      parseAbiParameters('uint256, uint8, bytes32, address'), [BigInt(caseId), Number(band), salt, wallet]));
    pendingBands.set(`${caseId}:${wallet}`, Number(band));
    d.reply(res, await d.contractCall(userToken, walletId, REGISTRY(), 'commitVote(uint256,bytes32)', [String(caseId), commitment]));
  });

  // 7. hidden vote, step 2: reveal (body may repeat the band if the server restarted since the commit)
  app.post('/api/arbitrator/reveal', d.requireWallet, async (req, res) => {
    if (!registryReady(res)) return;
    const { caseId } = req.body ?? {};
    if (!/^\d+$/.test(String(caseId))) return res.status(400).json({ message: 'Send caseId.' });
    const { userToken, walletId, address } = d.sessionOf(res);
    const wallet = address.toLowerCase() as Address;
    const band = pendingBands.get(`${caseId}:${wallet}`) ?? Number(req.body?.band);
    if (!BANDS.includes(band)) return res.status(400).json({ message: 'No committed vote found. Send the band you committed.' });
    d.reply(res, await d.contractCall(userToken, walletId, REGISTRY(), 'revealVote(uint256,uint8,bytes32)',
      [String(caseId), String(band), saltFor(String(caseId), wallet)]));
  });

  // 8. panel status for a case
  app.get('/api/arbitrator/panel/:caseId', d.requireWallet, async (req, res) => {
    if (!registryReady(res)) return;
    const caseId = String(req.params.caseId);
    if (!/^\d+$/.test(caseId)) return res.status(400).json({ message: 'Invalid case.' });
    try {
      const address = REGISTRY() as Address;
      const [client, freelancer, commitDeadline, revealEnd, commits, reveals, opened, closed, band, seats] =
        await d.arc.readContract({ address, abi: registryAbi, functionName: 'getPanel', args: [BigInt(caseId)] });
      const [decided, , majority] = await d.arc.readContract({ address, abi: registryAbi, functionName: 'decision', args: [BigInt(caseId)] });
      const me = d.sessionOf(res).address.toLowerCase();
      res.json({
        caseId, client, freelancer, opened, closed, decided,
        commitDeadline: Number(commitDeadline), revealDeadline: Number(revealEnd),
        commits, reveals, band: closed ? band : null, seats: seats.filter((s) => s !== zeroAddress),
        majority, mySeat: seats.some((s) => s.toLowerCase() === me),
      });
    } catch {
      res.status(502).json({ message: 'Could not read the panel.' });
    }
  });

  // 9. my arbitrator record (tied to my World ID, not my wallet)
  app.get('/api/arbitrator/profile', d.requireWallet, async (_req, res) => {
    if (!registryReady(res)) return;
    try {
      const address = REGISTRY() as Address;
      const nullifier = await d.arc.readContract({
        address, abi: registryAbi, functionName: 'nullifierOf', args: [d.sessionOf(res).address as Address],
      });
      if (nullifier === 0n) return res.json({ registered: false, cases: 0, withMajority: 0, strikes: 0, suspended: false });
      const [cases, withMajority, strikes, suspended] = await d.arc.readContract({
        address, abi: registryAbi, functionName: 'profile', args: [nullifier],
      });
      res.json({ registered: true, cases, withMajority, strikes, suspended });
    } catch {
      res.status(502).json({ message: 'Could not read the arbitrator profile.' });
    }
  });
}

const BANDS = [0, 50, 80, 100];
// caseId:wallet → committed band (memory only; the reveal route also accepts the band again)
const pendingBands = new Map<string, number>();
// deterministic per (case, wallet), secret to the server: nobody can recompute it to read a hidden vote
const saltFor = (caseId: string, wallet: Address): Hex =>
  keccak256(encodePacked(['string', 'uint256', 'address'], [env('JWT_SECRET') || env('ATTESTER_PRIVATE_KEY'), BigInt(caseId), wallet]));
