import { useEffect, useRef, useState } from 'react'
import { ButtonLink } from '../components/Button'
import { Card } from '../components/Card'
import { CountUp } from '../components/CountUp'
import { Chip } from '../components/Chip'
import { Eyebrow } from '../components/Eyebrow'
import { Icon } from '../components/Icon'
import { ChainlinkLogo, CircleLogo, WorldLogo } from '../components/Logos'
import { LIFE, LIFE_SHEET } from '../data/fixtures'
import type { LifeStage } from '../data/types'
import { useReducedMotion } from '../lib/motion'
import Settld3D from '../three/settld3d'
import type { HandshakeController } from '../three/settld3d'
import { useScene } from '../three/useScene'

function LifeArt({ art }: { art: LifeStage['art'] }) {
  if (art === 'sheet' || art === 'scan')
    return (
      <div style={{ background: 'var(--white)', color: 'var(--ink)', borderRadius: 6, padding: 18, display: 'flex', flexDirection: 'column', gap: 2, fontSize: 14 }}>
        {LIFE_SHEET.map(([n, t]) => (
          <div key={n} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--ink-12)' }}>
            {art === 'scan' && (
              <span className="ok-ic c-ver">
                <Icon name="check" />
              </span>
            )}
            <span className="bit" style={{ fontSize: 16, color: 'var(--ink-62)' }}>
              {n}
            </span>
            <span style={{ flex: 1 }}>{t}</span>
            <span className="ok-ic" style={{ boxShadow: "inset 0 0 0 1px var(--ink-25)" }}><Icon name="coin" /></span>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10 }} className="mut">
          <span>{art === 'scan' ? 'No deadlock · every path ends with each dollar reaching someone' : 'Total'}</span>
          <span>Amounts set by you</span>
        </div>
      </div>
    )
  if (art === 'safe' || art === 'paid') {
    const paid = art === 'paid'
    return (
      <div style={{ border: '1px solid currentColor', borderRadius: 6, overflow: 'hidden' }}>
        <div className="bit" style={{ padding: '10px 12px', fontSize: 18, background: paid ? 'var(--beige)' : 'var(--ink)', color: paid ? 'var(--ink)' : 'var(--white)' }}>
          {paid ? 'Promise 1 paid · the rest still locked' : 'Locked · one lane per promise'}
        </div>
        <div style={{ display: 'flex', gap: 8, padding: 12, height: 240 }}>
          {[6, 4, 6, 4].map((v, i) => {
            const done = paid && i === 0
            return (
              <div key={i} style={{ flex: 1, border: '1px solid currentColor', borderRadius: 4, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 3, padding: '8px 6px', ...(done ? { background: 'var(--beige)', color: 'var(--ink)' } : {}) }}>
                <Icon name={done ? 'check' : 'lock'} />
                {Array.from({ length: v }, (_, k) => (
                  <span key={k} style={{ width: '70%', height: 7, borderRadius: 2, background: done ? 'transparent' : 'currentColor', opacity: 0.85 }} />
                ))}
                <span className="num" style={{ fontSize: 12, marginTop: 4 }}>
                  {done ? 'paid' : `C${i + 1}`}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }
  if (art === 'video')
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 14 }}>
        <div style={{ background: 'var(--ink)', borderRadius: 6, padding: 10, height: 220, display: 'grid', placeItems: 'center' }}>
          <span style={{ width: 44, height: 44, borderRadius: 4, background: 'var(--white)', color: 'var(--ink)', display: 'grid', placeItems: 'center', fontSize: 20 }}>
            <Icon name="play" />
          </span>
        </div>
        <div style={{ background: 'var(--white)', color: 'var(--ink)', borderRadius: 6, padding: 14, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <b style={{ fontWeight: 500 }}>Clause 01 · posted 14:02</b>
          <span className="mut">Chainlink nodes checking</span>
          {[7, 5, 6, 8].map((n, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span className="bit" style={{ width: 22 }}>
                N{i + 1}
              </span>
              {Array.from({ length: 10 }, (_, k) => (
                <i key={k} style={{ width: 9, height: 12, borderRadius: 2, ...(k < n ? { background: 'var(--orange)' } : { boxShadow: 'inset 0 0 0 1px var(--ink-25)' }) }} />
              ))}
            </div>
          ))}
        </div>
      </div>
    )
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 10 }}>
      {[1, 2, 3].map((n) => (
        <div key={n} style={{ aspectRatio: '1', background: 'var(--white)', color: 'var(--ink)', borderRadius: 6, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <span style={{ width: 44, height: 44, borderRadius: 4, background: 'var(--blue)', color: 'var(--white)', display: 'grid', placeItems: 'center', fontSize: 20 }}>
            <Icon name="check" />
          </span>
          <span className="k">{n === 3 ? 'Node N' : `Node ${n}`}</span>
        </div>
      ))}
      <div style={{ gridColumn: '1/-1', background: 'var(--white)', color: 'var(--ink)', borderRadius: 6, padding: 12, fontSize: 14 }}>Every node returned the same verdict · clause 01 verified. Judgement calls add a vote by 3 AI models.</div>
    </div>
  )
}

function DealLife() {
  const [i, setI] = useState(0) // always start at Draft
  const [manual, setManual] = useState(false)
  const reduced = useReducedMotion()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (manual || reduced || !box.current || !('IntersectionObserver' in window)) return
    let tm: ReturnType<typeof setInterval> | undefined
    const io = new IntersectionObserver(
      (en) => {
        clearInterval(tm)
        if (en[0].isIntersecting) tm = setInterval(() => setI((x) => (x + 1) % LIFE.length), 3200)
      },
      { threshold: 0.5 },
    )
    io.observe(box.current)
    return () => {
      io.disconnect()
      clearInterval(tm)
    }
  }, [manual, reduced])
  const pick = (n: number) => {
    setManual(true)
    setI(n)
  }
  const s = LIFE[i]
  const nx = (i + 1) % LIFE.length
  return (
    <div className="life" ref={box}>
      <div className="life-tabs" role="tablist" aria-label="Deal stages">
        {LIFE.map((x, k) => (
          <button key={x.key} className="ltab" role="tab" aria-selected={k === i} aria-controls="lifePanel" onClick={() => pick(k)}>
            {x.key}
          </button>
        ))}
      </div>
      <div id="lifePanel">
        <div className="lpanel" role="tabpanel" key={i} style={{ background: s.bg, color: s.fg }}>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 24, minWidth: 0 }}>
            <span className="bit" style={{ fontSize: 16 }}>
              A deal’s life · 0{i + 1} / 06
            </span>
            <div>
              <div className="big">{s.key}</div>
              <p style={{ fontSize: 17, marginTop: 18, maxWidth: '30em' }}>{s.text}</p>
            </div>
            <div className="foot">
              <span>
                <span style={{ opacity: 0.7 }}>Done by</span>&nbsp; {s.who}
              </span>
              <button className="btn sm" style={{ background: 'var(--ink)', color: 'var(--white)' }} onClick={() => pick(nx)}>
                {i === LIFE.length - 1 ? 'Start again' : `Next · ${LIFE[nx].key}`} <Icon name="arrow" />
              </button>
            </div>
          </div>
          <div style={{ alignSelf: 'center', minWidth: 0 }}>
            <LifeArt art={s.art} />
          </div>
        </div>
      </div>
    </div>
  )
}

const BAND = ['Lock the money', 'Check the promise', 'Pay the freelancer', 'No human in the middle']

export default function OverviewPage() {
  const cv = useRef<HTMLCanvasElement>(null)
  const scene = useScene<HandshakeController>(cv, (c) => Settld3D.handshake(c, { handUrl: '/hand-right.json' }))
  useEffect(() => {
    const onScroll = () => scene.current?.setScroll(Math.min(1, Math.max(0, window.scrollY / 700)))
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [scene])

  return (
    <section className="view on on-dark">
      <div className="hero gut">
        <div className="hero-3d" aria-hidden="true" data-depth="0.14">
          <canvas ref={cv} />
        </div>
        <div className="wrap" style={{ width: '100%' }} data-depth="-0.05">
          <div className="hero-copy">
            <Eyebrow style={{ color: 'var(--white)' }}>Escrow for freelance deals</Eyebrow>
            <h1>
              <span className="g">Deals that pay</span>
              <span className="b">themselves.</span>
            </h1>
            <p className="lead">Settld locks a client’s payment in a neutral safe and releases it to the freelancer promise by promise, the moment independent checkers confirm each one.</p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <ButtonLink size="big" href="#new">
                Start a deal <Icon name="arrow" />
              </ButtonLink>
              <ButtonLink size="big" variant="sec" href="#timeline" style={{ color: 'var(--white)' }}>
                Watch a deal
              </ButtonLink>
            </div>
            <div className="trust">
              <span>Built on <b>Arc</b></span>
              <span>Wallets by <b>Circle</b></span>
              <span>Checked by <b>Chainlink</b></span>
              <span>Arbitrators verified by <b>World</b></span>
            </div>
          </div>
        </div>
        <button className="replay" aria-label="Replay the handshake" onClick={() => scene.current?.replay()}>
          <Icon name="replay" />
        </button>
      </div>

      <div className="band" aria-hidden="true">
        <div className="band-in">
          {[...BAND, ...BAND].map((t, k) => (
            <span key={k} style={{ display: 'contents' }}>
              <span>{t}</span>
              <i />
            </span>
          ))}
        </div>
      </div>

      <section className="sec light gut">
        <div className="wrap">
          <Eyebrow className="rv">The problem</Eyebrow>
          <h2 className="rv" style={{ marginTop: 20 }}>
            Freelancers wait months to get paid. Clients pay for work that vanishes. <span className="g">One small disagreement freezes the whole fee.</span>
          </h2>
          <div className="probs rv2">
            {[
              ['01 / 03', '90 days', 'Paid late, after three invoices.'],
              ['02 / 03', 'Whole fee', 'Lost over one detail nobody wrote down.'],
              ['03 / 03', 'Vanished', 'Client paid. The video went private a week later.'],
            ].map(([n, h, t]) => (
              <div className="prob" key={n}>
                <span className="bit" style={{ fontSize: 16 }}>{n}</span>
                <div>
                  <div className="n">{h === '90 days' ? <><CountUp value={90} /> days</> : h}</div>
                  <div style={{ fontSize: 14, color: 'var(--beige)' }}>{t}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="sec blue gut">
        <div className="wrap">
          <Eyebrow className="rv" style={{ color: 'var(--white)' }}>How it works</Eyebrow>
          <h2 className="rv" style={{ marginTop: 20 }}>
            People do four things. <span className="g">Everything else happens on its own.</span>
          </h2>
          <div className="steps4 rv2">
            {([
              ['01', 'Client proposes', 'Write up to five promises in plain words, each with its own amount, deadline and proof.', 'b', 'Client'],
              ['02', 'Freelancer accepts', 'They read every clause and amount before agreeing. Nothing is locked until then.', 'play', 'Freelancer'],
              ['03', 'Client funds', 'One button, two PIN steps. The money sits in a safe nobody can open early, not even Settld.', 'b', 'Client'],
              ['04', 'Freelancer submits', 'Paste the link to the work. Checkers look, and each kept promise pays out by itself.', 'play', 'Freelancer'],
            ] as const).map(([n, h, t, ic, who]) => (
              <div className="step4" key={n}>
                <span className="bit bitn">{n}</span>
                <div style={{ fontSize: 20 }}>{h}</div>
                <p className="mut k">{t}</p>
                <div className="who">
                  <span className="ava"><Icon name={ic} /></span>
                  {who}
                </div>
              </div>
            ))}
          </div>
          <div className="auto rv">
            <span className="bit">Then, with no human involved</span>
            <Chip kind="locked" icon="hex">Chainlink checks the work</Chip>
            <Chip kind="ver" icon="check">Verified clause by clause</Chip>
            <Chip kind="need" icon="clock">Short dispute window</Chip>
            <Chip icon="coin" style={{ background: 'var(--beige)', color: 'var(--ink)' }}>Paid, split the way you agreed</Chip>
          </div>
        </div>
      </section>

      <section className="sec gut">
        <div className="wrap">
          <Eyebrow className="rv" style={{ color: 'var(--orange)' }}>A deal’s life</Eyebrow>
          <h2 className="rv" style={{ marginTop: 20, color: 'var(--white)' }}>
            Six stages. <span className="g" style={{ color: 'var(--beige-70)' }}>Pick one, or let it play.</span>
          </h2>
          <DealLife />
        </div>
      </section>

      <section className="sec beige gut">
        <div className="wrap">
          <Eyebrow className="rv">Built with</Eyebrow>
          <h2 className="rv" style={{ marginTop: 20 }}>
            Three partners, one job each. <span className="g">You never see the plumbing.</span>
          </h2>
          <div className="stack three rv2">
            {([
              [<CircleLogo key="c" />, 'var(--blue)', 'var(--white)', 'Arc + Circle', 'The deal lives on Arc and USDC moves there for about $0.01. Sign in with email and a 6-digit code; a PIN approves every payment. No crypto wallet needed.'],
              [<ChainlinkLogo key="l" />, 'var(--ink)', 'var(--white)', 'Chainlink', 'Certifies the deal has no deadlock, checks the work on every node, and runs the three AI judges in a dispute.'],
              [<WorldLogo key="w" />, 'var(--orange)', 'var(--ink)', 'World ID', 'Human arbitrators who hear an appeal prove they are unique real people. Parties can never rule on their own case.'],
            ] as const).map(([logo, bg, fg, h, t]) => (
              <Card key={h}>
                <span className="tile-ic" style={{ background: bg, color: fg, width: 44, height: 44 }}>{logo}</span>
                <div style={{ fontSize: 22, marginTop: 12 }}>{h}</div>
                <p className="mut k" style={{ marginTop: 6 }}>{t}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="sec light gut">
        <div className="wrap">
          <Eyebrow className="rv">Future scope</Eyebrow>
          <h2 className="rv" style={{ marginTop: 20 }}>
            Today freelancers. <span className="g">Tomorrow, anyone who can’t afford court.</span>
          </h2>
          <div className="probs rv2">
            {[
              ['01 / 03', 'Too small', 'Most contract disputes are worth less than a lawyer’s first hour, so they never reach court.'],
              ['02 / 03', 'Too slow', 'Court takes months. A Settld case closes in minutes, with the reasoning on the public record.'],
              ['03 / 03', 'Fair by default', 'Three AI models weigh the evidence. Verified humans hear any appeal. The money moves on its own.'],
            ].map(([n, h, t]) => (
              <div className="prob" key={n}>
                <span className="bit" style={{ fontSize: 16 }}>{n}</span>
                <div>
                  <div className="n">{h}</div>
                  <div style={{ fontSize: 14, color: 'var(--beige)' }}>{t}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="sec gut">
        <div className="wrap cta-end">
          <h2 className="rv" style={{ color: 'var(--white)' }}>
            Lock the money. <span className="g" style={{ color: 'var(--beige-70)' }}>Let the promises pay.</span>
          </h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <ButtonLink size="big" href="#new">
              Start a deal <Icon name="arrow" />
            </ButtonLink>
            <ButtonLink size="big" variant="sec" href="#dashboard" style={{ color: 'var(--white)' }}>
              Go to dashboard
            </ButtonLink>
          </div>
        </div>
      </section>
    </section>
  )
}
