import { useState, type ReactNode } from 'react'
import { Button, ButtonLink } from '../components/Button'
import { Card } from '../components/Card'
import { Chip } from '../components/Chip'
import { PageHead } from '../components/Eyebrow'
import { Icon } from '../components/Icon'
import { JurySim } from '../components/JurySim'
import { CASE_META, DAILY } from '../data/fixtures'
import { api, useLive } from '../data/live'
import { useSettld } from '../data/store'
import type { ChipKind, DealPromise, IconName } from '../data/types'
import { mmss } from '../lib/format'

type Viewer = 'client' | 'freelancer'
type Step = { icon: IconName; kind: ChipKind; when: string; title: string; text: ReactNode; who: string; todo?: boolean; body?: ReactNode }

function promiseSteps(p: DealPromise, viewer: Viewer, windowLeft: number, extra: { court?: ReactNode }): Step[] {
  const you = viewer === 'freelancer'
  const money = `${p.amount} USDC`
  const base: Step[] = [{ icon: 'play', kind: 'pend', when: '14:30', who: 'Freelancer', title: `Promise ${p.n} · work submitted`, text: you ? 'You pasted the link to your work.' : 'Freelancer pasted the link to their work.' }]
  if (p.state === 'locked') return [{ icon: 'lock', kind: 'locked', when: 'waiting', who: 'Freelancer', todo: true, title: `Promise ${p.n} · waiting for the work`, text: `${money} stays locked until the work is submitted or the deadline passes.` }]
  if (p.state === 'verified')
    return [...base, { icon: 'hex', kind: 'ver', when: '14:31', who: 'Chainlink · no human', title: `Promise ${p.n} · checked and verified`, text: `Independent checkers agreed the promise was kept. ${money} pays out in ${mmss(windowLeft)} unless someone disputes it.` }]
  if (p.state === 'checking')
    return [...base, { icon: 'clock', kind: 'check', when: 'daily', who: 'Chainlink · every day', title: `Promise ${p.n} · checked every day`, text: `Day ${DAILY.day} of ${DAILY.days}. The video is still public, so ${DAILY.perDay} USDC a day keeps flowing to ${you ? 'you' : 'Freelancer'}.` }]
  if (p.state === 'frozen')
    return [
      ...base,
      { icon: 'bang', kind: 'froz', when: '14:40', who: 'Client', title: `Promise ${p.n} · disputed`, text: `Only this ${money} is on hold. Three AI judges read the promise, the work and the complaint.` },
      { icon: 'gear', kind: 'ver', when: 'now', who: 'AI court · 3 models', title: 'The AI judges are discussing', text: 'Watch them reason in plain words. The majority decides who gets the money: all of it to the freelancer, or all of it back to the client.', body: extra.court },
    ]
  if (p.state === 'returned')
    return [...base, { icon: 'back', kind: 'ver', when: 'done', who: 'Contract · no human', title: `Promise ${p.n} · refunded`, text: p.note }]
  // paid
  return [
    ...base,
    ...(p.split ? [{ icon: 'gear' as IconName, kind: 'ver' as ChipKind, when: 'done', who: 'Court', title: `Promise ${p.n} · court decided`, text: p.note, body: extra.court }] : [{ icon: 'hex' as IconName, kind: 'ver' as ChipKind, when: '14:22', who: 'Chainlink · no human', title: `Promise ${p.n} · verified`, text: 'Checkers agreed the promise was kept.' }]),
    { icon: 'coin', kind: 'paid', when: '14:24', who: 'Contract · no human', title: `Promise ${p.n} · paid`, text: p.split ? (p.split.toClient === 0 ? `All ${p.split.toFreelancer} USDC went to Freelancer.` : p.split.toFreelancer === 0 ? `All ${p.split.toClient} USDC went back to Client.` : `${p.split.toFreelancer} USDC to Freelancer, ${p.split.toClient} USDC back to Client.`) : `${money} reached ${you ? 'you' : 'Freelancer'}, split on arrival as agreed in the deal.` },
  ]
}

function TimelineItem({ s, last }: { s: Step; last: boolean }) {
  return (
    <li style={{ display: 'grid', gridTemplateColumns: '28px minmax(0,1fr)', gap: 14, position: 'relative', paddingBottom: last ? 0 : 20 }}>
      {!last && <span aria-hidden="true" style={{ position: 'absolute', left: 13, top: 30, bottom: 0, width: 2, background: 'var(--ink-12)' }} />}
      <span className={`tsq c-${s.kind}`} style={{ width: 28, height: 28, fontSize: 14, opacity: s.todo ? 0.6 : 1 }}><Icon name={s.icon} /></span>
      <div className="grid" style={{ gap: 6, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <b style={{ fontWeight: 500, fontSize: 16 }}>{s.title}</b>
          <span className="k mut num">{s.when} · {s.who}</span>
        </div>
        <p className={`k${s.todo ? ' mut' : ''}`}>{s.text}</p>
        {s.body && <div style={{ marginTop: 6 }}>{s.body}</div>}
      </div>
    </li>
  )
}

export default function TimelinePage() {
  const session = useSettld((s) => s.session)
  return session.signedIn ? <MyTimeline initial={session.role} /> : <GeneralTimeline />
}

/** Signed out: how any deal moves, in plain words, with an example AI court case */
function GeneralTimeline() {
  const courtCase = useLive(() => api.courtCase(CASE_META.caseId))
  const steps: Step[] = [
    { icon: 'b', kind: 'pend', when: 'step 1', who: 'Client', title: 'The client writes the deal', text: 'Up to five promises in plain words, each with its own amount, deadline and how it gets checked: a YouTube post, a live link, text on a page, a merged GitHub pull request, or an AI check against the brief.' },
    { icon: 'shield', kind: 'ver', when: 'step 2', who: 'Settld check · automatic', title: 'No deadlock certificate', text: 'Before anyone signs, we try every way the deal could go and prove each dollar always reaches someone. Both sides see the certificate.' },
    { icon: 'play', kind: 'pend', when: 'step 3', who: 'Freelancer', title: 'The freelancer accepts', text: 'They read every promise, amount and the certificate first. Then Chainlink records the certificate on the public record.' },
    { icon: 'lock', kind: 'locked', when: 'step 4', who: 'Client', title: 'The money is locked', text: 'The client funds the deal with a PIN. The money sits in a safe nobody can open early, not even Settld.' },
    { icon: 'play', kind: 'pend', when: 'step 5', who: 'Freelancer', title: 'The work is submitted', text: 'Any link: a post, a reel, a video, a website or a pull request. Screenshots work too for things that can’t be fetched.' },
    { icon: 'hex', kind: 'ver', when: 'step 6', who: 'Chainlink · no human', title: 'Chainlink checks it', text: 'Every Chainlink node checks the work on its own and they must agree. Judgement calls get a vote from three AI models.' },
    { icon: 'clock', kind: 'check', when: 'step 7', who: 'Both sides', title: 'A short window to object', text: 'Either side can dispute a result within a few minutes. If nobody does, the money moves on its own: paid out or refunded.' },
    { icon: 'gear', kind: 'need', when: 'if disputed', who: 'AI court · 3 models', title: 'Three AI judges discuss it', text: 'They give blind first opinions, then read each other and discuss. The majority decides: the freelancer gets the whole amount, or the client gets it all back. Here is an example case:', body: courtCase ? <Card style={{ boxShadow: 'inset 0 0 0 1px var(--ink-12)' }}><JurySim transcript={courtCase.data.transcript} amount={CASE_META.amount} /></Card> : undefined },
    { icon: 'person', kind: 'need', when: 'if appealed', who: 'Human arbitrators', title: 'Appeal to verified humans', text: 'Not happy? Either side can put down 10% to appeal. Three anonymous World ID verified arbitrators seal their votes, reveal them, and the majority is final.' },
    { icon: 'coin', kind: 'paid', when: 'end', who: 'Contract · no human', title: 'Everyone gets their share', text: 'Each promise pays out on its own, split the way both sides agreed. Nothing is ever stuck.' },
  ]
  return (
    <section className="view on">
      <div className="ground gut">
        <div className="wrap">
          <PageHead
            eyebrow="Timeline · how a deal moves"
            title={<>From first promise to last payout, <span style={{ color: 'var(--beige)' }}>in plain words.</span></>}
            aside={<ButtonLink href="#dashboard">Sign in to see your deals <Icon name="arrow" /></ButtonLink>}
          >
            <span className="k" style={{ color: 'var(--beige)' }}>Signed in, this page shows your own deal as it happens, as the client or the freelancer.</span>
          </PageHead>
          <Card>
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {steps.map((s, i) => <TimelineItem key={s.title} s={s} last={i === steps.length - 1} />)}
            </ol>
          </Card>
        </div>
      </div>
    </section>
  )
}

/** Signed in: this account’s deal, seen as the client or the freelancer */
function MyTimeline({ initial }: { initial: Viewer }) {
  const [viewer, setViewer] = useState<Viewer>(initial)
  const deal = useSettld((s) => s.deal)
  const windowLeft = useSettld((s) => s.windowLeft)
  const court = useSettld((s) => s.court)
  const auto = useLive(api.automation, 5000)
  const courtCase = useLive(() => api.courtCase(CASE_META.caseId))
  const you = viewer === 'freelancer'

  const courtView = courtCase ? (
    <Card style={{ boxShadow: 'inset 0 0 0 1px var(--ink-12)' }}>
      <JurySim transcript={courtCase.data.transcript} amount={CASE_META.amount} autoplay={court.finalBand === null} />
      {court.finalBand === null && court.aiBand !== null && (
        <div className="k" style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {court.appealed ? (
            <Chip kind="need" icon="person">Appealed · human arbitrators are deciding</Chip>
          ) : (
            <>
              <span className="mut">Not happy with the verdict? Either side can appeal to human arbitrators on the Deal page.</span>
              <ButtonLink size="sm" variant="sec" href="#deal">Go to the deal</ButtonLink>
            </>
          )}
        </div>
      )}
    </Card>
  ) : null

  const opening: Step[] = [
    { icon: 'b', kind: 'pend', when: '14:02', who: 'Client', title: 'Deal proposed', text: `${you ? 'Client' : 'You'} wrote ${deal.promises.length} promises worth ${deal.total.toLocaleString('en-US')} USDC.` },
    { icon: 'play', kind: 'pend', when: '14:09', who: 'Freelancer', title: 'Deal accepted', text: `${you ? 'You' : 'Freelancer'} read every promise and the No deadlock certificate, then accepted.` },
    { icon: 'shield', kind: 'ver', when: '14:10', who: 'Chainlink · no human', title: 'Certified: no deadlock', text: 'Every way the deal can go ends with each dollar reaching someone. The certificate is on the public record.' },
    { icon: 'lock', kind: 'locked', when: '14:12', who: 'Client', title: 'Money locked', text: `${deal.total.toLocaleString('en-US')} USDC is in the safe. Nobody can take it early, not even Settld.` },
  ]
  const steps = [...opening, ...deal.promises.flatMap((p) => promiseSteps(p, viewer, windowLeft, { court: p.id === CASE_META.promiseId ? courtView : undefined }))]
  const settled = deal.promises.every((p) => p.state === 'paid' || p.state === 'returned')
  steps.push({ icon: 'check', kind: settled ? 'ver' : 'pend', when: settled ? 'now' : 'later', who: 'Contract', todo: !settled, title: 'Deal settled', text: settled ? 'Every promise has ended and every dollar reached someone.' : 'When every promise ends.' })

  return (
    <section className="view on">
      <div className="ground gut">
        <div className="wrap">
          <PageHead
            eyebrow={`Timeline · deal ${deal.number}`}
            title={<>Everything that happened, <span style={{ color: 'var(--beige)' }}>in plain words.</span></>}
            aside={
              <div className="grid" style={{ gap: 6 }}>
                <span className="k" style={{ color: 'var(--beige)' }}>Viewing as</span>
                <div className="btn-row" role="group" aria-label="Viewing as">
                  <Button size="sm" variant={viewer === 'client' ? 'primary' : 'sec'} aria-pressed={viewer === 'client'} style={viewer === 'client' ? undefined : { color: 'var(--white)' }} onClick={() => setViewer('client')}>Client</Button>
                  <Button size="sm" variant={viewer === 'freelancer' ? 'primary' : 'sec'} aria-pressed={viewer === 'freelancer'} style={viewer === 'freelancer' ? undefined : { color: 'var(--white)' }} onClick={() => setViewer('freelancer')}>Freelancer</Button>
                </div>
              </div>
            }
          >
            <span className="k" style={{ color: 'var(--beige)' }}>Only the client and the freelancer of this deal can see it. Nobody needs to click anything: Chainlink and the contract move the money on their own.</span>
          </PageHead>
          <div className="grid side-360">
            <Card>
              <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {steps.map((s, i) => <TimelineItem key={`${i}-${s.title}`} s={s} last={i === steps.length - 1} />)}
              </ol>
            </Card>
            <div className="grid" style={{ alignContent: 'start' }}>
              <Card tone="dark" className="grid" style={{ gap: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <span className="bit" style={{ fontSize: 18 }}>Working now</span>
                  <Chip style={{ background: 'rgba(255,255,255,.14)', color: 'var(--white)' }}>
                    <span className={`dot${auto?.source === 'live' ? ' live' : ''}`} style={{ background: auto?.source === 'live' ? 'var(--orange)' : 'var(--beige-70)', borderRadius: '50%' }} />
                    {auto?.source === 'live' ? (auto.data.enabled ? 'Live' : 'Live · automation off') : 'Demo'}
                  </Chip>
                </div>
                {auto?.source === 'live' ? (
                  <>
                    <p className="k">{auto.data.running ? `Chainlink is working: ${auto.data.running}` : 'Nothing running right now.'}</p>
                    {auto.data.queued.length > 0 && <p className="k" style={{ color: 'var(--beige-70)' }}>Next: {auto.data.queued.join(', ')}</p>}
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="grid">
                      {auto.data.recent.slice(-6).reverse().map((r, i) => (
                        <li key={i} className="k" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span className={`ok-ic ${r.ok ? 'c-ver' : 'c-fail'}`}><Icon name={r.ok ? 'check' : 'cross'} /></span>
                          <span style={{ minWidth: 0 }}>{r.label}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="k" style={{ color: 'var(--beige-70)' }}>The server isn’t connected, so this shows the demo deal. With the backend running, Chainlink jobs and payouts appear here as they happen.</p>
                )}
              </Card>
              <Card className="grid" style={{ gap: 10 }}>
                <h3 style={{ fontSize: 20 }}>Who does what</h3>
                {([
                  ['b', 'Client', 'Proposes, funds, can dispute a clause in its window.'],
                  ['play', 'Freelancer', 'Accepts, submits the work, can dispute too.'],
                  ['hex', 'Chainlink', 'Certifies the deal, checks the work, runs the AI judges.'],
                  ['person', 'Human arbitrators', 'Only if someone appeals the AI verdict. World ID verified, anonymous.'],
                ] as const).map(([ic, t, d]) => (
                  <div key={t} className="who-row">
                    <span className="tile-ic" style={{ background: 'var(--ink)', color: 'var(--white)' }}><Icon name={ic} /></span>
                    <div><b style={{ fontWeight: 500 }}>{t}</b><p className="k mut">{d}</p></div>
                  </div>
                ))}
              </Card>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
