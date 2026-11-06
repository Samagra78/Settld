// Mock data from the approved design (DEALS, FEED, CL, NC, PAY, SC and friends).
// Only the store in ./store.ts reads these. Swap them for contract and API reads there.
import type {
  ActionItem,
  ArbitratorDashboard,
  Band,
  CourtTranscript,
  JudgeTurn,
  OpenCase,
  CoinStack,
  Deal,
  DealSummary,
  DraftPromise,
  FeedEvent,
  LifeStage,
  MoneySummary,
  Notification,
  Payment,
  CheckInfo,
  SplitShare,
  TheatreScene,
} from './types'

export const START_BALANCE = 1240

/** Dispute window length and how much of it is left at load, in seconds (demo time) */
export const WINDOW_LENGTH = 120
export const WINDOW_LEFT = 102

/** Court decision clock at load: 05:40:12 */
export const COURT_CLOCK = 5 * 3600 + 40 * 60 + 12

export const DEALS: DealSummary[] = [
  { id: 'd1', who: 'Freelancer', initial: 'C', total: 1000, progress: [300, 200, 0, 0, 500], waiting: { chip: 'ver', icon: 'clock', label: 'Releasing in 1:42' } },
  { id: 'd2', who: 'Freelancer B', initial: 'B', total: 2100, progress: [850, 0, 0, 0, 1250], waiting: { chip: 'pend', icon: 'play', label: 'Waiting for video' } },
  { id: 'd3', who: 'Freelancer C', initial: 'C', total: 1050, progress: [0, 0, 0, 0, 1050], waiting: { chip: 'need', icon: 'bang', label: 'Ready to fund' } },
  { id: 'd4', who: 'Freelancer D', initial: 'D', total: 1500, progress: [300, 0, 0, 0, 1200], waiting: { chip: 'check', icon: 'hex', label: 'Chainlink certifying…' } },
]

export const ACTIONS: ActionItem[] = [
  { id: 'a1', title: 'Fund “Client × Freelancer C”', detail: 'Freelancer C accepted and Chainlink certified it 2 min ago.', cta: 'Fund 1,050 USDC', kind: 'fund', dealId: 'd3' },
  { id: 'a2', title: 'Review clause 02 of “Client × Freelancer B”', detail: '#ClientPartner not found · 200 returns to you in 1:42 unless they dispute.', cta: 'View', kind: 'view', dealId: 'd1' },
]

export const MONEY: MoneySummary = { locked: 3500, paidOut30d: 1600, frozen: 200, received30d: 4600 }

export const FEED: FeedEvent[] = [
  { icon: 'hex', who: 'Chainlink', text: 'verified clause 02 of “Client × Freelancer”: link and #ad found.', at: '14:31' },
  { icon: 'play', who: 'Freelancer', text: 'submitted the video for clauses 01 and 02.', at: '14:30' },
  { icon: 'coin', who: 'The contract', text: 'paid Freelancer 300 USDC for clause 01 · split 255 / 30 / 15.', at: '14:24' },
  { icon: 'lock', who: 'The contract', text: 'locked 1,000 USDC in the safe.', at: '14:12' },
  { icon: 'hex', who: 'Chainlink', text: 'certified the deal: 57 states, no human involved.', at: '14:10' },
  { icon: 'play', who: 'Freelancer', text: 'accepted the deal.', at: '14:09' },
  { icon: 'b', who: 'You', text: 'proposed the deal.', at: '14:02' },
]

export const SPLIT: SplitShare[] = [
  { who: 'Freelancer', pct: 85 },
  { who: 'Manager', pct: 10 },
  { who: 'Editor', pct: 5 },
]

/** Deal 042: the demo deal shown on the Deal page (CL in the design) */
export const DEAL: Deal = {
  id: 'd1',
  number: '042',
  brand: 'Client',
  creator: 'Freelancer',
  total: 1000,
  split: SPLIT,
  promises: [
    { id: 'c1', n: '01', title: 'Video posted by 20 Nov, 18:00', amount: 300, state: 'paid', kind: 'One-time', note: 'Paid 14:24 · Freelancer 255 · manager 30 · editor 15' },
    { id: 'c2', n: '02', title: 'Description has our link and #ad', amount: 200, state: 'verified', kind: 'One-time', note: 'Verified by Chainlink · every node returned the same verdict' },
    { id: 'c3', n: '03', title: 'Video stays public for 30 days', amount: 300, state: 'checking', kind: 'Ongoing · pays daily', note: 'Day 12 of 30 · 120 of 300 paid so far' },
    { id: 'c4', n: '04', title: 'Product clearly featured, positive tone', amount: 200, state: 'frozen', kind: 'Judgement call', note: 'Disputed by Client · in court' },
  ],
  timeline: [
    { label: 'Proposed', at: '14:02', done: true },
    { label: 'Accepted', at: '14:09', done: true },
    { label: 'Certified by Chainlink', at: '14:10', done: true },
    { label: 'Funded · 1,000 USDC', at: '14:12', done: true },
    { label: 'Clause 01 paid', at: '14:24', done: true },
  ],
}

/** The ongoing promise (03) pays 10 USDC a day; on day 12 of 30 */
export const DAILY = { promiseId: 'c3', day: 12, days: 30, perDay: 10 }

/* ── How it works: the ten scenes (SC) ── */
export const SCENE_PROMISES = [
  { id: 'c1', amount: 6, label: '01', text: '300 · video posted' },
  { id: 'c2', amount: 4, label: '02', text: '200 · link + #ad' },
  { id: 'c3', amount: 6, label: '03', text: '300 · stays public' },
  { id: 'c4', amount: 4, label: '04', text: '200 · product shown' },
]

export const SCENES: TheatreScene[] = [
  { title: 'Safety check', who: { icon: 'shield', label: 'Settld check · automatic' }, line: 'We tried every way this deal could go. All 57 paths end with every dollar reaching someone.', next: 'Next: Chainlink certifies the check on the public record.', states: {}, money: [0, 0, 0, 0, 1000] },
  { title: 'Locked', who: { icon: 'b', label: 'Client funded · contract holds' }, line: '1,000 USDC is locked in the safe. Four lanes, one per promise. Nobody can take it early.', next: 'Next: Freelancer posts the video.', states: { c1: 'locked', c2: 'locked', c3: 'locked', c4: 'locked' }, money: [1000, 0, 0, 0, 0] },
  { title: 'Delivering', who: { icon: 'play', label: 'Freelancer' }, line: 'Freelancer submitted the video for promises 01 and 02.', next: 'Next: Chainlink nodes check it.', states: { c1: 'checking', c2: 'checking' }, money: [1000, 0, 0, 0, 0] },
  { title: 'Checking', who: { icon: 'hex', label: 'Chainlink · no human' }, line: 'Every Chainlink node looks at YouTube on its own. They all agree: the video is live and has #ad.', next: 'Next: a short dispute window, then it pays on its own.', states: { c1: 'verified', c2: 'verified' }, money: [1000, 0, 0, 0, 0] },
  { title: 'Paying', who: { icon: 'coin', label: 'Contract · no human' }, line: '500 USDC paid to Freelancer, split on arrival: Freelancer 425 · manager 50 · editor 25.', next: 'Next: promise 03 starts paying daily.', states: { c1: 'paid', c2: 'paid' }, money: [500, 500, 0, 0, 0] },
  { title: 'Pays daily', who: { icon: 'clock', label: 'Chainlink checks every day' }, line: 'Day 12 of 30: the video is still public, so 10 USDC a day keeps flowing.', next: 'Next: what if the video goes private?', states: { c3: 'checking' }, money: [380, 620, 0, 0, 0] },
  { title: 'Breach', who: { icon: 'back', label: 'Contract · no human' }, line: 'The video went private on day 12. Payments stopped; the remaining 180 USDC went back to Client, exactly as the deal said.', next: 'Next: a disagreement about promise 04.', states: { c3: 'returned' }, money: [200, 620, 180, 0, 0] },
  { title: 'Dispute', who: { icon: 'b', label: 'Client disputed promise 04' }, line: 'Only this 200 USDC is frozen. Everything else keeps working.', next: 'Next: the AI jury reads the evidence.', states: { c4: 'frozen' }, money: [0, 620, 180, 200, 0] },
  { title: 'AI jury', who: { icon: 'gear', label: 'The jury · three AI models' }, line: 'The jury is three AI models. Each reads the evidence on its own. One cited an email that isn’t in the file, so its vote was thrown out. The jury recommends: pay Freelancer.', next: 'Next: a human arbitrator makes the final call.', states: { c4: 'frozen' }, money: [0, 620, 180, 200, 0] },
  { title: 'Arbitrator', who: { icon: 'person', label: 'Human arbitrator · final say' }, line: 'A World ID verified arbitrator with no stake in this deal signs in, reads the jury’s reasoning and the evidence, and decides: pay Freelancer. The contract moves the 200 USDC.', next: 'Deal settled. Every dollar reached someone.', states: { c4: 'paid' }, money: [0, 820, 180, 0, 0] },
]

/** Theatre money bar key, in the same order as TheatreScene.money */
export const MONEY_KEY: [string, string][] = [
  ['Locked', 'var(--ciel)'],
  ['Paid', 'var(--beige)'],
  ['Returned', 'var(--blue)'],
  ['Frozen', 'var(--orange)'],
  ['Not funded', 'rgba(26,26,26,.18)'],
]

/* ── Overview: a deal's life ── */
export const LIFE: LifeStage[] = [
  { key: 'Draft', bg: 'var(--beige)', fg: 'var(--ink)', text: 'Client writes up to five promises in plain words: what, by when, for how much. Each promise gets its own share of the fee.', who: 'Client', art: 'sheet' },
  { key: 'Checked', bg: 'var(--white)', fg: 'var(--ink)', text: 'Before any money moves, a safety check tries every path and proves each dollar can always reach someone. Chainlink certifies the result.', who: 'Settld check + Chainlink · automatic', art: 'scan' },
  { key: 'Locked', bg: 'var(--ciel)', fg: 'var(--ink)', text: 'The client’s payment sits in a neutral safe. No one can take it early, not even Settld. Every promise has its own locked lane.', who: 'Client funds · contract holds', art: 'safe' },
  { key: 'Delivered', bg: 'var(--orange)', fg: 'var(--ink)', text: 'Freelancer delivers the work and pastes the link: a post, a video, a website or a pull request. Chainlink nodes start checking it.', who: 'Freelancer', art: 'video' },
  { key: 'Verified', bg: 'var(--blue)', fg: 'var(--white)', text: 'Every Chainlink node checks the work on its own and must reach the same verdict. For judgement calls, three AI models vote and the majority wins.', who: 'Chainlink · no human', art: 'hex' },
  { key: 'Paid', bg: 'var(--ink)', fg: 'var(--white)', text: 'The short dispute window ends and that promise’s share reaches Freelancer, split the way both sides agreed. The other lanes stay locked until their promises are kept.', who: 'Contract · no human', art: 'paid' },
]

/** Example promises shown in the overview art (no amounts: every deal sets its own) */
export const LIFE_SHEET: [string, string][] = [
  ['01', 'Work delivered by the deadline'],
  ['02', 'Link or page shows what was asked'],
  ['03', 'Stays live for the agreed days'],
  ['04', 'Quality judged against the brief'],
]

/* ── New deal (NC) ── */
export const CHECKS: CheckInfo[] = [
  { check: 0, label: 'YouTube posted', hint: 'by a date', icon: 'play', color: 'var(--ciel)', paramLabel: 'Freelancer’s YouTube channel (@handle or link)', paramPlaceholder: '@yourchannel' },
  { check: 1, label: 'Description contains', hint: 'link, #ad, a tag', icon: 'hex', color: 'var(--blue)', paramLabel: 'Text to find', paramPlaceholder: '#ad' },
  { check: 4, label: 'Link is live', hint: 'any post, reel or site', icon: 'arrow', color: 'var(--ciel)', paramLabel: 'Note (optional)', paramPlaceholder: 'Landing page' },
  { check: 5, label: 'Page contains', hint: 'text on a web page', icon: 'hex', color: 'var(--blue)', paramLabel: 'Text to find', paramPlaceholder: 'Powered by Client' },
  { check: 6, label: 'GitHub PR merged', hint: 'code delivered', icon: 'check', color: 'var(--orange)', paramLabel: 'Repo (optional, owner/repo)', paramPlaceholder: 'client/website' },
  { check: 7, label: 'AI check', hint: '3 models vs the brief', icon: 'gear', color: 'var(--beige)', paramLabel: 'What the AI judges check', paramPlaceholder: 'Product clearly featured, positive tone' },
]

export const DRAFT: { creatorEmail: string; total: number; currency: string; promises: DraftPromise[] } = {
  creatorEmail: 'freelancer@example.com',
  total: 1000,
  currency: 'USDC',
  promises: [
    { check: 0, amount: 300, date: '2026-11-20', dep: '', fail: 'all' },
    { check: 1, amount: 200, date: '2026-11-20', param: '#ClientPartner', dep: '0', fail: 'all' },
    { check: 4, amount: 300, date: '2026-12-20', dep: '0', fail: 'rest' },
    { check: 7, amount: 200, date: '2026-11-25', param: 'Product clearly featured, positive tone', dep: '', fail: 'all' },
  ],
}

export const TEMPLATES: Record<string, DraftPromise[]> = {
  'YouTube video': DRAFT.promises.slice(0, 2).map((p, i) => ({ ...p, amount: [600, 400][i] })),
  'Instagram reel': [
    { check: 4, amount: 600, date: '2026-11-20', dep: '', fail: 'all' },
    { check: 7, amount: 400, date: '2026-11-20', param: 'Reel shows the product and tags the client', dep: '0', fail: 'all' },
  ],
  'Website build': [
    { check: 6, amount: 600, date: '2026-11-20', param: 'client/website', dep: '', fail: 'all' },
    { check: 5, amount: 400, date: '2026-11-30', param: 'Powered by Client', dep: '0', fail: 'rest' },
  ],
}

export const MAX_PROMISES = 5

/* ── Court: case 7 (promise 04 of deal 042) ──
   Same shape as GET /api/court/:caseId. Judges: 0 Groq (OpenAI gpt-oss), 1 Google Gemini, 2 NVIDIA Nemotron.
   Evidence bits in `cited`: 0 clause terms, 1 submitted evidence, 2 dispute reason. */
export const CASE_META = { caseId: '7', dealId: 'd1', promiseId: 'c4', amount: 200, appealFee: 20 }

export const JUDGES = [
  { name: 'GPT-oss', maker: 'OpenAI · via Groq', initial: 'O' },
  { name: 'Gemini', maker: 'Google', initial: 'G' },
  { name: 'Nemotron', maker: 'NVIDIA', initial: 'N' },
]

export const EVIDENCE_NAMES = ['The promise', 'The video', 'The complaint']

const words = (s: string) => s.trim().split(/\s+/).length
const turn = (band: Band, statement: string, cited: number[], wantsExtend = false, isFinal = false, prior = 0): JudgeTurn => ({
  band, statement, cited, wantsExtend, isFinal, wordsUsed: prior + words(statement),
})

// Each judge votes one way: 100 = Freelancer gets the whole clause, 0 = Client gets it all back.
const R0 = [
  turn(100, 'The product is on screen from 11:00 to 11:48 and named twice. The tone is upbeat. The promise looks kept.', [0, 1]),
  turn(100, 'The promise asks for the product to be clearly featured with a positive tone. The video does exactly that, with a close-up at 11:20.', [0, 1]),
  turn(0, 'The client says the product appears for under a minute in a 14 minute video. That is not clearly featured, so the client should get the money back.', [2]),
]
const R1 = [
  turn(100, 'Nemotron has a point about length, but the promise never set a minimum time. I still say pay the freelancer, and I would like room to weigh the close-up properly.', [0, 2], true, false, R0[0].wordsUsed),
  turn(100, 'The client expected more screen time, but that is not what the written promise says. Pay the freelancer. I ask for a little more room to answer the complaint fairly.', [1, 2], true, false, R0[1].wordsUsed),
  turn(0, 'I reread the video. The close-up is real, but the mention is brief. I still lean to a refund.', [1], false, false, R0[2].wordsUsed),
]
const R2 = [
  turn(100, 'Final: the product is clearly shown and praised, and the promise had no time limit. Pay the freelancer.', [0, 1], false, true, R1[0].wordsUsed),
  turn(100, 'Final: featured clearly, tone positive. The short screen time is a fair complaint but outside the written promise. Pay the freelancer.', [0, 1, 2], false, true, R1[1].wordsUsed),
  turn(0, 'Final: I still say refund the client. The majority may differ, and that is fine.', [1, 2], false, true, R1[2].wordsUsed),
]

export const COURT_TRANSCRIPT: CourtTranscript = {
  reason: 'The product is on screen for under a minute in a 14 minute video. That is not “clearly featured”.',
  terms: { clause: 4, check: 'AI check against the brief', param: 'Product clearly featured, positive tone', amount: 200 },
  evidence: 'youtube.com/watch?v=demo042',
  judges: JUDGES.map((j) => j.name),
  deadline0: 180,
  rounds: [
    { round: 0, extensionGranted: false, wordBudget: 200, deadline: 180, judges: R0 },
    { round: 1, extensionGranted: true, wordBudget: 300, deadline: 240, judges: R1 },
    { round: 2, extensionGranted: false, wordBudget: 300, deadline: 240, judges: R2 },
  ],
}

/** AICourt timing rules (seconds / words) */
export const COURT_RULES = { baseSecs: 180, hardCapSecs: 300, wordBudget: 200, extendWords: 100, extendSecs: 60 }

/** What the jury scene says when you click a seat, the bench, the clause or a party */
export const JURY_INFO: Record<string, string> = {
  'juror-1': 'GPT-oss (OpenAI) · final vote: pay Freelancer',
  'juror-2': 'Gemini (Google) · final vote: pay Freelancer',
  'juror-3': 'Nemotron (NVIDIA) · final vote: refund Client',
  arbiter: 'Human arbitrators · World ID verified · only if a party appeals',
  clause: 'Promise 04 · 200 USDC held until the case closes',
  brand: 'Client · opened the dispute',
  creator: 'Freelancer · delivered the video',
}

/* ── Arbitrators (GET /api/arbitrator/dashboard and /cases) ── */
export const ARB_DASHBOARD: ArbitratorDashboard = {
  wallet: '0x7c41…e09a',
  profile: { cases: 9, withMajority: 8, strikes: 1, suspended: false },
  totals: { casesTaken: 10, casesDecided: 9, rightCalls: 8, wrongCalls: 1, pending: 1, feesEarnedUnits: '46000000' },
  history: [
    { caseId: '6', dealId: '39', clauseId: 1, reason: 'Signup form on the landing page does not work.', myBand: 100, aiBand: 100, finalBand: 100, outcome: 'with_majority', feeEarnedUnits: '10000000' },
    { caseId: '5', dealId: '35', clauseId: 0, reason: 'GitHub PR merged but the build fails.', myBand: 0, aiBand: 0, finalBand: 0, outcome: 'with_majority', feeEarnedUnits: '6000000' },
    { caseId: '3', dealId: '28', clauseId: 2, reason: 'Reel was posted but deleted after a day.', myBand: 100, aiBand: 0, finalBand: 0, outcome: 'against_majority', feeEarnedUnits: '0' },
  ],
}

export const OPEN_CASES: OpenCase[] = [
  { caseId: '7', dealId: '42', clauseId: 3, reason: COURT_TRANSCRIPT.reason, aiBand: 100, commitDeadline: 0, revealDeadline: 0, seatsTaken: 1, reveals: 0, mySeat: false, canJoin: true, blockedReason: null },
]

export const ARB_POOL = { verified: 128, active: 41 }

/* ── Wallet (PAY) ── */
export const PAYMENTS: Payment[] = [
  { id: 'p1', when: 'Today 14:24', what: 'Clause 01 paid · Client × Freelancer · split 255 / 30 / 15', who: { icon: 'coin', label: 'The contract' }, amount: -300, kind: 'paid' },
  { id: 'p2', when: 'Today 14:12', what: 'Locked for “Client × Freelancer”', who: { icon: 'lock', label: 'The contract' }, amount: -1000, kind: 'locked' },
  { id: 'p3', when: 'Yesterday', what: 'Clause 2 paid · Freelancer B · split 85 / 10 / 5', who: { icon: 'coin', label: 'The contract' }, amount: 850, kind: 'received' },
  { id: 'p4', when: '2 Nov', what: 'Clause 1 returned · Freelancer C · video not found', who: { icon: 'hex', label: 'Chainlink' }, amount: 300, kind: 'returned' },
  { id: 'p5', when: '1 Nov', what: 'Test USDC added', who: { icon: 'plus', label: 'Test faucet' }, amount: 1000, kind: 'received' },
]

export const NOTIFICATIONS: Notification[] = [
  { icon: 'hex', text: 'Chainlink verified “Video posted” · 300 USDC released', at: '14:24' },
  { icon: 'play', text: 'Freelancer accepted the deal', at: '14:09' },
  { icon: 'b', text: 'Client disputed “Product featured”', at: '13:40' },
]

export const COIN_STACKS: CoinStack[] = [
  { id: 'd1', paid: 0, locked: 4, label: 'Freelancer', sub: '1,000 locked', filter: 'locked' },
  { id: 'd2', paid: 3, locked: 5, label: 'Freelancer B', sub: '850 in · 1,250 locked', filter: 'received' },
  { id: 'd3', paid: 1, locked: 3, label: 'Freelancer C', sub: '300 in · 750 locked', filter: 'returned' },
  { id: 'd4', paid: 4, locked: 0, label: 'Test USDC', sub: '1,000 in', filter: 'received' },
]

export const ACCOUNT = { address: '0x59b0c1…3cb3', network: 'Arc testnet', usdc: '0xa0b8…9e3c', inrRate: 83.33 }

/** Test faucet amount per click */
export const FAUCET_AMOUNT = 10
