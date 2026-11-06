import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { PageHead } from '../components/Eyebrow'
import { Icon } from '../components/Icon'
import { MoneyBar, MoneyKey } from '../components/MoneyBar'
import { MONEY_KEY, SCENES, SCENE_PROMISES } from '../data/fixtures'
import type { PromiseState } from '../data/types'
import Settld3D from '../three/settld3d'
import type { VaultController } from '../three/settld3d'
import { useScene } from '../three/useScene'

function stateAt(i: number) {
  const s: Record<string, PromiseState> = {}
  SCENE_PROMISES.forEach((c) => (s[c.id] = 'locked'))
  for (let k = 0; k <= i; k++) Object.assign(s, SCENES[k].states)
  return s
}

export default function HowPage() {
  const [si, setSi] = useState(0)
  const [playing, setPlaying] = useState(false)
  const cv = useRef<HTMLCanvasElement>(null)
  const labels = useRef<HTMLDivElement>(null)
  const first = useRef(true)

  const scene = useScene<VaultController>(cv, (c) => {
    const st = stateAt(0)
    const v = Settld3D.vault(c, {
      clauses: SCENE_PROMISES.map((p) => ({ id: p.id, amount: p.amount, state: st[p.id] })),
      labels: labels.current,
      chipsPerUnit: 1,
      camR: window.innerWidth < 700 ? 6.2 : 4.2,
      camY: 0.45,
    })
    return v
  })

  // push the scene's promise states into the vault whenever the scene changes
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const st = stateAt(si)
    scene.current?.setClauses(Object.keys(st).map((id) => ({ id, state: st[id], progress: 0.5 })))
  }, [si, scene])

  useEffect(() => {
    if (!playing) return
    const tm = setInterval(() => {
      setSi((x) => {
        if (x >= SCENES.length - 1) {
          setPlaying(false)
          return x
        }
        return x + 1
      })
    }, 3400)
    return () => clearInterval(tm)
  }, [playing])

  const s = SCENES[si]
  const segs = s.money.map((v, i) => ({ label: MONEY_KEY[i][0], value: v, color: MONEY_KEY[i][1] }))

  return (
    <section className="view on">
      <div className="ground gut">
        <div className="wrap">
          <PageHead
            eyebrow="How it works · demo deal"
            title="Client × Freelancer. One video, four promises, 1,000 USDC."
            aside={
              <p style={{ maxWidth: 380, color: 'var(--beige)' }} className="k">
                Step through a whole deal. Every animation is a real event: who did it, what moved, and what happens next. Demo time: 1 day = 1 minute.
              </p>
            }
          />
          <div className="scene-rail" role="list">
            {SCENES.map((x, i) => (
              <button
                key={x.title}
                className={`scn${i < si ? ' done' : ''}`}
                aria-current={i === si ? 'step' : undefined}
                onClick={() => {
                  setPlaying(false)
                  setSi(i)
                }}
              >
                <small>{String(i + 1).padStart(2, '0')}</small>
                <span className="bit">{x.title}</span>
              </button>
            ))}
          </div>
          <div className="theatre">
            <div className="stage3d" style={{ height: 520 }}>
              <canvas ref={cv} role="img" aria-label="The deal safe in 3D, with one lane of coins per promise" />
              <div className="lbls" ref={labels}>
                {SCENE_PROMISES.map((p) => (
                  <div className="v3l" data-l={p.id} key={p.id}>
                    <span className="v3p">
                      <b>{p.label}</b>
                      {p.text}
                    </span>
                  </div>
                ))}
                <div className="v3l" data-l="brand">
                  <span className="v3t"><b>Client</b></span>
                </div>
                <div className="v3l" data-l="creator">
                  <span className="v3t"><b>Freelancer</b></span>
                </div>
              </div>
              <div style={{ position: 'absolute', left: 14, top: 12 }} className="legend">
                <span><i style={{ background: '#007BFF' }} />Locked</span>
                <span><i style={{ background: '#FF5A00' }} />Checking</span>
                <span><i style={{ background: '#2038E2' }} />Verified</span>
                <span><i style={{ background: '#FFE6D0' }} />Paid</span>
                <span><i style={{ background: '#E5251B' }} />Failed</span>
              </div>
              <div className="hint">Drag to turn the safe</div>
            </div>
            <Card className="narr">
              <div className="bit" style={{ fontSize: 16, color: 'var(--ink-62)' }}>
                Scene {si + 1} of {SCENES.length}
              </div>
              <div className="bit" style={{ fontSize: 40 }}>{s.title}</div>
              <p className="line">{s.line}</p>
              <span className="who-tag">
                <Icon name={s.who.icon} /> {s.who.label}
              </span>
              <p className="k mut">{s.next}</p>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span className="bit" style={{ fontSize: 15 }}>Where every dollar is</span>
                  <span className="num">1,000 USDC</span>
                </div>
                <MoneyBar segments={segs} />
                <MoneyKey segments={segs} />
              </div>
              <div className="ctrls">
                <Button variant="sec" size="sm" disabled={si === 0} onClick={() => { setPlaying(false); setSi((x) => Math.max(0, x - 1)) }}>
                  <Icon name="back" />Back
                </Button>
                <Button size="sm" onClick={() => { setPlaying(false); setSi((x) => (x + 1) % SCENES.length) }}>
                  {si === SCENES.length - 1 ? 'Start again' : <>Next scene <Icon name="arrow" /></>}
                </Button>
                <Button
                  variant="sec"
                  size="sm"
                  onClick={() => {
                    if (playing) return setPlaying(false)
                    if (si === SCENES.length - 1) setSi(0)
                    setPlaying(true)
                  }}
                >
                  {playing ? 'Pause' : 'Play all'}
                </Button>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </section>
  )
}
