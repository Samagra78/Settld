// Real World ID (IDKit 4) for Settld.
// 1. POST /api/worldid/rp-context  → our server signs the request; signal = the signed-in wallet
// 2. IDKitRequestWidget (QR / World App / simulator) produces the proof
// 3. POST /api/worldid/verify       → the server checks it with World and signs an attestation (nullifier, wallet)
// 4. POST /api/jury/register        → JurorRegistry.registerPerson (Circle PIN), unless this wallet already holds the seat
import { API } from '../lib/apiBase'
import { approveWithPin, ensurePinReady } from './circle'

export type WorldIdRequest = {
  appId: `app_${string}`
  action: string
  environment: 'production' | 'staging'
  signal: string
  rpContext: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string }
}
export type Attestation = { nullifier: string; signature: string; attester: string; wallet: string }

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, body === undefined
    ? { credentials: 'include' }
    : { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const e = new Error((data as { message?: string }).message || `Request failed (${r.status})`) as Error & { status?: number }
    e.status = r.status
    throw e
  }
  return data as T
}

/** Everything the widget needs. Needs an email (Circle) sign-in: the proof is tied to that wallet. */
export async function startWorldId(): Promise<WorldIdRequest> {
  const cfg = await call<{ enabled: boolean; appId: string; action: string; environment: 'production' | 'staging' }>('/worldid/config')
  if (!cfg.enabled) throw new Error('World ID is not set up on the server yet.')
  const ctx = await call<{ rp_context: WorldIdRequest['rpContext']; signal: string; action: string; environment: 'production' | 'staging' }>('/worldid/rp-context', {})
  return { appId: cfg.appId as `app_${string}`, action: ctx.action, environment: ctx.environment, signal: ctx.signal, rpContext: ctx.rp_context }
}

/** Server-side check with World; throws (and the widget shows an error) if World rejects the proof */
export const verifyWorldId = (result: unknown) => call<Attestation>('/worldid/verify', result)

export const arbitratorStatus = () =>
  call<{ wallet: string; verified: boolean; arbitrator: boolean; canAccessCourt: boolean }>('/arbitrator/me')

/** Take (or confirm) this person's arbitrator seat on JurorRegistry. Asks for the PIN only when a seat is new. */
export async function takeArbitratorSeat(att: Attestation): Promise<'existing' | 'new'> {
  const r = await call<{ alreadyRegistered?: boolean; challengeId?: string }>('/jury/register', { nullifier: att.nullifier, signature: att.signature })
  if (r.alreadyRegistered) return 'existing'
  if (!r.challengeId) throw new Error('The registry did not return a transaction to approve.')
  await ensurePinReady()
  await approveWithPin(r.challengeId)
  // wait for Arc to record the seat (the server reads it straight from the registry)
  const until = Date.now() + 90_000
  while (Date.now() < until) {
    const me = await arbitratorStatus().catch(() => null)
    if (me?.arbitrator) return 'new'
    await new Promise((res) => setTimeout(res, 3000))
  }
  throw new Error('Arc hasn’t recorded your seat yet. Open the court again in a minute.')
}
