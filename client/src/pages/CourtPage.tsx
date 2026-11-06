import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { CountUp } from '../components/CountUp'
import { Chip } from '../components/Chip'
import { PageHead } from '../components/Eyebrow'
import { Icon } from '../components/Icon'
import { JurySim } from '../components/JurySim'
import { StatTile } from '../components/StatTile'
import { useFlow } from '../components/flow/context'
import { ARB_POOL, CASE_META, JUDGES, JURY_INFO } from '../data/fixtures'
import { api, units, useLive } from '../data/live'
import { commitVote, getState, pickBand, revealVote, signInArbitrator, signInWithWorldId, signOutArbitrator, useSettld } from '../data/store'
import { WorldIdWidget } from '../components/WorldIdWidget'
import type { Attestation } from '../data/worldid'
import { go } from '../app/router'
import type { Band } from '../data/types'
import { fmt, mmss } from '../lib/format'
import { sideOf, verdictLong, verdictShort } from '../lib/verdict'
import Settld3D from '../three/settld3d'
import type { JuryController } from '../three/settld3d'
import { useScene } from '../three/useScene'

// two choices only: the whole clause goes to one side
const BANDS: [Band, string][] = [
  [100, 'Freelancer gets the whole amount'],
  [0, 'Client gets the whole amount back'],
]

/** World ID gate: the court is only for verified, anonymous human arbitrators.
 *  Real World ID: World's IDKit widget → our server verifies the proof with World → JurorRegistry seat (PIN). */
function Gate() {
  const { flow, toast } = useFlow()
  const [mode, setMode] = useState<'signin' | 'signup' | 'party' | null>(null)

  // World ID is tied to the Settld wallet, so an email sign-in comes first
  const start = (m: 'signin' | 'signup' | 'party') => {
    if (!getState().session.live) {
      toast(<><Icon name="bang" /> Sign in with your email first: World ID is linked to your Settld wallet.</>)
      return
    }
    setMode(m)
  }

  const verified = (att: Attestation) => {
    const m = mode
    setMode(null)
    if (m === 'party') {
      flow({
        kicker: 'Client or freelancer', title: 'World ID verified',
        summary: 'You proved you are a unique real person. Parties never see the court: follow your case on your timeline and, if you disagree with the AI judges, appeal it from the deal.',
        fee: false, receipt: false, okLabel: 'Open my timeline', cta: 'Continue',
        working: 'Saving your badge', steps: ['World ID · unique real person', 'Verified-human badge on your wallet'],
        run: () => signInWithWorldId(), done: 'Verified human.', after: () => go('timeline'),
      })
      return
    }
    flow({
      kicker: m === 'signup' ? 'Become an arbitrator' : 'Arbitrator sign-in',
      title: m === 'signup' ? 'Take your arbitrator seat' : 'Open the court',
      summary: m === 'signup'
        ? 'World ID proved you are a unique real person, so you can only ever hold one seat. Taking it records your World ID on the arbitrator registry on Arc (one PIN). If this wallet already holds your seat, there is no PIN.'
        : 'World ID proved it’s you. If this wallet doesn’t hold an arbitrator seat yet, you’ll take one now (one PIN).',
      fee: m === 'signup', receipt: false, pin: true, okLabel: 'Open my dashboard', cta: m === 'signup' ? 'Take my seat · PIN' : 'Continue',
      working: 'Checking the registry', steps: ['World ID · unique real person', 'Arbitrator seat on the registry', 'Loading your cases'],
      run: () => signInArbitrator(att),
      done: 'Signed in as a verified arbitrator.',
      next: 'Appeals you can hear show on your dashboard. Two votes against the majority suspend you for good.',
    })
  }

  return (
    <>
    <WorldIdWidget
      open={mode !== null}
      onVerified={verified}
      onCancel={() => setMode(null)}
      onFail={(message, close = true) => { if (close) setMode(null); toast(<><Icon name="bang" /> {message}</>) }}
    />
    <div className="grid side-360">
      <Card className="grid" style={{ gap: 16 }}>
        <div className="gate">
          <span className="lockbig"><Icon name="lock" /></span>
          <div className="grid" style={{ gap: 10 }}>
            <p style={{ fontSize: 17 }}>The court is open only to human arbitrators verified with World ID.</p>
            <p className="k mut">Clients and freelancers never see it. They follow their case on the Timeline, and either of them can appeal the AI verdict by putting down 10% of the disputed amount.</p>
            <div className="btn-row">
              <Button variant="ink" onClick={() => start('signin')}><Icon name="person" />Sign in as arbitrator</Button>
              <Button onClick={() => start('signup')}><Icon name="plus" />Sign up as arbitrator</Button>
            </div>
            <div className="btn-row" style={{ borderTop: '1px solid var(--ink-12)', paddingTop: 12 }}>
              <span className="k mut">Client or freelancer?</span>
              <Button size="sm" variant="sec" onClick={() => start('party')}>I’m a party · sign in with World ID</Button>
            </div>
          </div>
        </div>
      </Card>
      <Card tone="dark" className="grid" style={{ gap: 12 }}>
        <span className="bit" style={{ fontSize: 18 }}>The arbitrator pool</span>
        <div className="grid g2" style={{ gap: 14 }}>
          <div><div className="k" style={{ color: 'var(--beige-70)' }}>Verified humans</div><div className="num" style={{ fontSize: 28 }}><CountUp value={ARB_POOL.verified} /></div></div>
          <div><div className="k" style={{ color: 'var(--beige-70)' }}>Active this week</div><div className="num" style={{ fontSize: 28 }}><CountUp value={ARB_POOL.active} /></div></div>
        </div>
        <p className="k" style={{ color: 'var(--beige-70)' }}>The first three eligible arbitrators to vote form the panel. Votes stay hidden until all three reveal. Voting against the majority twice suspends the person, not just the wallet.</p>
      </Card>
    </div>
    </>
  )
}

function CaseView({ onBack }: { onBack: () => void }) {
  const { flow } = useFlow()
  const court = useSettld((s) => s.court)
  const courtCase = useLive(() => api.courtCase(CASE_META.caseId))
  const [info, setInfo] = useState('Drag to turn · click a seat or the bench')
  const cv = useRef<HTMLCanvasElement>(null)
  const labels = useRef<HTMLDivElement>(null)
  const scene = useScene<JuryController>(cv, (c) => {
    const s = getState().court
    const j = Settld3D.jury(c, {
      autoplay: false, loop: false, seats: 3, votes: ['creator', 'creator', 'none'], verifyAt: [0.6, 1.0, 1.4], voteAt: [5.4, 5.8, 6.2],
      arbiter: true, arbiterOn: true, verdictAt: s.finalBand !== null ? 10.4 : 99, side: 'creator', labels: labels.current,
      camR: 4.4, camPitch: 0.6, camY: 0.5, gridOp: 0.16, seatAngles: [-54, 0, 54], seatR: [1.25, 1.75, 1.25], arbPos: [0, -2.15], arbH: 0.5, arbW: 0.28, railY: 0.66,
      onPick: (id) => { if (id && JURY_INFO[id]) setInfo(JURY_INFO[id]) },
    })
    j.setTime(s.finalBand !== null ? 13 : 10.35)
    j.setTimer(0.62)
    return j
  })
  useEffect(() => { if (court.finalBand !== null) scene.current?.decide(sideOf(court.finalBand) === 'freelancer' ? 'creator' : 'brand') }, [court.finalBand, scene])

  const commit = () =>
    flow({
      kicker: `Case ${CASE_META.caseId} · hidden vote`,
      title: `Commit your vote: ${verdictShort(court.pick)}`,
      summary: 'Your vote is sealed now and stays hidden from everyone, the other arbitrators too, until all three reveal.',
      cta: 'Commit · PIN', pin: true, fee: true, receipt: false,
      working: 'Sealing your vote',
      steps: ['Hashing your vote with a secret only you hold', 'Recording the sealed vote on Arc', 'Taking your seat on the panel'],
      run: () => commitVote(),
      done: 'Vote sealed. You hold seat 1 of 3.',
      next: 'Reveal it once the other two seats have voted.',
    })
  const reveal = () =>
    flow({
      kicker: `Case ${CASE_META.caseId} · reveal`,
      title: 'Reveal your vote',
      summary: 'All three seats are sealed. Revealing opens your vote; the majority decides, and the money moves straight away.',
      cta: 'Reveal · PIN', pin: true, receipt: false,
      working: 'Revealing the panel',
      steps: ['Opening your sealed vote', 'Opening the other two seats', 'Counting the majority', 'Splitting the money'],
      run: () => revealVote(),
      done: `Panel decided: ${verdictShort(court.pick)}.`,
      next: 'Both parties see the result on their Timeline. Your share of the appeal fee is on its way.',
    })

  const seats = [
    { who: 'You', sealed: court.committed, band: court.revealed ? court.pick : null },
    { who: 'Arbitrator · anon', sealed: true, band: court.revealed ? court.pick : null },
    { who: 'Arbitrator · anon', sealed: court.committed, band: court.revealed ? (court.pick === 100 ? 0 : 100) : null },
  ]

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div><Button size="sm" variant="sec" style={{ color: 'var(--white)' }} onClick={onBack}><Icon name="back" />All cases</Button></div>
      <div className="court-grid">
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card className="grid" style={{ gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div className="bit" style={{ fontSize: 16, color: 'var(--ink-62)' }}>Step 1 · what the AI judges said</div>
                <h3 style={{ fontSize: 24 }}>Three models already ruled. A party appealed.</h3>
              </div>
              <Chip kind="ver" icon="gear">AI verdict · {verdictShort(court.aiBand ?? 100)}</Chip>
            </div>
            <div className="stage3d" style={{ height: 320 }}>
              <canvas ref={cv} role="img" aria-label="The court in 3D: three AI judges on the front arc, the disputed promise in the middle, and the human arbitrators' bench at the back." />
              <div className="lbls" ref={labels}>
                {JUDGES.map((j, i) => (
                  <div key={j.name} className="v3l" data-l={`juror-${i + 1}`}><span className="v3t"><b>{j.name}</b><br />{j.maker}</span></div>
                ))}
                <div className="v3l" data-l="arbiter"><span className="v3p"><b>{court.finalBand !== null ? 'Decided' : 'Panel'}</b>{court.finalBand !== null ? verdictShort(court.finalBand) : 'Human arbitrators'}</span></div>
                <div className="v3l" data-l="clause"><span className="v3t"><b>{CASE_META.amount} USDC on hold</b></span></div>
                <div className="v3l" data-l="brand"><span className="v3t"><b>Client</b></span></div>
                <div className="v3l" data-l="creator"><span className="v3t"><b>Freelancer</b></span></div>
              </div>
              <div style={{ position: 'absolute', right: 14, top: 12, fontSize: 12, color: 'var(--beige-70)', maxWidth: 260, textAlign: 'right' }}>{info}</div>
            </div>
            {courtCase && <JurySim transcript={courtCase.data.transcript} amount={CASE_META.amount} autoplay={false} />}
          </Card>

          <Card className="grid" style={{ gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div className="bit" style={{ fontSize: 16, color: 'var(--ink-62)' }}>Step 2 · your vote</div>
                <h3 style={{ fontSize: 24 }}>How should the {CASE_META.amount} USDC be split?</h3>
              </div>
              {court.finalBand === null && <Chip kind="need" icon="clock">Commit window · {mmss(court.clock)}</Chip>}
            </div>
            <div className="grid g3">
              {seats.map((s, i) => (
                <div key={i} className="judge" style={{ alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                    <span className="bit" style={{ fontSize: 18 }}>Seat {i + 1}</span>
                    <Chip kind="ver" icon="person">World ID</Chip>
                  </div>
                  <span className="k mut">{s.who}</span>
                  {s.band !== null ? <Chip kind="paid" icon="check">{verdictShort(s.band)}</Chip> : s.sealed ? <Chip kind="pend" icon="lock">Vote sealed</Chip> : <Chip kind="pend" icon="clock">Waiting</Chip>}
                </div>
              ))}
            </div>
            {court.finalBand !== null ? (
              <div className="gate" style={{ background: 'var(--beige)' }}>
                <span className="lockbig" style={{ color: 'var(--beige)' }}><Icon name="coin" /></span>
                <div className="grid" style={{ gap: 6 }}>
                  <div className="bit" style={{ fontSize: 28 }}>Decided · {verdictShort(court.finalBand)}</div>
                  <p style={{ fontSize: 15 }}>{verdictLong(court.finalBand, CASE_META.amount)}. The case is closed on the public record.</p>
                </div>
              </div>
            ) : (
              <>
                <div className="grid g2" role="radiogroup" aria-label="Your vote">
                  {BANDS.map(([b, label]) => (
                    <button key={b} type="button" className="opt" role="radio" aria-checked={court.pick === b} disabled={court.committed} onClick={() => pickBand(b)}>
                      <span className="rad" />
                      <span><span style={{ display: 'block' }}>{verdictShort(b)}</span><span className="k mut">{label}</span></span>
                    </button>
                  ))}
                </div>
                <div className="k mut">You see the AI judges’ reasoning, the promise, the work and the complaint. You never see the parties’ names or wallets. Voting with the majority earns a share of the appeal fee; voting against it twice suspends you.</div>
                <div className="btn-row">
                  {!court.committed ? <Button onClick={commit}><Icon name="lock" />Commit vote · PIN</Button> : <Button onClick={reveal}><Icon name="check" />Reveal vote · PIN</Button>}
                </div>
              </>
            )}
          </Card>
        </div>
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card className="grid" style={{ gap: 10 }}>
            <h3 style={{ fontSize: 20 }}>The case file</h3>
            <div className="k"><b style={{ fontWeight: 500 }}>The promise</b><p className="mut">Product clearly featured, positive tone · 200 USDC</p></div>
            <div className="k"><b style={{ fontWeight: 500 }}>The work</b><p className="mut">{courtCase?.data.transcript.evidence ?? '…'}</p></div>
            <div className="k"><b style={{ fontWeight: 500 }}>The complaint</b><p className="mut">{courtCase?.data.transcript.reason ?? '…'}</p></div>
          </Card>
          <Card className="grid" style={{ gap: 10, borderLeft: '4px solid var(--orange)' }}>
            <span className="bit" style={{ fontSize: 16 }}>Why you see this case</span>
            <p className="k">You are World ID verified and not a party to this deal. Parties can never sit on their own panel, even from another wallet.</p>
          </Card>
        </div>
      </div>
    </div>
  )
}

function Dashboard({ onOpen }: { onOpen: () => void }) {
  const dash = useLive(api.arbitratorDashboard)
  const cases = useLive(api.arbitratorCases)
  const court = useSettld((s) => s.court)
  if (!dash) return null
  const { profile, totals, history } = dash.data
  // live server: show its open cases; demo mode: only after the local demo case was appealed
  const live = cases?.source === 'live'
  const showCases = live || court.appealed
  return (
    <div className="grid" style={{ gap: 16 }}>
      {profile.suspended && (
        <div className="gate" style={{ background: 'var(--white)', boxShadow: 'inset 0 0 0 2px var(--red)' }}>
          <span className="lockbig" style={{ color: 'var(--red)' }}><Icon name="cross" /></span>
          <div className="grid" style={{ gap: 6 }}>
            <div className="bit" style={{ fontSize: 32, color: 'var(--red-text)' }}>Suspended</div>
            <p className="k">Two votes against the majority. The suspension is tied to your World ID, so a new wallet can’t reset it.</p>
          </div>
        </div>
      )}
      <div className="stats">
        <StatTile label="Cases taken" icon="gear" color="var(--ciel)"><CountUp value={totals.casesTaken} /></StatTile>
        <StatTile label="With the majority" icon="check" color="var(--blue)"><CountUp value={totals.rightCalls} /></StatTile>
        <StatTile label="Against the majority" icon="cross" color="var(--orange)"><CountUp value={totals.wrongCalls} /></StatTile>
        <StatTile label="Fees earned" icon="coin" color="var(--beige)"><CountUp value={units(totals.feesEarnedUnits)} format={fmt} /></StatTile>
        <StatTile hot label="Strikes" icon="bang" color="var(--ink)"><CountUp value={profile.strikes} /> <span style={{ fontSize: 14 }}>of 2</span></StatTile>
      </div>
      <div className="grid side-360">
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <h3 style={{ fontSize: 22 }}>Appeals waiting for arbitrators</h3>
              <span className="bit num" style={{ fontSize: 22 }}>{showCases ? cases?.data.cases.length ?? 0 : 0}</span>
            </div>
            {showCases && cases?.data.cases.length ? (
              cases.data.cases.map((c) => (
                <div key={c.caseId} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '14px 0', borderTop: '1px solid var(--ink-12)', flexWrap: 'wrap' }}>
                  <span className="ok-ic c-need"><Icon name="gear" /></span>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div>Case {c.caseId} · AI said {verdictShort(c.aiBand).toLowerCase()} {c.demo && <Chip kind="pend">Demo</Chip>}</div>
                    <div className="k mut">{c.reason} · seats {c.seatsTaken + (!live && court.committed ? 1 : 0)} of 3</div>
                  </div>
                  <Button size="sm" disabled={!c.canJoin && !c.mySeat} title={c.blockedReason ?? ''} onClick={onOpen}>{c.demo ? 'Demo' : !live ? (court.finalBand !== null ? 'View' : court.committed ? 'Reveal' : 'Take a seat') : c.mySeat ? 'Open' : 'Take a seat'}</Button>
                </div>
              ))
            ) : (
              <p className="k mut" style={{ paddingTop: 10, borderTop: '1px solid var(--ink-12)' }}>No appeals right now. Cases only reach arbitrators when a client or freelancer appeals the AI verdict.</p>
            )}
          </Card>
          <Card>
            <h3 style={{ fontSize: 22, marginBottom: 10 }}>My past cases</h3>
            <div className="tscroll">
              <table>
                <thead><tr><th>Case</th><th>Complaint</th><th>AI</th><th>Me</th><th>Final</th><th>Result</th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.caseId}>
                      <td className="bit" style={{ fontSize: 16 }}>{h.caseId}{h.demo && <> <Chip kind="pend">Demo</Chip></>}</td>
                      <td>{h.reason}</td>
                      <td>{h.aiBand === null ? '·' : verdictShort(h.aiBand)}</td>
                      <td>{h.myBand === null ? '·' : verdictShort(h.myBand)}</td>
                      <td>{h.finalBand === null ? '·' : verdictShort(h.finalBand)}</td>
                      <td>{h.outcome === 'with_majority' ? <Chip kind="ver" icon="check">With majority</Chip> : h.outcome === 'against_majority' ? <Chip kind="froz" icon="bang">Strike</Chip> : <Chip kind="pend">Pending</Chip>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card tone="dark" className="grid" style={{ gap: 10 }}>
            <span className="bit" style={{ fontSize: 18 }}>Your record</span>
            <p className="k" style={{ color: 'var(--beige-70)' }}>Only you can see this page. It is tied to your World ID, not to a wallet.</p>
            <div className="k" style={{ color: 'var(--beige-70)' }}>{dash.source === 'live' ? 'Live from Arc and the Settld server.' : 'Demo data: the server isn’t connected.'}</div>
          </Card>
          <Card className="grid" style={{ gap: 10 }}>
            <h3 style={{ fontSize: 20 }}>How a panel works</h3>
            <p className="k mut">1. A party appeals and pays 10%. 2. The first three eligible arbitrators seal a vote. 3. All reveal; the majority decides and shares the fee. 4. Against the majority = a strike; two strikes = suspended.</p>
          </Card>
        </div>
      </div>
    </div>
  )
}

export default function CourtPage() {
  const court = useSettld((s) => s.court)
  const me = useLive(api.arbitratorMe)
  const [open, setOpen] = useState(false)
  const allowed = court.arbSignedIn || !!me?.data.canAccessCourt
  return (
    <section className="view on">
      <div className="ground gut">
        <div className="wrap">
          <PageHead
            eyebrow={allowed ? 'Court · arbitrator dashboard' : 'Court · arbitrators only'}
            title={allowed ? <>Your cases. <span style={{ color: 'var(--beige)' }}>Your record.</span></> : 'The human court of appeal.'}
            aside={allowed ? (
              <div className="btn-row">
                <Chip kind="ver" icon="person">World ID verified</Chip>
                {court.arbSignedIn && <Button size="sm" variant="sec" style={{ color: 'var(--white)' }} onClick={() => { setOpen(false); signOutArbitrator() }}>Sign out</Button>}
              </div>
            ) : undefined}
          />
          {!allowed ? <Gate /> : open ? <CaseView onBack={() => setOpen(false)} /> : <Dashboard onOpen={() => setOpen(true)} />}
        </div>
      </div>
    </section>
  )
}
