import { useCallback, useEffect, useState } from 'react'
import { Button, ButtonLink } from '../components/Button'
import { Card } from '../components/Card'
import { Certificate } from '../components/Certificate'
import { Chip } from '../components/Chip'
import { Eyebrow } from '../components/Eyebrow'
import { Icon } from '../components/Icon'
import { StatTile } from '../components/StatTile'
import { useFlow } from '../components/flow/context'
import {
  acceptLiveDeal, appealCase, caseStatus, disputeClause, fetchMyDeals, fundLiveDeal, progressOf, short, STATUS, submitWork,
  type CaseStatus, type LiveClause, type LiveDeal,
} from '../data/liveDeals'
import { refreshBalance, selectDeal, setLiveDeals, useSettld } from '../data/store'
import { getState } from '../data/store'
import type { ChipKind, IconName } from '../data/types'
import { checkDeal, CHECK_NAME } from '../../../shared/checker'
import { fmt, mmss } from '../lib/format'
import { verdictShort } from '../lib/verdict'

const CHIP: Record<number, [ChipKind, IconName, string]> = {
  0: ['locked', 'lock', 'Waiting for the work'],
  1: ['check', 'hex', 'Chainlink checking…'],
  2: ['ver', 'check', 'Verified'],
  3: ['fail', 'cross', 'Check failed'],
  4: ['froz', 'gear', 'In court'],
  5: ['paid', 'coin', 'Released'],
  6: ['ver', 'back', 'Refunded'],
  7: ['fail', 'cross', 'Broken'],
}

/** seconds until a unix time (never below 0) */
const left = (unix: string, now: number) => Math.max(0, Number(unix) - Math.floor(now / 1000))

function ClauseCard({ d, c, i, now, reload }: { d: LiveDeal; c: LiveClause; i: number; now: number; reload: () => void }) {
  const { flow } = useFlow()
  const [evidence, setEvidence] = useState('')
  const [court, setCourt] = useState<CaseStatus | null>(null)
  const [kind, icon, label] = CHIP[c.status] ?? ['pend', 'clock', STATUS[c.status] ?? 'Unknown']
  const inWindow = (c.status === 2 || c.status === 3) && left(c.disputeWindowEnd, now) > 0
  const caseId = c.caseId !== '0' ? c.caseId : null

  useEffect(() => {
    if (!caseId) return
    let alive = true
    const load = () => caseStatus(caseId).then((s) => alive && setCourt(s)).catch(() => {})
    load()
    const tm = setInterval(load, 10000)
    return () => {
      alive = false
      clearInterval(tm)
    }
  }, [caseId])

  const submit = () => {
    if (!evidence.trim()) {
      document.getElementById(`ev-${i}`)?.focus()
      return
    }
    flow({
      kicker: `Promise C${i}`, title: 'Submit your work',
      summary: <>Chainlink checks this link with “{CHECK_NAME[c.checkType] ?? 'its check'}”. If it passes, it pays out after a short window.</>,
      cta: 'Submit · PIN', pin: true, receipt: false,
      working: 'Submitting your work', steps: ['Approve with your PIN', 'Recording it on Arc', 'Chainlink starts checking'],
      run: () => submitWork(d.dealId, i, evidence), done: 'Submitted. Chainlink is checking it.', after: reload,
    })
  }
  const dispute = () =>
    flow({
      kicker: `Promise C${i} · window open`, title: `Dispute promise C${i}`,
      summary: <>This holds only <b>{fmt(Number(c.amount))} USDC</b>. Three AI judges read the promise, the work and your reason; the majority decides who gets it. Either side can then appeal to human arbitrators.</>,
      fields: [{ id: 'why', label: 'What’s wrong, in one line', placeholder: 'For example: the #ad tag is missing' }],
      validate: (v) => (v.why.trim() ? null : 'why'),
      cta: 'Open dispute · PIN', pin: true, receipt: false,
      working: 'Opening the dispute', steps: ['Approve with your PIN', 'Freezing this promise', 'The AI judges start'],
      run: (v) => disputeClause(d.dealId, i, v.why), done: `Promise C${i} is in court.`, next: 'Follow the judges on your Timeline.', after: reload,
    })
  const appeal = () => {
    if (!court || !caseId) return
    const fee = Number(court.appealFeeUnits) / 1e6
    flow({
      kicker: `Appeal · case ${caseId}`, title: 'Appeal to human arbitrators',
      summary: <>The AI judges decided: {verdictShort(court.aiVerdict ?? 0).toLowerCase()}. Appealing costs <b>{fmt(fee)} USDC</b>. Three World ID verified humans with no stake in this deal decide, and their majority is final.</>,
      cta: `Approve ${fmt(fee)} USDC & appeal · PIN`, pin: true,
      working: 'Sending the case to human arbitrators', steps: ['Approve the fee with your PIN', 'Appeal with your PIN', 'A panel of three opens'],
      run: () => appealCase(caseId), done: 'Appealed. Human arbitrators are deciding.', after: () => { reload(); void refreshBalance() },
    })
  }

  const isFreelancer = d.role === 'freelancer'
  const due = new Date(Number(c.deadline) * 1000)
  return (
    <article className={`clause st-${c.status === 5 ? 'paid' : c.status === 4 ? 'frozen' : c.status === 6 ? 'returned' : c.status === 2 ? 'verified' : c.status === 1 ? 'checking' : 'locked'}${c.status === 3 ? ' fail' : ''}`}>
      <div className="cn" aria-hidden="true">C{i}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip kind={kind} icon={icon}>{label}</Chip>
          <span className="k mut">{CHECK_NAME[c.checkType] ?? `Check ${c.checkType}`}</span>
        </div>
        <h3>{c.param || CHECK_NAME[c.checkType] || 'Promise'}</h3>
        <span className="k mut">Due {due.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}{c.dependsOn !== 255 ? ` · only pays after C${c.dependsOn}` : ''}</span>
        {(c.status === 2 || c.status === 3) && (
          <span className="k">
            {inWindow ? <>{c.status === 2 ? 'Pays out' : 'Refunds'} in <b className="bit num" style={{ fontSize: 18 }}>{mmss(left(c.disputeWindowEnd, now))}</b> unless someone disputes it. Nobody needs to click: the keeper settles it.</> : 'Window closed. The keeper settles it on its own.'}
          </span>
        )}
        {c.status === 4 && court && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {court.aiVerdict !== null ? <Chip kind="ver" icon="gear">AI verdict · {verdictShort(court.aiVerdict)}</Chip> : <Chip kind="check" icon="gear">AI judges discussing</Chip>}
            {court.appealed && <Chip kind="need" icon="person">Appealed · arbitrators deciding</Chip>}
          </div>
        )}
        {isFreelancer && d.funded && c.status === 0 && (
          <div className="grid" style={{ gap: 6 }}>
            <label className="f" htmlFor={`ev-${i}`}>Link to your work (post, reel, video, website, GitHub PR) or a screenshot’s IPFS id</label>
            <input id={`ev-${i}`} className="in" placeholder="https://…" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
            <span className="k mut">Instagram reels and stories can’t be fetched: add the link and a screenshot’s IPFS id.</span>
          </div>
        )}
      </div>
      <div className="cv" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="num amt">{fmt(Number(c.amount))} <span className="k mut">USDC</span></span>
      </div>
      <div className="acts">
        {isFreelancer && d.funded && c.status === 0 && <Button size="sm" onClick={submit}><Icon name="arrow" />Submit work · PIN</Button>}
        {inWindow && <Button size="sm" variant="sec" onClick={dispute}>Dispute</Button>}
        {c.status === 4 && <ButtonLink size="sm" variant="sec" href="#timeline">Watch the AI judges</ButtonLink>}
        {c.status === 4 && court?.canAppeal && <Button size="sm" onClick={appeal}>Appeal · {fmt(Number(court.appealFeeUnits) / 1e6)} USDC</Button>}
      </div>
    </article>
  )
}

/** One-line state of a deal for the switcher, and whether it is waiting on you. */
function railState(x: LiveDeal): { label: string; needsYou: boolean } {
  if (!x.accepted) return { label: 'Proposed', needsYou: x.role === 'freelancer' }
  if (!x.certified) return { label: 'Certifying', needsYou: false }
  if (!x.funded) return { label: 'To fund', needsYou: x.role === 'client' }
  if (x.clauses.some((c) => c.status === 4)) return { label: 'In court', needsYou: false }
  if (x.clauses.every((c) => c.status >= 5)) return { label: 'Settled', needsYou: false }
  return { label: 'Delivering', needsYou: x.role === 'freelancer' && x.clauses.some((c) => c.status === 0) }
}

/** Every deal as a card you can click, newest first; the open one is highlighted. */
function DealRail({ deals, current }: { deals: LiveDeal[]; current: string }) {
  const sorted = [...deals].sort((a, b) => Number(b.dealId) - Number(a.dealId))
  const need = sorted.filter((x) => railState(x).needsYou).length
  useEffect(() => {
    document.getElementById(`dr-${current}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [current])
  return (
    <nav className="deal-rail-wrap" aria-label="Your deals">
      <div className="dr-head">
        <span className="bit">Your deals · {deals.length}</span>
        {need > 0 && <span className="k dr-need-note"><i className="dr-dot" aria-hidden="true" />{need} waiting on you</span>}
      </div>
      <div className="deal-rail">
        {sorted.map((x) => {
          const s = railState(x)
          return (
            <button key={x.dealId} id={`dr-${x.dealId}`} type="button" className="dr" aria-current={x.dealId === current ? 'true' : undefined} onClick={() => selectDeal(x.dealId)}>
              <span className="dn">Deal {x.dealId}{s.needsYou && <i className="dr-dot" aria-label="needs you" />}</span>
              <span className="dm">{fmt(Number(x.total))} USDC · {x.role === 'client' ? 'you pay' : 'you deliver'}</span>
              <span className="ds">{s.label}</span>
            </button>
          )
        })}
        <a className="dr dr-new" href="#new"><Icon name="plus" /><span>New deal</span></a>
      </div>
    </nav>
  )
}

export default function LiveDealView() {
  const { flow } = useFlow()
  const deals = useSettld((s) => s.liveDeals)
  const selected = useSettld((s) => s.selectedDealId)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const reload = useCallback(() => {
    fetchMyDeals().then((d) => { setLiveDeals(d); setError(null) }).catch((e) => setError((e as Error).message))
  }, [])
  useEffect(() => {
    reload()
    const a = setInterval(reload, 10000)
    const b = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(a)
      clearInterval(b)
    }
  }, [reload])

  if (!deals) return <section className="view on"><div className="ground gut"><div className="wrap"><p className="k" style={{ color: 'var(--beige)' }}>{error ?? 'Loading your deals from Arc…'}</p></div></div></section>
  const d = deals.find((x) => x.dealId === selected) ?? deals[0]
  if (!d)
    return (
      <section className="view on">
        <div className="ground gut">
          <div className="wrap">
            <div className="page-head"><div className="grid" style={{ gap: 12 }}><Eyebrow>Deal</Eyebrow><h1>No deals yet.</h1></div></div>
            <Card className="grid" style={{ gap: 12, maxWidth: 560 }}>
              <p>When a client proposes a deal to your wallet, or you propose one, it shows here.</p>
              <div className="btn-row"><ButtonLink href="#new"><Icon name="plus" />Write a deal</ButtonLink></div>
            </Card>
          </div>
        </div>
      </section>
    )

  const p = progressOf(d)
  const refunded = d.clauses.filter((c) => c.status === 6).reduce((a, c) => a + Number(c.amount), 0)
  const cert = checkDeal(d.clauses.map((c) => ({ kind: c.checkType === 7 ? 2 : 0, checkType: c.checkType, param: c.param, deadline: BigInt(c.deadline), amount: BigInt(Math.round(Number(c.amount) * 1e6)), dependsOn: c.dependsOn, onFail: c.onFail, vestDays: 0 })), BigInt(Math.round(Number(d.total) * 1e6)))
  const stage = !d.accepted ? 'Proposed · waiting for the freelancer' : !d.certified ? 'Accepted · Chainlink certifying' : !d.funded ? 'Certified · waiting for funding' : 'Funded · delivering'

  const accept = () => flow({ title: `Accept deal ${d.dealId}`, summary: `You agree to ${d.clauses.length} promises worth ${fmt(Number(d.total))} USDC. Check the certificate below first. Nothing is locked until the client funds it.`, cta: 'Accept · PIN', pin: true, working: 'Accepting the deal', steps: ['Approve with your PIN', 'Recording it on Arc', 'Chainlink certifies the deal'], run: () => acceptLiveDeal(d), done: 'Deal accepted.', next: 'Chainlink certifies it on its own; then the client can fund it.', after: reload })
  const fund = () => flow({ title: `Lock ${fmt(Number(d.total))} USDC for deal ${d.dealId}`, summary: 'Two PIN prompts: one lets the safe take the USDC, one locks it. Unpaid promises always come back to you.', cta: 'Confirm & lock', pin: true, working: 'Locking the USDC', steps: ['Allowing the safe to use your USDC', 'Locking the USDC in the safe', 'Waiting for the public record'], run: () => fundLiveDeal(d, getState().balance), done: `${fmt(Number(d.total))} USDC locked.`, after: () => { reload(); void refreshBalance() } })

  return (
    <section className="view on">
      <div className="ground gut">
        <div className="wrap">
          {deals.length > 1 && <DealRail deals={deals} current={d.dealId} />}
          <div className="deal-hero">
            <div className="dh-row">
              <Eyebrow>Deal {d.dealId} · you are the {d.role}</Eyebrow>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Chip kind={d.funded ? 'ver' : 'pend'} icon={d.funded ? 'check' : 'clock'}>{stage}</Chip>
              </div>
            </div>
            <div className="parties">
              <div className="party">
                <span className="pav" style={{ background: 'var(--white)', color: 'var(--ink)' }}><Icon name="b" /></span>
                <div><div className="bit pn">Client</div><div className="k" style={{ color: 'var(--beige)' }}>{d.role === 'client' ? 'You' : short(d.client)} · put in {fmt(Number(d.total))} USDC</div></div>
              </div>
              <div className="pline" aria-hidden="true"><span className="pcoin" /><span className="ptag bit">{fmt(Number(d.total))} USDC · {d.clauses.length} promises</span></div>
              <div className="party r">
                <div style={{ textAlign: 'right' }}><div className="bit pn">Freelancer</div><div className="k" style={{ color: 'var(--beige)' }}>{d.role === 'freelancer' ? 'You' : short(d.freelancer)}</div></div>
                <span className="pav" style={{ background: 'var(--orange)', color: 'var(--ink)' }}><Icon name="play" /></span>
              </div>
            </div>
            <div className="stats">
              <StatTile label="Paid to Freelancer" icon="coin" color="var(--beige)">{fmt(p[0])}</StatTile>
              <StatTile label="Still locked" icon="lock" color="var(--ciel)">{fmt(p[4] + p[1] + p[2])}</StatTile>
              <StatTile label="In court" icon="bang" color="var(--orange)">{fmt(p[3])}</StatTile>
              <StatTile label="Refunded to Client" icon="back" color="var(--blue)">{fmt(refunded)}</StatTile>
              <StatTile hot label="Next step" icon="clock" color="var(--ink)"><span style={{ fontSize: 16 }}>{!d.accepted ? (d.role === 'freelancer' ? 'You accept' : 'Freelancer accepts') : !d.funded ? (d.role === 'client' ? 'You fund it' : 'Client funds it') : 'Delivery'}</span></StatTile>
            </div>
          </div>

          <div className="deal-grid">
            <div className="grid" style={{ alignContent: 'start', gap: 12 }}>
              {d.role === 'freelancer' && !d.accepted && <div className="btn-row"><Button onClick={accept}>Accept deal · PIN</Button></div>}
              {d.role === 'client' && d.accepted && d.certified && !d.funded && <div className="btn-row"><Button onClick={fund}>Fund {fmt(Number(d.total))} USDC</Button></div>}
              <h2 style={{ fontSize: 30, color: 'var(--white)' }}>The promises</h2>
              {d.clauses.map((c, i) => <ClauseCard key={i} d={d} c={c} i={i} now={now} reload={reload} />)}
            </div>
            <div className="grid" style={{ alignContent: 'start' }}>
              <Card className="grid" style={{ gap: 12 }}>
                <h3 style={{ fontSize: 20 }}>No deadlock certificate</h3>
                <Certificate result={cert} certifiedTx={d.certified ? 'onchain' : undefined} />
                {d.certified && <span className="k mut">Chainlink recorded this certificate on Arc before the deal was funded.</span>}
              </Card>
              {error && <Card><p className="k" style={{ color: 'var(--red-text)' }}>{error}</p></Card>}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
