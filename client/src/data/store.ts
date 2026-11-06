// The data layer. Pages read state through useSettld() and change it only through the
// actions exported here. Today every action updates in-memory fixtures. Each one is async
// and is the single place to swap in a real contract or API call later.
import { useSyncExternalStore } from 'react'
import * as F from './fixtures'
import { addFunds, getBalances, getMe, logout, type Me } from '../api'
import { emailCodeLogin, forgetLogin, rememberEmail, rememberedEmail, walletAndSession } from './circle'
import { sendLiveUsdc, type LiveDeal } from './liveDeals'
import { takeArbitratorSeat, type Attestation } from './worldid'
import { API } from '../lib/apiBase'
import type {
  ActionItem,
  CourtState,
  Deal,
  DealPromise,
  DealSummary,
  DraftPromise,
  FeedEvent,
  Band,
  Payment,
  SplitShare,
} from './types'

export type Draft = {
  creatorEmail: string
  total: number
  currency: string
  promises: DraftPromise[]
  split: SplitShare[]
  scanned: boolean
}

export type SettldState = {
  balance: number
  deals: DealSummary[]
  actions: ActionItem[]
  feed: FeedEvent[]
  deal: Deal
  /** seconds left in the dispute window of the verified promise */
  windowLeft: number
  court: CourtState
  payments: Payment[]
  draft: Draft
  session: Session
  /** the signed-in wallet's real deals, once loaded (null = not loaded / demo) */
  liveDeals: LiveDeal[] | null
  /** the deal open on the Deal page (live mode) */
  selectedDealId: string | null
}

/** Who is signed in. Parties sign in with email (Circle wallet); arbitrators with World ID. */
export type Session = {
  signedIn: boolean
  email: string
  /** which side of the demo deal this account is on */
  role: 'client' | 'freelancer'
  /** proved a unique human with World ID */
  worldId: boolean
  /** the Circle wallet address, when signed in with a real server session */
  address: string
  /** true when balance and actions come from the backend (false = demo data) */
  live: boolean
  /** still asking the server whether there is a session (page load) */
  checking: boolean
}

const clone = <T,>(v: T): T => structuredClone(v)

// The deal draft is kept in this browser so a reload or sign-in doesn't lose what was typed
const DRAFT_KEY = 'settld.draft'
function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    const d = raw ? (JSON.parse(raw) as Draft) : null
    return d && Array.isArray(d.promises) && Array.isArray(d.split) ? d : null
  } catch {
    return null
  }
}
function saveDraft(d: Draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d))
  } catch {
    /* storage blocked: the draft just isn't kept */
  }
}

function initial(): SettldState {
  return {
    balance: F.START_BALANCE,
    deals: clone(F.DEALS),
    actions: clone(F.ACTIONS),
    feed: clone(F.FEED),
    deal: clone(F.DEAL),
    windowLeft: F.WINDOW_LEFT,
    court: { caseId: F.CASE_META.caseId, aiBand: 100, appealed: false, arbSignedIn: false, pick: 100, committed: false, revealed: false, finalBand: null, clock: 120 },
    payments: clone(F.PAYMENTS),
    session: { signedIn: false, email: '', role: 'client', worldId: false, address: '', live: false, checking: true },
    liveDeals: null,
    selectedDealId: null,
    draft: loadDraft() ?? {
      creatorEmail: F.DRAFT.creatorEmail,
      total: F.DRAFT.total,
      currency: F.DRAFT.currency,
      promises: clone(F.DRAFT.promises),
      split: clone(F.SPLIT),
      scanned: false,
    },
  }
}

// Dev only: when this file hot-reloads (any edit to it), keep the current state instead of resetting
// to signed out. Without this, editing code looked like a random logout.
let state: SettldState = (import.meta.hot?.data.state as SettldState | undefined) ?? initial()
if (import.meta.hot) {
  import.meta.hot.dispose((data) => {
    data.state = state
  })
}
const listeners = new Set<() => void>()

function set(fn: (s: SettldState) => SettldState) {
  state = fn(state)
  listeners.forEach((l) => l())
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useSettld<T>(select: (s: SettldState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state), () => select(state))
}

export const getState = () => state

/* ── helpers ── */
const feedNow = (e: Omit<FeedEvent, 'at'>): FeedEvent => ({ ...e, at: 'now' })
let seq = 0
const uid = (p: string) => `${p}${Date.now().toString(36)}${seq++}`

function patchPromise(s: SettldState, id: string, patch: Partial<DealPromise>): Deal {
  return { ...s.deal, promises: s.deal.promises.map((c) => (c.id === id ? { ...c, ...patch } : c)) }
}

/* ── derived values (pure) ── */
export function dealSums(deal: Deal) {
  const { promises } = deal
  const daily = promises.find((c) => c.id === F.DAILY.promiseId)
  const paidDays = F.DAILY.day * F.DAILY.perDay
  const dailyLeft = (daily?.amount ?? 0) - paidDays
  const sum = (xs: DealPromise[]) => xs.reduce((a, c) => a + c.amount, 0)
  const paid = promises.filter((c) => c.state === 'paid').reduce((a, c) => a + (c.split ? c.split.toFreelancer : c.amount), 0) + (daily && (daily.state === 'checking' || daily.state === 'returned') ? paidDays : 0)
  const locked = sum(promises.filter((c) => c.state === 'verified' || c.state === 'locked')) + (daily?.state === 'checking' ? dailyLeft : 0)
  const frozen = sum(promises.filter((c) => c.state === 'frozen'))
  const returned = promises
    .filter((c) => c.state === 'returned')
    .reduce((a, c) => a + (c.id === F.DAILY.promiseId ? dailyLeft : c.split ? c.split.toClient : c.amount), 0) +
    promises.filter((c) => c.state === 'paid' && c.split).reduce((a, c) => a + (c.split?.toClient ?? 0), 0)
  return { paid, locked, frozen, returned }
}

export const nextPayout = (s: SettldState) => {
  const c = s.deal.promises.find((p) => p.state === 'verified')
  return c ? { promise: c, left: s.windowLeft } : null
}

/* ── clocks: the dispute window and the court deadline tick once a second ── */
let clockRefs = 0
let clockTimer: ReturnType<typeof setInterval> | undefined

function tick() {
  set((s) => {
    let next = s
    if (s.windowLeft > 0) {
      const left = s.windowLeft - 1
      next = { ...next, windowLeft: left }
      if (left === 0) {
        const v = next.deal.promises.find((c) => c.state === 'verified')
        if (v) {
          next = {
            ...next,
            deal: patchPromise(next, v.id, { state: 'paid', note: 'Paid on its own when the window closed · split 85 / 10 / 5' }),
            feed: [feedNow({ icon: 'coin', who: 'The contract', text: `paid Freelancer ${v.amount} USDC for clause ${v.n} on its own.` }), ...next.feed],
          }
        }
      }
    }
    if (next.court.appealed && next.court.finalBand === null && next.court.clock > 0) next = { ...next, court: { ...next.court, clock: next.court.clock - 1 } }
    return next
  })
}

/** Start the shared clocks. Returns a stop function (safe under StrictMode double mounts). */
export function startClocks() {
  if (clockRefs++ === 0) clockTimer = setInterval(tick, 1000)
  return () => {
    if (--clockRefs === 0) clearInterval(clockTimer)
  }
}

/* ── actions ──
   Each comment names the real call this will become. */

/** ClauseEscrow.fundDeal (after USDC approve) via POST /api/escrow/approve + /api/escrow/fund */
export async function fundDeal(dealId: string) {
  set((s) => {
    const d = s.deals.find((x) => x.id === dealId)
    if (!d) return s
    return {
      ...s,
      balance: s.balance - d.total,
      deals: s.deals.map((x) => (x.id === dealId ? { ...x, waiting: { chip: 'locked', icon: 'lock', label: 'Locked · waiting for video' } } : x)),
    }
  })
}

/** ClauseEscrow.release(dealId, clauseId) via POST /api/escrow/release */
export async function releasePromise(id: string) {
  set((s) => {
    const c = s.deal.promises.find((x) => x.id === id)
    if (!c) return s
    return {
      ...s,
      deal: patchPromise(s, id, { state: 'paid', note: 'Paid just now · split 85 / 10 / 5' }),
      feed: [feedNow({ icon: 'coin', who: 'The contract', text: `paid Freelancer ${c.amount} USDC for clause ${c.n}.` }), ...s.feed],
    }
  })
}

/** Opens a court case for one promise (server court flow, CRE wf3-court) */
export async function disputePromise(id: string, reason: string) {
  void reason
  set((s) => {
    const c = s.deal.promises.find((x) => x.id === id)
    if (!c) return s
    return {
      ...s,
      deal: patchPromise(s, id, { state: 'frozen', note: 'Disputed by you · in court' }),
      feed: [feedNow({ icon: 'b', who: 'You', text: `disputed clause ${c.n}.` }), ...s.feed],
    }
  })
}

/** Demo only: what the daily Chainlink check does when the video goes private (ClauseEscrow.refund) */
export async function breachPromise(id: string) {
  set((s) => ({
    ...s,
    deal: patchPromise(s, id, { state: 'returned', note: 'Stopped on day 12 · video went private · 180 USDC came back to you' }),
    feed: [feedNow({ icon: 'back', who: 'The contract', text: 'stopped clause 03 on day 12 and returned 180 USDC to you.' }), ...s.feed],
  }))
}

/** POST /api/escrow/propose (ClauseEscrow.proposeDeal) */
export async function proposeDeal(draft: Draft) {
  void draft
}

export function updateDraft(fn: (d: Draft) => Draft) {
  set((s) => ({ ...s, draft: fn(s.draft) }))
  saveDraft(state.draft)
}

/* Court (V2): three AI judges decide a band; a party may appeal (10% fee) to a panel of
   World ID verified human arbitrators, who commit and then reveal their band. */

/** Settles the disputed promise: band 100 pays Freelancer the whole clause, band 0 refunds Client */
function settleCase(s: SettldState, band: Band, byHumans: boolean): SettldState {
  const c = s.deal.promises.find((p) => p.id === F.CASE_META.promiseId)
  if (!c) return s
  const toF = (c.amount * band) / 100
  const toC = c.amount - toF
  const who = byHumans ? 'Arbitrators' : 'AI judges'
  return {
    ...s,
    court: { ...s.court, finalBand: band },
    deal: patchPromise(s, c.id, {
      state: toF > 0 ? 'paid' : 'returned',
      split: { toFreelancer: toF, toClient: toC },
      note: band === 100 ? `${who} decided · paid to Freelancer in full` : band === 0 ? `${who} decided · refunded to Client in full` : `${who} decided · Freelancer ${toF} · Client ${toC}`,
    }),
    feed: [feedNow({ icon: byHumans ? 'person' : 'gear', who, text: toC === 0 ? `settled clause ${c.n}: all ${toF} USDC to Freelancer.` : toF === 0 ? `settled clause ${c.n}: all ${toC} USDC back to you.` : `settled clause ${c.n}: ${toF} USDC to Freelancer, ${toC} USDC back to you.` }), ...s.feed],
  }
}

/** Nobody appealed in time: the AI band becomes final (keeper calls finalize + resolveDispute) */
export async function acceptAiVerdict() {
  set((s) => (s.court.aiBand === null || s.court.finalBand !== null ? s : settleCase(s, s.court.aiBand, false)))
}

/** POST /api/court/:caseId/approve-fee then /appeal (appeal fee from appealFee(caseId)) */
export async function appealCase() {
  set((s) => ({
    ...s,
    balance: s.balance - F.CASE_META.appealFee,
    court: { ...s.court, appealed: true },
    feed: [feedNow({ icon: 'person', who: 'You', text: `appealed clause 04 to human arbitrators · ${F.CASE_META.appealFee} USDC fee.` }), ...s.feed],
  }))
}

/** World ID verify + POST /api/jury/register (server/src/worldid.ts) */
/** After a real World ID proof: take (or confirm) the JurorRegistry seat, then open the court */
export async function signInArbitrator(att: Attestation) {
  await takeArbitratorSeat(att)
  set((s) => ({ ...s, court: { ...s.court, arbSignedIn: true } }))
}

export async function signOutArbitrator() {
  set((s) => ({ ...s, court: { ...s.court, arbSignedIn: false } }))
}

export function pickBand(pick: Band) {
  set((s) => ({ ...s, court: { ...s.court, pick } }))
}

/** POST /api/arbitrator/commit { caseId, band } (the band stays hidden until reveal) */
export async function commitVote() {
  set((s) => ({ ...s, court: { ...s.court, committed: true } }))
}

/** POST /api/arbitrator/reveal { caseId }; the panel closes on the majority band */
export async function revealVote() {
  set((s) => settleCase({ ...s, court: { ...s.court, revealed: true } }, s.court.pick, true))
}

/** POST /api/funds/add (test treasury sends test USDC) */
/** POST /api/funds/add: the test treasury sends testnet USDC. Shows the on-chain balance it returns
 *  (Circle's own balance index lags a few seconds). Throws the server's message, e.g. an empty treasury. */
export async function addTestUsdc(): Promise<number> {
  if (state.session.live) {
    const r = await addFunds()
    const amount = Number(r.amount)
    set((s) => ({
      ...s,
      balance: r.balance !== undefined ? Number(r.balance) : s.balance + amount,
      payments: [{ id: r.txHash || uid('p'), when: 'Just now', what: 'Test USDC added', who: { icon: 'plus', label: 'Test faucet' }, amount, kind: 'received' }, ...s.payments],
    }))
    if (r.balance === undefined) void refreshBalance()
    void loadHistory().catch(() => {})
    return amount
  }
  await new Promise((r) => setTimeout(r, 1400))
  set((s) => ({
    ...s,
    balance: s.balance + F.FAUCET_AMOUNT,
    payments: [{ id: uid('p'), when: 'Just now', what: 'Test USDC added', who: { icon: 'plus', label: 'Test faucet' }, amount: F.FAUCET_AMOUNT, kind: 'received' }, ...s.payments],
  }))
  return F.FAUCET_AMOUNT
}

/** Circle transfer from the signed-in wallet. Only recorded once Arc confirms it; the balance is re-read from chain. */
export async function sendUsdc(to: string, amount: number) {
  if (!state.session.live) throw new Error('Sign in with your email first. Sending moves real test USDC on Arc.')
  const txHash = await sendLiveUsdc(to, amount)
  set((s) => ({
    ...s,
    payments: [{ id: txHash || uid('p'), when: 'Just now', what: `Sent to ${to.slice(0, 6)}…${to.slice(-4)}`, who: { icon: 'arrow', label: 'You' }, amount: -amount, kind: 'paid' }, ...s.payments],
  }))
  await refreshBalance().catch(() => {})
  void loadHistory().catch(() => {})
}

/* ── session ──
   Email sign-in is real: Circle emails a 6-digit code, a first sign-in creates a PIN wallet, and the
   server opens a session for that wallet (cookie). World ID sign-in for parties is still a demo step. */

const ROLE_KEY = 'settld.role'
const savedRole = (): Session['role'] => {
  try {
    return localStorage.getItem(ROLE_KEY) === 'freelancer' ? 'freelancer' : 'client'
  } catch {
    return 'client'
  }
}
const saveRole = (r: Session['role']) => {
  try {
    localStorage.setItem(ROLE_KEY, r)
  } catch {
    /* storage blocked: the choice just isn't remembered */
  }
}

/** Real wallet history (GET /api/wallet/history): every completed transaction that moved USDC, with its receipt link */
export async function loadHistory() {
  if (!state.session.live) return
  const r = await fetch(`${API}/wallet/history`, { credentials: 'include' })
  if (!r.ok) return
  const { explorer, payments } = (await r.json()) as {
    explorer: string
    payments: { id: string; txHash: string; at: string; what: string; who: Payment['who']; amount: string; kind: Payment['kind'] }[]
  }
  set((s) => ({
    ...s,
    payments: payments.map((p) => ({ id: p.id, when: whenOf(p.at), what: p.what, who: p.who, amount: Number(p.amount), kind: p.kind, href: `${explorer}/tx/${p.txHash}` })),
  }))
}
const whenOf = (iso: string) => {
  const t = Date.parse(iso)
  if (!t) return ''
  const min = Math.round((Date.now() - t) / 60000)
  if (min < 1) return 'Just now'
  if (min < 60) return `${min} min ago`
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`
  return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

/** Live USDC balance of the signed-in wallet */
export async function refreshBalance() {
  const { tokenBalances } = await getBalances()
  const usdc = Number(tokenBalances.find((t) => t.token?.symbol?.startsWith('USDC'))?.amount ?? 0)
  set((s) => ({ ...s, balance: usdc }))
}

function startSession(me: Me, email: string, role: Session['role']) {
  saveRole(role)
  // a real wallet: drop the demo rows; its own transactions load from the chain
  set((s) => ({ ...s, payments: [], session: { ...s.session, signedIn: true, live: true, email, role, address: me.address } }))
  void refreshBalance().catch(() => {})
  void loadHistory().catch(() => {})
}

/** Email + 6-digit code (Circle). A new account also gets a PIN wallet. */
export async function signInParty(email: string, role: Session['role']) {
  const login = await emailCodeLogin(email)
  const me = await walletAndSession(login)
  startSession(me, email, role)
}

/** On page load: reuse the server session (cookie) if there is one */
export async function restoreSession() {
  // only a 401 means "not signed in". A slow, restarting or cold server (timeouts, 5xx) is retried,
  // so a brief backend hiccup doesn't look like a logout.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const me = await getMe()
      startSession(me, rememberedEmail(), savedRole())
      break
    } catch (e) {
      const status = (e as { status?: number }).status
      if (status === 401 || status === 403) break
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  set((s) => ({ ...s, session: { ...s.session, checking: false } }))
}

/** A party signing in through World ID (demo step until the IDKit widget is wired) */
/** After a real World ID proof (data/worldid.ts) on the signed-in wallet: show the verified-human badge */
export async function signInWithWorldId() {
  if (!state.session.live) throw new Error('Sign in with your email first: World ID is linked to your Settld wallet.')
  set((s) => ({ ...s, session: { ...s.session, worldId: true } }))
}

export function setRole(role: Session['role']) {
  saveRole(role)
  set((s) => ({ ...s, session: { ...s.session, role } }))
}

export function selectDeal(id: string) {
  set((s) => ({ ...s, selectedDealId: id }))
}

export function setLiveDeals(deals: LiveDeal[]) {
  set((s) => ({ ...s, liveDeals: deals }))
}

/** The server no longer has this session (it restarted or the session expired): sign out here too,
 *  keeping the draft deal so nothing typed is lost */
export function sessionEnded() {
  forgetLogin()
  set((s) => ({ ...s, liveDeals: null, session: { ...s.session, signedIn: false, live: false, address: '', checking: false } }))
}

export async function signOut() {
  if (state.session.live) await logout().catch(() => {})
  forgetLogin()
  rememberEmail('') // signing out forgets the email on this device
  set((s) => ({
    ...s,
    balance: F.START_BALANCE,
    session: { signedIn: false, email: '', role: 'client', worldId: false, address: '', live: false, checking: false },
    liveDeals: null,
    court: { ...s.court, arbSignedIn: false },
  }))
}
