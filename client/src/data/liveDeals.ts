// The signed-in wallet's real deals from ClauseEscrow (GET /api/escrow/my-deals), mapped to what the
// Dashboard shows, plus the actions a party can take (each one is approved with the Circle PIN).
import { API } from '../lib/apiBase'
import { parseUnits } from 'viem'
import { getDealTransaction, getProposedDeal, prepareApproval, prepareDealAction, type DealAction } from '../api'
import { approveWithPin, ensurePinReady } from './circle'
import type { ChipKind, IconName } from './types'

export type LiveClause = {
  status: number
  amount: string
  deadline: string
  checkType: number
  param: string
  dependsOn: number
  onFail: number
  disputeWindowEnd: string
  /** court case id for a disputed clause, "0" if never disputed */
  caseId: string
}

export type LiveDeal = {
  dealId: string
  role: 'client' | 'freelancer'
  client: string
  freelancer: string
  total: string
  accepted: boolean
  funded: boolean
  certified: boolean
  clauses: LiveClause[]
}

/** ClauseStatus from docs/INTERFACES.md */
export const STATUS = ['Pending', 'Submitted', 'Verified', 'Failed', 'Disputed', 'Released', 'Refunded', 'Broken'] as const

export async function fetchMyDeals(): Promise<LiveDeal[]> {
  const r = await fetch(`${API}/escrow/my-deals`, { credentials: 'include' })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.message || 'Could not load your deals.')
  return body.deals as LiveDeal[]
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** [paid, verified, checking, frozen, locked] in USDC, same buckets as the demo progress bar */
export function progressOf(d: LiveDeal): [number, number, number, number, number] {
  const p: [number, number, number, number, number] = [0, 0, 0, 0, 0]
  for (const c of d.clauses) {
    const a = Number(c.amount)
    if (c.status === 5) p[0] += a
    else if (c.status === 2) p[1] += a
    else if (c.status === 1) p[2] += a
    else if (c.status === 4) p[3] += a
    else if (c.status !== 6 && c.status !== 3) p[4] += a
  }
  return p
}

/** What the deal is waiting on, in plain words */
export function waitingOf(d: LiveDeal): { chip: ChipKind; icon: IconName; label: string } {
  if (!d.accepted) return d.role === 'freelancer' ? { chip: 'need', icon: 'bang', label: 'Read and accept' } : { chip: 'pend', icon: 'play', label: 'Waiting for the freelancer' }
  if (!d.certified) return { chip: 'check', icon: 'hex', label: 'Chainlink certifying…' }
  if (!d.funded) return d.role === 'client' ? { chip: 'need', icon: 'bang', label: 'Ready to fund' } : { chip: 'pend', icon: 'lock', label: 'Waiting for funding' }
  if (d.clauses.some((c) => c.status === 4)) return { chip: 'froz', icon: 'gear', label: 'In court' }
  if (d.clauses.some((c) => c.status === 1)) return { chip: 'check', icon: 'hex', label: 'Chainlink checking…' }
  if (d.clauses.some((c) => c.status === 2 || c.status === 3)) return { chip: 'ver', icon: 'clock', label: 'Dispute window open' }
  if (d.clauses.some((c) => c.status === 0)) return d.role === 'freelancer' ? { chip: 'need', icon: 'play', label: 'Submit your work' } : { chip: 'pend', icon: 'play', label: 'Waiting for the work' }
  return { chip: 'paid', icon: 'check', label: 'Settled' }
}

/** Sends one escrow action: the server prepares it, the user approves it with their PIN. Returns the Circle ref id. */
export async function runDealAction(action: DealAction): Promise<string> {
  await ensurePinReady()
  const { challengeId, refId } = await prepareDealAction(action)
  await approveWithPin(challengeId)
  return refId
}

/** Waits until Circle reports the transaction confirmed (or failed) */
export async function waitForTx(refId: string, timeoutMs = 90_000): Promise<string | undefined> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const tx = await getDealTransaction(refId).catch(() => undefined)
    if (tx?.state === 'CONFIRMED' || tx?.state === 'COMPLETE') return tx.txHash
    if (tx?.state === 'FAILED' || tx?.state === 'DENIED' || tx?.state === 'CANCELLED') throw new Error(tx.errorReason || 'The transaction failed on Arc.')
    await new Promise((r) => setTimeout(r, 2500))
  }
  return undefined
}

/** Client funds a deal: approve the escrow to take the USDC, then fund (two PIN prompts) */
export async function fundLiveDeal(d: LiveDeal, balance?: number) {
  // say it plainly before anything is approved: funding needs the full total in this wallet
  if (balance !== undefined && balance < Number(d.total))
    throw new Error(`You need ${Number(d.total).toLocaleString('en-US')} USDC to fund this deal and have ${balance.toLocaleString('en-US', { maximumFractionDigits: 2 })}. Add test USDC in Wallet first.`)
  await ensurePinReady()
  const { challengeId } = await prepareApproval(parseUnits(d.total, 6).toString())
  await approveWithPin(challengeId)
  await new Promise((r) => setTimeout(r, 4000)) // let the approval land before funding
  const ref = await runDealAction({ kind: 'fund', dealId: d.dealId })
  await waitForTx(ref)
}

/** Real USDC transfer from the signed-in wallet: the server checks the address and balance, the user approves
 *  with their PIN, then we wait for Arc to confirm it. Throws (nothing is shown as sent) if any step fails. */
export async function sendLiveUsdc(to: string, amount: number): Promise<string | undefined> {
  await ensurePinReady()
  const { challengeId, refId } = await postJson<{ challengeId: string; refId: string }>('/wallet/send', {
    to: to.trim(),
    amount: parseUnits(String(amount), 6).toString(),
  })
  await approveWithPin(challengeId)
  const txHash = await waitForTx(refId)
  if (!txHash) throw new Error('Arc hasn’t confirmed the transfer yet. Check Wallet again in a minute before resending.')
  return txHash
}

export async function acceptLiveDeal(d: LiveDeal) {
  const ref = await runDealAction({ kind: 'accept', dealId: d.dealId })
  await waitForTx(ref)
}

/** Money summary for the Dashboard, from the wallet's real deals */
export function moneyOf(deals: LiveDeal[]) {
  let locked = 0, paidOut = 0, received = 0, frozen = 0
  for (const d of deals) {
    if (!d.funded) continue
    for (const c of d.clauses) {
      const a = Number(c.amount)
      if (c.status === 4) frozen += a
      else if (c.status === 5) {
        if (d.role === 'client') paidOut += a
        else received += a
      }
      else if (c.status !== 6 && c.status !== 7) locked += a
    }
  }
  return { locked, paidOut, received, frozen }
}

/* ── actions on one deal (all approved with the Circle PIN) ── */

async function postJson<T>(path: string, body: object): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((data as { message?: string }).message || `Request failed (${r.status})`)
  return data as T
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { credentials: 'include' })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((data as { message?: string }).message || `Request failed (${r.status})`)
  return data as T
}

/** Client proposes a deal on-chain. Returns the new deal id once Arc has it. */
export async function proposeLive(freelancer: string, totalUsdc: number, terms: { kind: number; checkType: number; param: string; deadline: bigint; amount: bigint; dependsOn: number; onFail: number; vestDays: number }[]): Promise<string> {
  const clauses = terms.map((t) => ({ ...t, deadline: t.deadline.toString(), amount: t.amount.toString() }))
  const ref = await runDealAction({ kind: 'propose', creator: freelancer, total: parseUnits(String(totalUsdc), 6).toString(), clauses })
  const txHash = await waitForTx(ref)
  if (!txHash) throw new Error('The proposal is still confirming. It will show on your Dashboard in a moment.')
  for (let i = 0; i < 8; i++) {
    const r = await getProposedDeal(txHash).catch(() => null)
    if (r?.dealId) return r.dealId
    await new Promise((res) => setTimeout(res, 2000))
  }
  throw new Error('Proposed, but the deal number is not readable yet. It will show on your Dashboard.')
}

/** Freelancer submits the work for one clause: any link, or an IPFS id of a screenshot */
export async function submitWork(dealId: string, clauseId: number, evidence: string) {
  const ref = await runDealAction({ kind: 'submit', dealId, clauseId, videoId: evidence.trim() })
  await waitForTx(ref)
}

/** Client or freelancer disputes a Verified or Failed clause inside its window */
export async function disputeClause(dealId: string, clauseId: number, reason: string) {
  await ensurePinReady()
  const { challengeId } = await postJson<{ challengeId: string }>('/escrow/dispute', { dealId, clauseId, reason: reason.trim() })
  await approveWithPin(challengeId)
}

export type CaseStatus = {
  caseId: string
  aiVerdict: number | null
  appealDeadline: string | null
  canAppeal: boolean
  appealFeeUnits: string
  appealed: boolean
  finalized: boolean
  finalBand: number | null
  byHumans: boolean
}

export const caseStatus = (caseId: string) => getJson<CaseStatus>(`/court/${caseId}/status`)

/** Appeal the AI verdict: approve the fee (appealFee from the contract), then appeal. Two PIN prompts. */
export async function appealCase(caseId: string) {
  await ensurePinReady()
  const a = await postJson<{ challengeId: string }>(`/court/${caseId}/approve-fee`, {})
  await approveWithPin(a.challengeId)
  await new Promise((r) => setTimeout(r, 4000))
  const b = await postJson<{ challengeId: string }>(`/court/${caseId}/appeal`, {})
  await approveWithPin(b.challengeId)
}
