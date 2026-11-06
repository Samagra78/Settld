import { useEffect, useMemo, useState } from 'react'
import { COURT_RULES, EVIDENCE_NAMES, JUDGES } from '../data/fixtures'
import type { Band, CourtTranscript } from '../data/types'
import { useReducedMotion } from '../lib/motion'
import { verdictLong, verdictShort } from '../lib/verdict'
import { Button } from './Button'
import { Chip } from './Chip'
import { Icon } from './Icon'

/** AI verdict = majority of the judges' final votes (with two choices, 2 of 3 always agree) */
function verdictOf(bands: Band[]): Band {
  const count = new Map<Band, number>()
  bands.forEach((b) => count.set(b, (count.get(b) ?? 0) + 1))
  for (const [b, n] of count) if (n >= 2) return b
  return [...bands].sort((a, b) => a - b)[1]
}


/** One step of the playback: a judge speaking in a round, or a round summary */
type Beat = { round: number; judge: number | null }

function Ring({ used, budget, active }: { used: number; budget: number; active: boolean }) {
  const C = 2 * Math.PI * 26
  const left = Math.max(0, 1 - used / budget)
  return (
    <svg viewBox="0 0 60 60" width="60" height="60" aria-hidden="true" style={{ position: 'absolute', inset: -6 }}>
      <circle cx="30" cy="30" r="26" fill="none" stroke="rgba(26,26,26,.12)" strokeWidth="4" />
      <circle cx="30" cy="30" r="26" fill="none" stroke={active ? '#FF5A00' : '#2038E2'} strokeWidth="4" strokeDasharray={C} strokeDashoffset={C * (1 - left)} transform="rotate(-90 30 30)" style={{ transition: 'stroke-dashoffset .6s' }} />
    </svg>
  )
}

/** The countdown ring: base 3 min, can grow by +60 s per extension, never past the 5 min hard cap */
function Clock({ deadline, elapsed }: { deadline: number; elapsed: number }) {
  const R = 40
  const C = 2 * Math.PI * R
  const cap = COURT_RULES.hardCapSecs
  const capAngle = (deadline / cap) * 360 - 90
  const rad = (capAngle * Math.PI) / 180
  const mm = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <svg viewBox="0 0 100 100" width="96" height="96" role="img" aria-label={`Time used ${mm(elapsed)} of ${mm(deadline)}, hard cap 5:00`}>
        <circle cx="50" cy="50" r={R} fill="none" stroke="rgba(26,26,26,.12)" strokeWidth="8" />
        {/* the allowed time so far (base, plus any extensions) */}
        <circle cx="50" cy="50" r={R} fill="none" stroke="#FFE6D0" strokeWidth="8" strokeDasharray={`${(deadline / cap) * C} ${C}`} transform="rotate(-90 50 50)" />
        <circle cx="50" cy="50" r={R} fill="none" stroke="#2038E2" strokeWidth="8" strokeDasharray={`${(Math.min(elapsed, deadline) / cap) * C} ${C}`} transform="rotate(-90 50 50)" style={{ transition: 'stroke-dasharray .6s' }} />
        {/* fixed hard cap marker at 5:00 (top of the ring) and the current deadline */}
        <line x1="50" y1="2" x2="50" y2="18" stroke="#E5251B" strokeWidth="3" />
        <line x1={50 + Math.cos(rad) * 34} y1={50 + Math.sin(rad) * 34} x2={50 + Math.cos(rad) * 48} y2={50 + Math.sin(rad) * 48} stroke="#FF5A00" strokeWidth="3" />
        <text x="50" y="55" textAnchor="middle" fontSize="16" fontFamily="'Jersey 10', monospace" fill="#1A1A1A">{mm(elapsed)}</text>
      </svg>
      <div className="k">
        <div><span className="bit" style={{ fontSize: 16 }}>{mm(deadline)}</span> <span className="mut">time allowed</span></div>
        <div><span className="bit" style={{ fontSize: 16, color: 'var(--red-text)' }}>5:00</span> <span className="mut">hard cap, never passed</span></div>
      </div>
    </div>
  )
}

/**
 * Plain-language replay of an AI court case: three judges, blind first opinions, then discussion,
 * extensions when 2 of 3 ask, then final votes, the verdict and the money split.
 */
export function JurySim({ transcript, amount, autoplay = true }: { transcript: CourtTranscript; amount: number; autoplay?: boolean }) {
  const reduced = useReducedMotion()
  const beats = useMemo<Beat[]>(() => {
    const out: Beat[] = []
    transcript.rounds.forEach((r) => {
      r.judges.forEach((_, j) => out.push({ round: r.round, judge: j }))
      out.push({ round: r.round, judge: null })
    })
    return out
  }, [transcript])
  const total = beats.length
  const [step, setStep] = useState(reduced || !autoplay ? total : 0)
  const [play, setPlaying] = useState(autoplay && !reduced)
  const playing = play && step < total

  useEffect(() => {
    if (!playing) return
    const tm = setTimeout(() => setStep((s) => s + 1), beats[step]?.judge === null ? 1400 : 2300)
    return () => clearTimeout(tm)
  }, [playing, step, beats])

  const shown = beats.slice(0, step)
  const cur = shown[shown.length - 1]
  const roundIdx = cur ? cur.round : 0
  const round = transcript.rounds[roundIdx]
  const done = step >= total
  // latest statement per judge so far
  const latest = JUDGES.map((_, j) => {
    let last: { round: number; t: (typeof round.judges)[number] } | null = null
    for (const b of shown) if (b.judge === j) last = { round: b.round, t: transcript.rounds[b.round].judges[j] }
    return last
  })
  const finals = transcript.rounds[transcript.rounds.length - 1].judges.map((t) => t.band)
  const verdict = verdictOf(finals)
  const elapsed = Math.min(round.deadline, ((roundIdx + (cur?.judge === null ? 1 : ((cur?.judge ?? 0) + 1) / 4)) / transcript.rounds.length) * round.deadline * 0.92)
  const extensionsSoFar = transcript.rounds.slice(0, roundIdx + 1).filter((r) => r.extensionGranted).length
  const roundLabel = roundIdx === 0 ? 'Round 1 · blind opinions, nobody sees the others yet' : `Round ${roundIdx + 1} · discussion, each judge has read the others`

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div className="grid" style={{ gap: 6 }}>
          <span className="bit" style={{ fontSize: 16, color: 'var(--ink-62)' }}>{done ? 'Verdict' : roundLabel}</span>
          <span className="k mut">Each judge has {COURT_RULES.wordBudget} words. If 2 of 3 ask for more: +{COURT_RULES.extendWords} words, +{COURT_RULES.extendSecs} s. {extensionsSoFar > 0 && <b style={{ fontWeight: 500, color: 'var(--ink)' }}>Extension granted.</b>}</span>
        </div>
        <Clock deadline={round.deadline} elapsed={done ? transcript.rounds[transcript.rounds.length - 1].deadline * 0.9 : elapsed} />
      </div>

      <div className="grid g3">
        {JUDGES.map((jd, j) => {
          const l = latest[j]
          const speaking = cur?.judge === j && !done
          return (
            <div key={jd.name} className="judge" style={speaking ? { borderColor: 'var(--orange)', boxShadow: 'inset 0 0 0 1px var(--orange)' } : undefined}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span style={{ position: 'relative', width: 48, height: 48, flexShrink: 0 }}>
                  <Ring used={l?.t.wordsUsed ?? 0} budget={l ? transcript.rounds[l.round].wordBudget : COURT_RULES.wordBudget} active={speaking} />
                  <span className="ava" style={{ position: 'absolute', inset: 10, width: 28, height: 28, background: speaking ? 'var(--orange)' : 'var(--ink)', color: speaking ? 'var(--ink)' : 'var(--white)' }}>{jd.initial}</span>
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="bit" style={{ fontSize: 18 }}>{jd.name}</div>
                  <div className="k mut">{jd.maker}</div>
                </div>
              </div>
              {l ? (
                <>
                  <p className="k" style={{ background: 'var(--beige)', borderRadius: 6, padding: 10 }} key={`${l.round}-${j}`}>
                    “{l.t.statement}”
                  </p>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    {l.t.cited.map((c) => <span key={c} className="cite">{EVIDENCE_NAMES[c]}</span>)}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Chip kind={l.t.isFinal ? 'paid' : 'pend'} icon={l.t.isFinal ? 'lock' : 'clock'}>{l.t.isFinal ? 'Final' : 'Leaning'} · {verdictShort(l.t.band)}</Chip>
                    {l.t.wantsExtend && !l.t.isFinal && <Chip kind="need" icon="plus">Asks for more time</Chip>}
                  </div>
                  <span className="k mut num">{l.t.wordsUsed} of {transcript.rounds[l.round].wordBudget} words used</span>
                </>
              ) : (
                <p className="k mut">Reading the promise, the work and the complaint…</p>
              )}
            </div>
          )
        })}
      </div>

      {done ? (
        <div className="gate" style={{ background: 'var(--beige)' }}>
          <span className="lockbig" style={{ color: 'var(--orange)' }}><Icon name="hex" /></span>
          <div className="grid" style={{ gap: 10 }}>
            <div className="bit" style={{ fontSize: 28 }}>Verdict · {verdictShort(verdict)}</div>
            <p style={{ fontSize: 17 }}>{verdictLong(verdict, amount)}.</p>
            <p className="k">
              Final votes: {finals.map((b, j) => `${JUDGES[j].name}: ${verdictShort(b).toLowerCase()}`).join(', ')}. The majority decides, and the whole amount goes to one side.
              Chainlink records the result on the public record.
            </p>
          </div>
        </div>
      ) : (
        cur?.judge === null && (
          <div className="k" style={{ background: 'var(--ink)', color: 'var(--white)', borderRadius: 6, padding: 12 }}>
            End of round {roundIdx + 1}.{' '}
            {transcript.rounds[roundIdx + 1]?.extensionGranted ? '2 of 3 judges asked for more time: +100 words and +60 s.' : 'The judges read each other and answer.'}
          </div>
        )
      )}

      <div className="btn-row">
        <Button size="sm" variant="sec" onClick={() => { setStep(0); setPlaying(true) }}><Icon name="replay" />Replay</Button>
        <Button size="sm" variant="sec" disabled={playing || done} onClick={() => setStep((s) => Math.min(total, s + 1))}>Next statement</Button>
        <Button size="sm" variant="sec" disabled={done} onClick={() => { setPlaying(false); setStep(total) }}>Skip to verdict</Button>
      </div>
    </div>
  )
}
