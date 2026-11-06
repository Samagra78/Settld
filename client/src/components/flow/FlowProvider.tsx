import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../Icon'
import { prefersReducedMotion } from '../../lib/motion'
import { FlowContext, type FlowOptions } from './context'
import { sessionEnded } from '../../data/store'

type Phase = { kind: 'confirm' } | { kind: 'working'; step: number; times: string[] } | { kind: 'done' } | { kind: 'error'; message: string }

export function FlowProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<FlowOptions | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'confirm' })
  const [values, setValues] = useState<Record<string, string>>({})
  const [bad, setBad] = useState<string | null>(null)
  const [toastNode, setToastNode] = useState<ReactNode>(null)
  const toastTm = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const goRef = useRef<HTMLButtonElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  const busy = phase.kind === 'working'

  const toast = useCallback((content: ReactNode) => {
    setToastNode(content)
    clearTimeout(toastTm.current)
    toastTm.current = setTimeout(() => setToastNode(null), 4200)
  }, [])

  const flow = useCallback((o: FlowOptions) => {
    setOpts(o)
    setPhase({ kind: 'confirm' })
    setBad(null)
    setValues(Object.fromEntries((o.fields ?? []).map((f) => [f.id, f.defaultValue ?? ''])))
  }, [])

  const close = useCallback(() => setOpts(null), [])

  useEffect(() => {
    if (!opts) return
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) close()
    }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [opts, busy, close])

  useEffect(() => {
    if (phase.kind === 'confirm') goRef.current?.focus()
    if (phase.kind === 'done') okRef.current?.focus()
  }, [phase.kind, opts])

  const start = async () => {
    if (!opts) return
    const wrong = opts.validate?.(values) ?? null
    if (wrong) {
      setBad(wrong)
      document.getElementById(`fl-${wrong}`)?.focus()
      return
    }
    const t0 = Date.now()
    const gap = prefersReducedMotion() ? 250 : 900
    const times: string[] = []
    setPhase({ kind: 'working', step: 0, times: [] })
    const work = opts.run ? opts.run(values) : Promise.resolve()
    let failed: unknown = null
    let finished = false
    work.then(() => (finished = true), (e) => { failed = e; finished = true })
    const stamp = (i: number) => (times[i] = `0:${String(Math.round((Date.now() - t0) / 1000)).padStart(2, '0')}`)
    // steps tick on a timer, but the last one only ticks once the real work is done, and a failure stops the ticks
    for (let i = 0; i < opts.steps.length - 1 && !failed; i++) {
      await new Promise((r) => setTimeout(r, gap))
      if (failed) break
      stamp(i)
      setPhase({ kind: 'working', step: i + 1, times: [...times] })
    }
    while (!finished) await new Promise((r) => setTimeout(r, 150))
    if (failed) {
      const err = failed as Error & { status?: number }
      // the server no longer knows this session (it restarted or the session expired)
      const expired = err.status === 401 || /not signed in/i.test(err.message)
      const message = expired ? 'Your session ended (the server restarted). Sign in again; your draft is kept.' : err.message || 'Something went wrong.'
      if (expired) sessionEnded()
      setPhase({ kind: 'error', message })
      toast(
        <>
          <Icon name="bang" /> {message}
        </>,
      )
      return
    }
    stamp(opts.steps.length - 1)
    setPhase({ kind: 'working', step: opts.steps.length, times: [...times] })
    await new Promise((r) => setTimeout(r, gap))
    setPhase({ kind: 'done' })
    opts.after?.(values)
    toast(
      <>
        <Icon name="check" /> {opts.done}
      </>,
    )
  }

  const api = useMemo(() => ({ flow, toast }), [flow, toast])
  const o = opts

  return (
    <FlowContext.Provider value={api}>
      {children}
      <div className="scrim" hidden={!o} onClick={(e) => e.target === e.currentTarget && !busy && close()}>
        {o && (
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="shTitle" key={phase.kind}>
            {phase.kind === 'confirm' && (
              <>
                <div className="bit" style={{ fontSize: 15, color: 'var(--ink-62)' }}>
                  {o.kicker || 'Confirm'}
                </div>
                <h3 id="shTitle">{o.title}</h3>
                <p style={{ fontSize: 15 }}>{o.summary}</p>
                {o.fields && (
                  <div className={o.fields.some((f) => f.narrow) ? 'send-row' : undefined}>
                    {o.fields.map((f) => (
                      <div key={f.id}>
                        <label className="f" htmlFor={`fl-${f.id}`}>
                          {f.label}
                        </label>
                        <input
                          className={`in${f.type === 'number' ? ' num' : ''}${bad === f.id ? ' field-bad' : ''}`}
                          id={`fl-${f.id}`}
                          type={f.type ?? 'text'}
                          placeholder={f.placeholder}
                          value={values[f.id] ?? ''}
                          onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {o.pin && <div className="k mut">Circle will ask you to approve with your PIN.</div>}
                {o.fee !== false && <div className="k mut">Network fee ≈ $0.01, paid in USDC.</div>}
                <div className="btn-row">
                  <button className="btn" ref={goRef} onClick={start}>
                    {o.cta}
                  </button>
                  <button className="btn sec" onClick={close}>
                    Cancel
                  </button>
                </div>
              </>
            )}
            {phase.kind === 'working' && (
              <>
                <div className="bit" style={{ fontSize: 15, color: 'var(--ink-62)' }}>
                  Working · don’t close this
                </div>
                <h3 id="shTitle">{o.working}</h3>
                {o.pin && (
                  <div className="pin" aria-label="Circle PIN">
                    <i />
                    <i />
                    <i />
                    <i className="e" />
                    <i className="e" />
                    <i className="e" />
                  </div>
                )}
                <div className="wsteps">
                  {o.steps.map((s, j) => (
                    <div key={s} className={`wstep${j < phase.step ? ' ok' : j === phase.step ? ' run' : ''}`}>
                      <span className="st">{j < phase.step && <Icon name="check" />}</span>
                      <span>{s}</span>
                      <span className="tm">{phase.times[j] ?? ''}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {phase.kind === 'done' && (
              <>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span className="ok-ic c-ver">
                    <Icon name="check" />
                  </span>
                  <span className="bit" style={{ fontSize: 16 }}>
                    Done
                  </span>
                </div>
                <h3 id="shTitle">{o.done}</h3>
                <p className="k mut">{o.next || ''}</p>
                <div className="btn-row">
                  <button className="btn" ref={okRef} onClick={close}>
                    {o.okLabel || 'Close'}
                  </button>
                  {o.receipt !== false && (
                    <a className="btn sec" href="#wallet" onClick={close}>
                      View receipt
                    </a>
                  )}
                </div>
              </>
            )}
            {phase.kind === 'error' && (
              <>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span className="ok-ic c-fail">
                    <Icon name="cross" />
                  </span>
                  <span className="bit" style={{ fontSize: 16 }}>
                    Didn’t go through
                  </span>
                </div>
                <h3 id="shTitle">{o.title}</h3>
                <p className="k" style={{ color: 'var(--red-text)' }}>
                  {phase.message}
                </p>
                <div className="btn-row">
                  <button className="btn" onClick={() => setPhase({ kind: 'confirm' })}>
                    Try again
                  </button>
                  <button className="btn sec" onClick={close}>
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <div className="toast" role="status" hidden={!toastNode}>
        {toastNode}
      </div>
    </FlowContext.Provider>
  )
}
