import { useMemo, useState, type CSSProperties } from 'react'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { Certificate } from '../components/Certificate'
import { PageHead } from '../components/Eyebrow'
import { Icon } from '../components/Icon'
import { useFlow } from '../components/flow/context'
import { CHECKS, MAX_PROMISES, TEMPLATES } from '../data/fixtures'
import { freelancerAddressProblem } from '../lib/address'
import { go } from '../app/router'
import { proposeLive } from '../data/liveDeals'
import { proposeDeal, selectDeal, updateDraft, useSettld, type Draft } from '../data/store'
import type { CheckTypeId, DraftPromise } from '../data/types'
import { checkDraft, toTerms } from '../lib/deadlock'
import { fmt } from '../lib/format'

const info = (c: CheckTypeId) => CHECKS.find((x) => x.check === c)!

function Lanes({ draft }: { draft: Draft }) {
  const tot = draft.total || 0
  const sum = draft.promises.reduce((a, c) => a + c.amount, 0)
  const left = Math.max(0, tot - sum)
  const unit = Math.max(25, Math.ceil(Math.max(tot, sum) / 20 / 25) * 25)
  const lane = (key: string, amt: number, col: string, label: string, n: string, gap?: boolean) => (
    <div key={key} className={`lane${gap ? ' gap' : ''}`} style={{ '--lc': col } as CSSProperties}>
      <div className="coins">
        {Array.from({ length: Math.min(20, Math.max(amt > 0 ? 1 : 0, Math.round(amt / unit))) }, (_, k) => (
          <i key={k} className="coin" style={{ animationDelay: `${k * 18}ms` }} />
        ))}
      </div>
      <span className="la num">{amt}</span>
      <span className="lt">
        {n}
        <br />
        {label}
      </span>
    </div>
  )
  return (
    <div className="lanes" aria-label="Each promise gets its own lane of coins">
      {draft.promises.map((c, i) => lane(`p${i}`, c.amount, info(c.check).color, info(c.check).label, `C${i}`))}
      {left > 0 && lane('left', left, 'var(--orange)', 'no promise yet', 'Unassigned', true)}
    </div>
  )
}

export default function NewDealPage() {
  const { flow } = useFlow()
  const draft = useSettld((s) => s.draft)
  const [savedNote, setSavedNote] = useState('Draft saved just now')
  const result = useMemo(() => checkDraft(draft.promises, draft.total), [draft.promises, draft.total])
  const sum = draft.promises.reduce((a, c) => a + c.amount, 0)
  const left = draft.total - sum
  const canPropose = result.valid

  const edit = (fn: (d: Draft) => Draft) => {
    updateDraft(fn)
    setSavedNote('Draft saved just now')
  }
  const setP = (i: number, patch: Partial<DraftPromise>) =>
    edit((d) => ({ ...d, promises: d.promises.map((p, k) => (k === i ? { ...p, ...patch } : p)) }))

  const steps: [string, string, string][] = [
    ['1', 'Write promises', left === 0 ? 'done' : 'now'],
    ['2', 'No deadlock', result.valid ? 'done' : left === 0 ? 'now' : ''],
    ['3', 'Send to Freelancer', canPropose ? 'now' : ''],
  ]


  // signed in for real: the deal goes on-chain to the freelancer's wallet; otherwise the demo flow
  const live = useSettld((s) => s.session.live)
  const myAddress = useSettld((s) => s.session.address)
  // a real, different wallet: placeholders like 0x…01 pass isAddress but nobody could ever accept the deal
  const addressProblem = live ? freelancerAddressProblem(draft.creatorEmail, myAddress) : null
  const addressOk = !addressProblem
  const propose = () => {
    if (live && !addressOk) {
      document.getElementById('nCreator')?.focus()
      return
    }
    let newId = ''
    flow({
      title: `Propose “Client × Freelancer” · ${fmt(draft.total)} USDC`,
      summary: live
        ? `This only records the terms on Arc: no money moves yet. The deal goes to ${draft.creatorEmail.trim()} with all ${draft.promises.length} promises. You will need ${fmt(draft.total)} USDC in your wallet to fund it after they accept. Circle’s PIN screen shows a blank amount for this step; that is normal.`
        : `Freelancer gets a link with all ${draft.promises.length} promises, amounts and the No deadlock certificate. Nothing is locked until they accept and you fund it.`,
      cta: 'Propose · PIN',
      pin: true,
      working: 'Proposing the deal',
      steps: live
        ? ['Approve with your PIN', 'Recording the exact terms on Arc', 'Reading the new deal number']
        : ['Saving the exact version you both sign', 'Recording it on the public record', `Sending the invite to ${draft.creatorEmail || 'Freelancer'}`],
      run: live
        ? async () => { newId = await proposeLive(draft.creatorEmail.trim(), draft.total, toTerms(draft.promises)) }
        : () => proposeDeal(draft),
      done: live ? 'Deal proposed on Arc.' : 'Deal proposed. Freelancer has the link.',
      next: 'Next: the freelancer reads it and accepts. Chainlink then certifies it on the public record.',
      okLabel: live ? 'Open the deal' : 'Close',
      after: live ? () => { if (newId) selectDeal(newId); go('deal') } : undefined,
    })
  }

  return (
    <section className="view on">
      <div className="ground gut">
        <div className="wrap">
          <PageHead
            eyebrow="New deal"
            title="Write the deal in plain words."
            aside={
              <ol className="csteps" aria-label="Three steps to send a deal">
                {steps.map(([n, l, st]) => (
                  <li key={n} className={st}>
                    <span className="n">{st === 'done' ? <Icon name="check" /> : n}</span>
                    {l}
                  </li>
                ))}
              </ol>
            }
          >
            <span className="k" style={{ color: 'var(--beige)' }}>{savedNote}</span>
          </PageHead>
          <div className="builder">
            <div className="grid" style={{ alignContent: 'start' }}>
              <Card className="grid g2" style={{ gap: 14 }}>
                <div>
                  <label className="f" htmlFor="nCreator">{live ? 'Freelancer’s wallet address' : 'Freelancer’s email'}</label>
                  <input
                    className={`in${live && draft.creatorEmail && !addressOk ? ' field-bad' : ''}`}
                    id="nCreator"
                    placeholder={live ? '0x… (they find it in their Wallet)' : 'freelancer@example.com'}
                    value={draft.creatorEmail}
                    onChange={(e) => edit((d) => ({ ...d, creatorEmail: e.target.value }))}
                  />
                  {live && draft.creatorEmail && addressProblem && <span className="k" style={{ color: 'var(--red-text)' }}>{addressProblem}</span>}
                </div>
                <div>
                  <label className="f" htmlFor="nTotal">Deal total</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input className="in num" id="nTotal" type="number" min={1} value={draft.total} onChange={(e) => edit((d) => ({ ...d, total: Math.max(0, +e.target.value || 0) }))} />
                    <select className="in" style={{ width: 140 }} aria-label="Currency" value={draft.currency} onChange={(e) => edit((d) => ({ ...d, currency: e.target.value }))}>
                      <option>USDC</option>
                    </select>
                  </div>
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <span className="f" style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>Start from a template</span>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {Object.keys(TEMPLATES).map((k) => (
                      <Button key={k} variant="sec" size="sm" onClick={() => edit((d) => ({ ...d, promises: structuredClone(TEMPLATES[k]) }))}>
                        {k}
                      </Button>
                    ))}
                  </div>
                </div>
              </Card>

              <Card className="grid" style={{ gap: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <h3 style={{ fontSize: 22 }}>
                    Promises <span className="mut num">{draft.promises.length} of {MAX_PROMISES}</span>
                  </h3>
                  <Button
                    variant="sec"
                    size="sm"
                    disabled={draft.promises.length >= MAX_PROMISES}
                    title={draft.promises.length >= MAX_PROMISES ? 'A deal can have up to 5 promises' : ''}
                    onClick={() => edit((d) => ({ ...d, promises: [...d.promises, { check: 4, amount: 0, date: '2026-11-30', dep: '', fail: 'all' }] }))}
                  >
                    <Icon name="plus" />
                    Add promise
                  </Button>
                </div>
                <div className="grid">
                  {draft.promises.map((c, i) => {
                    const ci = info(c.check)
                    return (
                      <div key={i} className="cl-card" style={{ '--lc': c.check === 7 ? 'var(--ink)' : ci.color } as CSSProperties}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                          <span className="bit" style={{ fontSize: 18 }}>Promise C{i} · {ci.label}</span>
                          {draft.promises.length > 1 && (
                            <Button
                              variant="sec"
                              size="sm"
                              onClick={() =>
                                edit((d) => {
                                  const ps = d.promises.filter((_, k) => k !== i).map((p) => {
                                    if (p.dep === '') return p
                                    const dep = +p.dep
                                    return { ...p, dep: dep === i ? '' : String(dep > i ? dep - 1 : dep) }
                                  })
                                  return { ...d, promises: ps }
                                })
                              }
                            >
                              Remove
                            </Button>
                          )}
                        </div>
                        <div className="types six" role="group" aria-label={`How promise C${i} is checked`}>
                          {CHECKS.map((t) => (
                            <button key={t.check} type="button" className="ty" aria-pressed={c.check === t.check} onClick={() => setP(i, { check: t.check, param: '' })}>
                              <span className="ti"><Icon name={t.icon} /></span>
                              <span>{t.label}</span>
                              <small>{t.hint}</small>
                            </button>
                          ))}
                        </div>
                        <div className="cl-row">
                          <div>
                            <label className="f" htmlFor={`p${i}`}>{ci.paramLabel}</label>
                            <input className="in" id={`p${i}`} placeholder={ci.paramPlaceholder} value={c.param ?? ''} onChange={(e) => setP(i, { param: e.target.value })} />
                          </div>
                          <div>
                            <label className="f" htmlFor={`a${i}`}>Amount</label>
                            <input className="in num" id={`a${i}`} type="number" min={0} value={c.amount} onChange={(e) => setP(i, { amount: Math.max(0, +e.target.value || 0) })} />
                          </div>
                          <div>
                            <label className="f" htmlFor={`d${i}`}>Deadline (your time, IST)</label>
                            <input className="in" id={`d${i}`} type="date" value={c.date} onChange={(e) => setP(i, { date: e.target.value })} />
                          </div>
                        </div>
                        <div className="cl-row two">
                          <div>
                            <label className="f" htmlFor={`dep${i}`}>Only pays after</label>
                            <select className="in" id={`dep${i}`} value={c.dep} onChange={(e) => setP(i, { dep: e.target.value })}>
                              <option value="">Nothing · pays on its own</option>
                              {draft.promises.map((_, j) => (j === i ? null : <option key={j} value={String(j)}>Promise C{j}</option>))}
                            </select>
                          </div>
                          <div>
                            <label className="f" htmlFor={`fl${i}`}>If it fails</label>
                            <select className="in" id={`fl${i}`} value={c.fail} onChange={(e) => setP(i, { fail: e.target.value as DraftPromise['fail'] })}>
                              <option value="all">Refund all of it to Client</option>
                              <option value="rest">Refund only the unpaid rest</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="total-line" style={{ background: left === 0 ? 'var(--blue)' : 'var(--orange)', color: left === 0 ? 'var(--white)' : 'var(--ink)' }}>
                  <span>
                    <Icon name={left === 0 ? 'check' : 'bang'} /> <b className="num">{fmt(sum)}</b> of <b className="num">{fmt(draft.total)}</b> assigned
                  </span>
                  <span>
                    {left === 0 ? 'Every dollar has a promise.' : left > 0 ? <><b className="num">{fmt(left)}</b> left to assign</> : <><b className="num">{fmt(-left)}</b> too much</>}
                  </span>
                </div>
              </Card>
            </div>

            <div className="grid" style={{ alignContent: 'start' }}>
              <Card tone="dark" className="grid preview" style={{ gap: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                  <span className="bit" style={{ fontSize: 18 }}>Preview · the safe</span>
                  <span className="k" style={{ color: 'var(--beige-70)' }}>what Freelancer will see</span>
                </div>
                <Lanes draft={draft} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, borderTop: '1px solid var(--beige-18)', paddingTop: 10 }}>
                  <span className="k" style={{ color: 'var(--beige-70)' }}>Locked when funded</span>
                  <span className="num" style={{ fontSize: 26 }}>{fmt(draft.total)}</span>
                </div>
              </Card>
              <Card className="grid" style={{ gap: 14 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span className="ok-ic" style={{ background: 'var(--ink)', color: 'var(--white)' }}><Icon name="shield" /></span>
                  <h3 style={{ fontSize: 20 }}>No deadlock certificate</h3>
                </div>
                <p className="k mut">Runs on every edit. We try every way this deal could go and prove every dollar always reaches someone. Freelancer sees the same certificate before accepting.</p>
                <Certificate result={result} />
              </Card>
              <Card className="grid" style={{ gap: 12 }}>
                <h3 style={{ fontSize: 20 }}>Send to Freelancer</h3>
                <p className="k mut">They read every promise and amount before accepting. Nothing is locked until then.</p>
                <Button full disabled={!canPropose || !addressOk} onClick={propose}>Propose deal · PIN</Button>
                <p className="k mut">{!result.valid ? 'Fix the certificate first.' : !addressOk ? 'Add the freelancer’s real wallet address first.' : live ? `Goes to ${draft.creatorEmail.trim()}. They accept from their Dashboard. Nothing is locked yet.` : 'Freelancer gets a link to read and accept. Nothing is locked yet.'}</p>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
