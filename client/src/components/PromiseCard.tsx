import type { ReactNode } from 'react'
import { DAILY, WINDOW_LENGTH } from '../data/fixtures'
import type { ChipKind, DealPromise, IconName, PromiseState } from '../data/types'
import { fmt, mmss } from '../lib/format'
import { verdictShort } from '../lib/verdict'
import { Button, ButtonLink } from './Button'
import { Chip } from './Chip'
import { Icon } from './Icon'

const CHIP: Record<PromiseState, [ChipKind, IconName, string]> = {
  paid: ['paid', 'check', 'Paid'],
  verified: ['ver', 'check', 'Verified · releasing'],
  checking: ['check', 'clock', 'Paying daily'],
  frozen: ['froz', 'lock', 'Frozen · in court'],
  returned: ['ver', 'back', 'Returned to you'],
  locked: ['locked', 'lock', 'Locked'],
  failed: ['fail', 'cross', 'Failed'],
}

export type PromiseHandlers = {
  onRelease: (p: DealPromise) => void
  onDispute: (p: DealPromise) => void
  onBreach: (p: DealPromise) => void
  onSelect: (p: DealPromise) => void
  onAppeal?: (p: DealPromise) => void
  onAccept?: (p: DealPromise) => void
  /** court info for the disputed promise */
  court?: { aiBand: number | null; appealed: boolean; appealFee: number }
}

function Drip({ returned }: { returned?: boolean }) {
  return (
    <div className="drip" aria-label={`Day ${DAILY.day} of ${DAILY.days}`}>
      {Array.from({ length: DAILY.days }, (_, k) => (
        <i key={k} className={k < DAILY.day ? 'p' : returned ? 'r' : k === DAILY.day ? 'n' : ''} />
      ))}
    </div>
  )
}

/** One promise on the Deal page: number, status, amount bar, and the action it allows. */
export function PromiseCard({ p, selected, windowLeft, ...h }: { p: DealPromise; selected: boolean; windowLeft: number } & PromiseHandlers) {
  const [kind, icon, label] = CHIP[p.state]
  let act: ReactNode = null
  let vis: ReactNode = null
  if (p.state === 'verified') {
    act = (
      <>
        <Button size="sm" onClick={() => h.onRelease(p)}>
          <Icon name="coin" />
          Release {p.amount} now
        </Button>
        <Button size="sm" variant="sec" onClick={() => h.onDispute(p)}>
          Dispute
        </Button>
      </>
    )
    vis = (
      <div className="wring">
        <svg viewBox="0 0 44 44">
          <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(26,26,26,.12)" strokeWidth="5" />
          <circle cx="22" cy="22" r="18" fill="none" stroke="#2038E2" strokeWidth="5" strokeDasharray="113.1" strokeDashoffset={113.1 * (1 - windowLeft / WINDOW_LENGTH)} transform="rotate(-90 22 22)" />
        </svg>
        <span className="k">
          Dispute window closes in{' '}
          <b className="bit num" style={{ fontSize: 18 }}>
            {mmss(windowLeft)}
          </b>
          , then it pays on its own.
        </span>
      </div>
    )
  }
  if (p.state === 'paid') {
    act = (
      <ButtonLink size="sm" variant="sec" href="#wallet">
        View receipt
      </ButtonLink>
    )
    vis = p.split ? (
      <div className="split">
        {p.split.toFreelancer > 0 && <Chip kind="paid" icon="gear">Court · Freelancer gets {p.split.toFreelancer}</Chip>}
        {p.split.toClient > 0 && <Chip kind="ver" icon="back">Client gets {p.split.toClient} back</Chip>}
      </div>
    ) : (
      <div className="split">
        <Chip kind="paid">Freelancer {Math.round(p.amount * 0.85)}</Chip>
        <Chip kind="pend">Manager {Math.round(p.amount * 0.1)}</Chip>
        <Chip kind="pend">Editor {Math.round(p.amount * 0.05)}</Chip>
      </div>
    )
  }
  if (p.state === 'checking') {
    act = (
      <Button size="sm" variant="sec" onClick={() => h.onBreach(p)}>
        Simulate: video goes private
      </Button>
    )
    vis = (
      <div className="grid" style={{ gap: 6 }}>
        <Drip />
        <span className="k mut">Day 12 of 30 · 10 USDC a day while it stays public · Chainlink checks daily</span>
      </div>
    )
  }
  if (p.state === 'frozen') {
    const c = h.court
    const canAppeal = c && c.aiBand !== null && !c.appealed
    act = (
      <>
        <ButtonLink size="sm" variant={canAppeal ? 'sec' : 'primary'} href="#timeline">
          Watch the AI judges <Icon name="arrow" />
        </ButtonLink>
        {canAppeal && (
          <>
            <Button size="sm" onClick={() => h.onAppeal?.(p)}>Appeal · {c.appealFee} USDC</Button>
            <Button size="sm" variant="sec" onClick={() => h.onAccept?.(p)}>Accept verdict</Button>
          </>
        )}
      </>
    )
    vis = (
      <>
        <div className="k" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {c?.aiBand !== null && c?.aiBand !== undefined ? (
            <Chip kind="ver" icon="gear">AI verdict · {verdictShort(c.aiBand)}</Chip>
          ) : (
            <Chip kind="check" icon="gear">AI judges discussing</Chip>
          )}
          {c?.appealed && <Chip kind="need" icon="person">Appealed · human arbitrators deciding</Chip>}
        </div>
        <span className="k mut">
          {c?.appealed
            ? 'Three World ID verified arbitrators seal their votes, then reveal. The majority decides.'
            : `Only this ${p.amount} USDC is on hold. Don’t agree with the AI? Either side can appeal to human arbitrators for 10%.`}
        </span>
      </>
    )
  }
  if (p.state === 'returned') {
    act = (
      <ButtonLink size="sm" variant="sec" href="#wallet">
        View receipt
      </ButtonLink>
    )
    vis =
      p.id === DAILY.promiseId ? (
        <div className="grid" style={{ gap: 6 }}>
          <Drip returned />
          <span className="k mut">12 days paid · 18 days returned to you</span>
        </div>
      ) : null
  }
  const pct = p.state === 'checking' ? 40 : p.state === 'paid' ? 100 : p.state === 'returned' && p.id === DAILY.promiseId ? 40 : 0
  const rest = p.state === 'frozen' ? 'var(--orange)' : p.state === 'returned' ? 'var(--blue)' : 'var(--ciel)'

  return (
    <article
      className={`clause st-${p.state}${selected ? ' sel' : ''}`}
      id={`cl-${p.id}`}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('button,a')) h.onSelect(p)
      }}
    >
      <div className="cn" aria-hidden="true">{p.n}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip kind={kind} icon={icon}>{label}</Chip>
          <span className="k mut">{p.kind}</span>
        </div>
        <h3>{p.title}</h3>
        {vis}
      </div>
      <div className="cv" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="num amt">
          {fmt(p.amount)} <span className="k mut">USDC</span>
        </span>
        <div className="bar8" style={{ height: 8 }}>
          <i style={{ flex: pct, background: 'var(--ink)' }} />
          <i style={{ flex: 100 - pct, background: rest }} />
        </div>
        <span className="k mut">{p.note}</span>
      </div>
      <div className="acts">{act}</div>
    </article>
  )
}
