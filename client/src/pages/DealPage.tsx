import { useEffect, useRef, useState } from 'react'
import { Card } from '../components/Card'
import LiveDealView from './LiveDealView'
import { CountUp } from '../components/CountUp'
import { Chip } from '../components/Chip'
import { Eyebrow } from '../components/Eyebrow'
import { Feed } from '../components/Feed'
import { Icon } from '../components/Icon'
import { MoneyBar } from '../components/MoneyBar'
import { PromiseCard } from '../components/PromiseCard'
import { StatTile } from '../components/StatTile'
import { useFlow } from '../components/flow/context'
import { CASE_META, WINDOW_LENGTH } from '../data/fixtures'
import { api, units, useLive } from '../data/live'
import { acceptAiVerdict, appealCase, breachPromise, dealSums, disputePromise, nextPayout, releasePromise, useSettld } from '../data/store'
import type { DealPromise, PromiseState } from '../data/types'
import { fmt, mmss } from '../lib/format'
import { smoothScrollTo } from '../app/smoothScroll'
import { verdictLong } from '../lib/verdict'
import Settld3D from '../three/settld3d'
import type { VaultController } from '../three/settld3d'
import { useScene } from '../three/useScene'
import { getState } from '../data/store'

const LABELS: Record<string, string> = { c1: '300 · video posted', c2: '200 · link + #ad', c3: '300 · stays public', c4: '200 · product shown' }
const settledLike = (s: PromiseState) => s === 'paid' || s === 'returned'

export default function DealPage() {
  const live = useSettld((s) => s.session.live)
  return live ? <LiveDealView /> : <DemoDealPage />
}

function DemoDealPage() {
  const { flow, toast } = useFlow()
  const deal = useSettld((s) => s.deal)
  const feed = useSettld((s) => s.feed)
  const windowLeft = useSettld((s) => s.windowLeft)
  const court = useSettld((s) => s.court)
  const status = useLive(() => api.courtStatus(CASE_META.caseId))
  const appealFee = status ? units(status.data.appealFeeUnits) : CASE_META.appealFee
  const np = useSettld(nextPayoutStable)
  const [sel, setSel] = useState('c2')
  const cv = useRef<HTMLCanvasElement>(null)
  const labels = useRef<HTMLDivElement>(null)

  const scene = useScene<VaultController>(cv, (c) => {
    const ps = getState().deal.promises
    const v = Settld3D.vault(c, {
      clauses: ps.map((p) => ({ id: p.id, amount: p.amount / 50, state: settledLike(p.state) ? 'locked' : p.state, progress: 0.6 })),
      chipsPerUnit: 1,
      labels: labels.current,
      camR: window.innerWidth < 700 ? 6.2 : 4.3,
      camY: 0.45,
      onPick: (id) => {
        if (id && id[0] === 'c') {
          setSel(id)
          const el = document.getElementById(`cl-${id}`)
          if (el) smoothScrollTo(el, { offset: -(window.innerHeight / 3) })
        }
      },
    })
    // paid and returned lanes animate out shortly after load, as in the design
    setTimeout(() => v.setClauses(ps.filter((p) => settledLike(p.state)).map((p) => ({ id: p.id, state: p.state }))), 700)
    return v
  })

  // tell the vault about state changes made while this page is open
  const prev = useRef(deal.promises)
  useEffect(() => {
    const changed = deal.promises.filter((p) => prev.current.find((q) => q.id === p.id)?.state !== p.state)
    prev.current = deal.promises
    if (changed.length) scene.current?.setClauses(changed.map((p) => ({ id: p.id, state: p.state })))
  }, [deal.promises, scene])

  const S = dealSums(deal)
  const M = [
    { label: 'Paid to Freelancer', value: S.paid, color: 'var(--beige)', icon: 'coin' as const },
    { label: 'Still locked', value: S.locked, color: 'var(--ciel)', icon: 'lock' as const },
    { label: 'Frozen in court', value: S.frozen, color: 'var(--orange)', icon: 'bang' as const },
    { label: 'Returned to you', value: S.returned, color: 'var(--blue)', icon: 'back' as const },
  ]
  const settled = deal.promises.every((c) => settledLike(c.state))
  const timeline = [...deal.timeline, { label: 'Settled', at: settled ? 'now' : 'when every promise ends', done: settled }]

  const release = (c: DealPromise) =>
    flow({
      kicker: 'Release · anyone can trigger',
      title: `Release ${c.amount} USDC to Freelancer`,
      summary: (
        <>
          Clause {c.n} was verified by Chainlink. This moves <b>{c.amount} USDC</b> to Freelancer, split as this deal says (85 / 10 / 5).
        </>
      ),
      cta: 'Release now',
      working: `Releasing ${c.amount} USDC`,
      steps: ['Checking the dispute window', 'Sending to Freelancer · splitting 85 / 10 / 5', 'Waiting for the public record'],
      run: () => releasePromise(c.id),
      done: `${c.amount} USDC paid to Freelancer.`,
      next: `Freelancer ${Math.round(c.amount * 0.85)} · manager ${Math.round(c.amount * 0.1)} · editor ${Math.round(c.amount * 0.05)}.`,
    })

  const dispute = (c: DealPromise) =>
    flow({
      kicker: 'Dispute · window open',
      title: `Dispute clause ${c.n}`,
      summary: (
        <>
          This freezes only <b>{c.amount} USDC</b> for clause {c.n}. Three AI judges read the evidence and decide. Either side can appeal to verified human arbitrators. Everything else keeps paying.
        </>
      ),
      fields: [{ id: 'why', label: 'What’s wrong, in one line', placeholder: 'For example: the #ad tag is missing' }],
      validate: (v) => (v.why.trim() ? null : 'why'),
      cta: 'Open dispute · PIN',
      pin: true,
      working: 'Opening the dispute',
      steps: [`Freezing ${c.amount} USDC`, 'Sending the evidence file to the AI judges', 'Opening the courtroom'],
      run: (v) => disputePromise(c.id, v.why),
      done: `Clause ${c.n} is frozen and in court.`,
      next: 'The judges usually decide within five minutes. You’ll be notified.',
      receipt: false,
    })

  // the fee is read from AICourt.appealFee(caseId) via /api/court/:id/status when live
  const appeal = (c: DealPromise) =>
    flow({
      kicker: `Appeal · case ${CASE_META.caseId}`,
      title: `Appeal promise ${c.n} to human arbitrators`,
      summary: (
        <>
          The AI judges decided: {verdictLong(court.aiBand ?? 100, c.amount).toLowerCase()}. Appealing costs <b>{appealFee} USDC</b> (10% of the disputed amount). Three World ID verified humans with no stake in this deal then decide, and their majority is final.
        </>
      ),
      cta: `Approve ${appealFee} USDC & appeal · PIN`,
      pin: true,
      working: 'Sending the case to human arbitrators',
      steps: [`Approving the ${appealFee} USDC fee`, 'Appealing on the court contract', 'Opening a panel of three seats'],
      run: () => appealCase(),
      done: 'Appealed. Human arbitrators are now deciding.',
      next: 'Follow it on your Timeline. The fee is shared among the arbitrators who vote with the majority.',
    })

  const breach = (c: DealPromise) => {
    breachPromise(c.id)
    toast(
      <>
        <Icon name="back" /> Video went private. Payments stopped; 180 USDC came back to you.
      </>,
    )
  }

  return (
    <section className="view on">
      <div className="ground gut">
        <div className="wrap">
          <div className="deal-hero">
            <div className="dh-row">
              <Eyebrow>Deal {deal.number} · you are the client</Eyebrow>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Chip kind="ver" icon="check">Funded · delivering</Chip>
                <Chip style={{ background: 'rgba(255,255,255,.14)', color: 'var(--white)' }}>
                  <span className="dot live" style={{ background: 'var(--orange)', borderRadius: '50%' }} />
                  Freelancer is viewing now
                </Chip>
              </div>
            </div>
            <div className="parties">
              <div className="party">
                <span className="pav" style={{ background: 'var(--white)', color: 'var(--ink)' }}><Icon name="b" /></span>
                <div>
                  <div className="bit pn">Client</div>
                  <div className="k" style={{ color: 'var(--beige)' }}>You · put in {deal.total.toLocaleString('en-US')} USDC</div>
                </div>
              </div>
              <div className="pline" aria-hidden="true">
                <span className="pcoin" />
                <span className="pcoin" style={{ animationDelay: '-1.3s' }} />
                <span className="pcoin" style={{ animationDelay: '-2.6s' }} />
                <span className="ptag bit">{deal.total.toLocaleString('en-US')} USDC · {deal.promises.length} promises</span>
              </div>
              <div className="party r">
                <div style={{ textAlign: 'right' }}>
                  <div className="bit pn">Freelancer</div>
                  <div className="k" style={{ color: 'var(--beige)' }}>Gets paid promise by promise</div>
                </div>
                <span className="pav" style={{ background: 'var(--orange)', color: 'var(--ink)' }}><Icon name="play" /></span>
              </div>
            </div>
            <div className="stats">
              {M.map((m) => (
                <StatTile key={m.label} label={m.label} icon={m.icon} color={m.color}><CountUp value={m.value} format={fmt} /></StatTile>
              ))}
              <StatTile hot color="var(--ink)" icon="clock" label={np ? `Next payout · clause ${np.n}` : 'Next payout'}>
                <span className="bit num" style={{ fontSize: '1.15em' }}>{np ? mmss(windowLeft) : '·'}</span>{' '}
                <span style={{ fontSize: 14 }}>{np ? `${np.amount} USDC` : 'nothing due'}</span>
              </StatTile>
            </div>
            <MoneyBar big segments={M} />
          </div>

          <div className="deal-top">
            <div className="stage3d" style={{ minHeight: 420 }}>
              <canvas ref={cv} role="img" aria-label="Deal vault in 3D, one lane of coins per promise." />
              <div className="lbls" ref={labels}>
                {deal.promises.map((p) => (
                  <div key={p.id} className={`v3l${sel === p.id ? ' on' : ''}`} data-l={p.id}>
                    <span className="v3p"><b>{p.n}</b>{LABELS[p.id] ?? `${p.amount}`}</span>
                  </div>
                ))}
                <div className="v3l" data-l="brand"><span className="v3t"><b>Client</b><br />you</span></div>
                <div className="v3l" data-l="creator"><span className="v3t"><b>Freelancer</b><br />split as agreed</span></div>
              </div>
              <div style={{ position: 'absolute', left: 14, top: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="bit" style={{ fontSize: 16 }}>Deal vault</span>
                <span className="legend">
                  <span><i style={{ background: '#007BFF' }} />Locked</span>
                  <span><i style={{ background: '#FF5A00' }} />Checking / frozen</span>
                  <span><i style={{ background: '#2038E2', boxShadow: 'inset 0 0 0 1px #FFE6D0' }} />Verified</span>
                  <span><i style={{ background: '#FFE6D0' }} />Paid</span>
                </span>
              </div>
              <div className="hint">Drag to turn · click a lane to jump to its promise</div>
            </div>
            <Card className="next-card">
              <div className="bit" style={{ fontSize: 16, color: 'var(--ink-62)' }}>Next payout</div>
              <svg className="bigring" viewBox="0 0 120 120" aria-hidden="true">
                <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(26,26,26,.12)" strokeWidth="10" />
                <circle cx="60" cy="60" r="52" fill="none" stroke="#2038E2" strokeWidth="10" strokeDasharray="326.7" strokeDashoffset={np ? 326.7 * (1 - windowLeft / WINDOW_LENGTH) : 326.7} transform="rotate(-90 60 60)" />
              </svg>
              <div className="nr-in">
                <div className="bit num" style={{ fontSize: 44, lineHeight: 1 }}>{np ? mmss(windowLeft) : 'Done'}</div>
                <div className="k mut">{np ? `${np.amount} USDC · clause ${np.n}` : 'No payout waiting'}</div>
              </div>
              <p style={{ fontSize: 15 }}>
                {np
                  ? 'When the dispute window closes, the contract pays Freelancer on its own. You don’t need to do anything.'
                  : deal.promises.some((c) => c.state === 'frozen')
                    ? 'Clause 03 keeps paying daily. Clause 04 waits for the court. You don’t need to do anything.'
                    : 'Nothing is waiting on you. Clause 03 keeps paying daily while the video stays public.'}
              </p>
              <ol className="tl">
                {timeline.map((x) => (
                  <li key={x.label} className={x.done ? '' : 'todo'}>
                    <span className={`tsq ${x.done ? 'c-ver' : 'c-pend'}`}>{x.done && <Icon name="check" />}</span>
                    <span>{x.label}</span>
                    <span className="t num">{x.at}</span>
                  </li>
                ))}
              </ol>
            </Card>
          </div>

          <div className="deal-grid">
            <div className="grid" style={{ alignContent: 'start', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                <h2 style={{ fontSize: 30 }}>The four promises</h2>
                <span className="k" style={{ color: 'var(--beige)' }}>Each one has its own money and pays on its own.</span>
              </div>
              <div className="grid" style={{ gap: 12 }}>
                {deal.promises.map((p) => (
                  <PromiseCard
                    key={p.id}
                    p={p}
                    selected={sel === p.id}
                    windowLeft={windowLeft}
                    onRelease={release}
                    onDispute={dispute}
                    onBreach={breach}
                    onSelect={(x) => setSel(x.id)}
                    onAppeal={appeal}
                    onAccept={() => acceptAiVerdict()}
                    court={p.id === CASE_META.promiseId ? { aiBand: court.aiBand, appealed: court.appealed, appealFee: CASE_META.appealFee } : undefined}
                  />
                ))}
              </div>
            </div>
            <div className="grid" style={{ alignContent: 'start' }}>
              <Card tone="dark" className="grid" style={{ gap: 12 }}>
                <div className="bit" style={{ fontSize: 18 }}>Payout split</div>
                <div className="split-bar">
                  {deal.split.map((s, i) => (
                    <i key={s.who} style={{ flex: s.pct, background: ['var(--beige)', 'var(--orange)', 'var(--ciel)'][i] }} />
                  ))}
                </div>
                <div className="grid" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 8, fontSize: 13 }}>
                  {deal.split.map((s) => (
                    <div key={s.who}>
                      <div style={{ color: 'var(--beige-70)' }}>{s.who === 'Creator' ? 'Freelancer' : s.who}</div>
                      <div className="num" style={{ fontSize: 20 }}>{s.pct}%</div>
                    </div>
                  ))}
                </div>
                <div className="k" style={{ color: 'var(--beige-70)' }}>Every payout is split the moment it lands. Terms are locked; nobody, not even Settld, can change them.</div>
              </Card>
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ fontSize: 20 }}>Activity</h3>
                  <span className="k mut">newest first</span>
                </div>
                <Feed events={feed} />
              </Card>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// stable selector: returns the verified promise object itself (or null)
function nextPayoutStable(s: Parameters<typeof nextPayout>[0]) {
  return nextPayout(s)?.promise ?? null
}
