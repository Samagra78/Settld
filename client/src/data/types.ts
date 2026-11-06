// Domain types for the Settld frontend. Fixtures implement these today; contract and API
// adapters will implement the same shapes later.

export type IconName =
  | 'check'
  | 'cross'
  | 'lock'
  | 'clock'
  | 'bang'
  | 'arrow'
  | 'back'
  | 'hex'
  | 'gear'
  | 'person'
  | 'play'
  | 'coin'
  | 'replay'
  | 'b'
  | 'shield'
  | 'plus'

/** Chip variants from the design system (.c-*) */
export type ChipKind = 'locked' | 'check' | 'need' | 'ver' | 'paid' | 'froz' | 'fail' | 'pend'

/** Who did something: an icon plus a label */
export type Actor = { icon: IconName; label: string }

export type Party = 'creator' | 'brand'

/* ── Dashboard ── */
export type DealSummary = {
  id: string
  who: string
  initial: string
  total: number
  /** [paid, verified, checking, frozen, locked] in USDC */
  progress: [number, number, number, number, number]
  waiting: { chip: ChipKind; icon: IconName; label: string }
}

export type FeedEvent = { icon: IconName; who: string; text: string; at: string }

export type ActionItem = {
  id: string
  title: string
  detail: string
  cta: string
  kind: 'fund' | 'view'
  dealId: string
}

export type MoneySummary = {
  locked: number
  paidOut30d: number
  frozen: number
  received30d: number
}

/* ── Deal ── */
export type PromiseState = 'paid' | 'verified' | 'checking' | 'frozen' | 'returned' | 'locked' | 'failed'

export type DealPromise = {
  id: string
  n: string
  title: string
  amount: number
  state: PromiseState
  kind: string
  note: string
  /** court split when a dispute settled with a band */
  split?: { toFreelancer: number; toClient: number }
}

export type Deal = {
  id: string
  number: string
  brand: string
  creator: string
  total: number
  promises: DealPromise[]
  split: SplitShare[]
  timeline: { label: string; at: string; done: boolean }[]
}

export type SplitShare = { who: string; pct: number }

/* ── How it works (theatre) ── */
export type TheatreScene = {
  title: string
  who: Actor
  line: string
  next: string
  states: Partial<Record<string, PromiseState>>
  /** [locked, paid, returned, frozen, not funded] in USDC */
  money: [number, number, number, number, number]
}

/* ── Overview ── */
export type LifeStage = {
  key: string
  bg: string
  fg: string
  text: string
  who: string
  art: 'sheet' | 'scan' | 'safe' | 'video' | 'hex' | 'paid'
}

/* ── New deal ── */
/** CheckType from docs/INTERFACES.md: 0 YouTube posted, 1 description contains, 4 link live,
 *  5 page contains, 6 GitHub PR merged, 7 AI check against the brief */
export type CheckTypeId = 0 | 1 | 4 | 5 | 6 | 7

export type DraftPromise = {
  check: CheckTypeId
  amount: number
  date: string
  param?: string
  /** index of the promise this one waits on, or '' */
  dep: string
  fail: 'all' | 'rest'
}

export type CheckInfo = { check: CheckTypeId; label: string; hint: string; icon: IconName; color: string; paramLabel: string; paramPlaceholder: string }

/* ── Court ── */
export type Juror = {
  id: string
  name: string
  vote: Party | null
  reason: string
  cites: { label: string; bad?: boolean }[]
  thrownOut?: boolean
}

export type CourtCase = {
  id: string
  dealId: string
  promiseId: string
  question: string
  amount: number
  jurors: Juror[]
  recommends: Party
  evidence: string[]
}

/** Court verdict band: the freelancer's % of the clause (the rest is refunded to the client) */
export type Band = 0 | 50 | 80 | 100

/** Local court state for the demo case (the disputed promise on the Deal page) */
export type CourtState = {
  caseId: string
  /** AI verdict once the three judges finished, else null */
  aiBand: Band | null
  /** a party paid the appeal fee and sent the case to human arbitrators */
  appealed: boolean
  /** signed in with a World ID verified arbitrator account */
  arbSignedIn: boolean
  /** the band this arbitrator is about to commit */
  pick: Band
  committed: boolean
  revealed: boolean
  /** final band after the appeal (or the AI band when nobody appealed) */
  finalBand: Band | null
  /** seconds left in the arbitrators' commit window */
  clock: number
}

/* ── API shapes (docs/INTERFACES.md and server/src) ── */
export type JudgeTurn = { band: Band; statement: string; cited: number[]; wantsExtend: boolean; isFinal: boolean; wordsUsed: number; note?: string }
export type CourtRound = { round: number; extensionGranted: boolean; wordBudget: number; deadline: number; judges: JudgeTurn[] }
export type CourtTranscript = { reason: string; terms: unknown; evidence: string; judges: string[]; deadline0: number; rounds: CourtRound[] }
export type CourtCaseResponse = { caseId: string; transcriptHash: string; transcript: CourtTranscript }

export type CourtStatus = {
  caseId: string
  aiVerdict: Band | null
  appealDeadline: number | null
  canAppeal: boolean
  appealFeeUnits: string
  appealed: boolean
  finalized: boolean
  finalBand: Band | null
  byHumans: boolean
}

export type ArbitratorMe = { wallet: string; verified: boolean; arbitrator: boolean; canAccessCourt: boolean }

export type ArbitratorHistoryRow = {
  /** seeded demo case (not on-chain) */
  demo?: boolean
  caseId: string
  dealId: string
  clauseId: number
  reason: string
  myBand: Band | null
  aiBand: Band | null
  finalBand: Band | null
  outcome: 'pending' | 'with_majority' | 'against_majority'
  feeEarnedUnits: string
}

export type ArbitratorDashboard = {
  wallet: string
  profile: { cases: number; withMajority: number; strikes: number; suspended: boolean }
  totals: { casesTaken: number; casesDecided: number; rightCalls: number; wrongCalls: number; pending: number; feesEarnedUnits: string }
  history: ArbitratorHistoryRow[]
}

export type OpenCase = {
  caseId: string
  dealId: string
  clauseId: number
  reason: string
  aiBand: Band
  commitDeadline: number
  revealDeadline: number
  seatsTaken: number
  reveals: number
  mySeat: boolean
  canJoin: boolean
  blockedReason: string | null
  /** seeded demo case (not on-chain) */
  demo?: boolean
}

export type AutomationStatus = {
  enabled: boolean
  running: string | null
  queued: string[]
  recent: { at: number; kind: string; label: string; ok: boolean; detail?: string }[]
}

/* ── Wallet ── */
export type PaymentKind = 'received' | 'paid' | 'locked' | 'returned'

export type Payment = {
  id: string
  when: string
  what: string
  who: Actor
  amount: number
  kind: PaymentKind
  /** the transaction on Arc's explorer (real rows only) */
  href?: string
}

export type Notification = { icon: IconName; text: string; at: string }

export type CoinStack = { id: string; paid: number; locked: number; label: string; sub: string; filter: PaymentKind }
