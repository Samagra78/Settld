import { useCallback, useEffect, useState } from 'react'
import { ButtonLink, Button } from '../components/Button'
import { Card } from '../components/Card'
import { CountUp } from '../components/CountUp'
import { Chip } from '../components/Chip'
import { PageHead } from '../components/Eyebrow'
import { Feed } from '../components/Feed'
import { Icon } from '../components/Icon'
import { useFlow } from '../components/flow/context'
import { go } from '../app/router'
import { MONEY } from '../data/fixtures'
import { fundDeal, refreshBalance, selectDeal, setLiveDeals, useSettld } from '../data/store'
import { getState } from '../data/store'
import { acceptLiveDeal, fetchMyDeals, fundLiveDeal, moneyOf, progressOf, short, waitingOf, type LiveDeal } from '../data/liveDeals'
import type { ActionItem } from '../data/types'
import { fmt } from '../lib/format'

const PROG_COL = ['var(--ink)', 'var(--blue)', 'var(--orange)', 'var(--ciel)', 'var(--ciel)']

/** Signed in for real: the wallet's deals from ClauseEscrow, and what each one is waiting on */
function LiveDealCards() {
  const { flow } = useFlow()
  const [deals, setDeals] = useState<LiveDeal[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    fetchMyDeals().then((d) => { setDeals(d); setLiveDeals(d); setError(null) }).catch((e) => setError((e as Error).message))
  }, [])
  useEffect(() => {
    load()
    const tm = setInterval(load, 15000)
    return () => clearInterval(tm)
  }, [load])

  const todo = (deals ?? []).flatMap((d) => {
    const other = d.role === 'client' ? `Freelancer ${short(d.freelancer)}` : `Client ${short(d.client)}`
    if (d.role === 'freelancer' && !d.accepted)
      return [{ d, title: `Accept deal ${d.dealId} from ${other}`, detail: `${d.clauses.length} promises · ${fmt(Number(d.total))} USDC. Read the No deadlock certificate first.`, cta: 'Accept · PIN',
        run: () => flow({ title: `Accept deal ${d.dealId}`, summary: `You agree to ${d.clauses.length} promises worth ${fmt(Number(d.total))} USDC. Nothing is locked until the client funds it.`, cta: 'Accept · PIN', pin: true, working: 'Accepting the deal', steps: ['Approve with your PIN', 'Recording it on Arc', 'Chainlink certifies the deal'], run: () => acceptLiveDeal(d), done: 'Deal accepted.', next: 'Chainlink certifies it on its own; then the client can fund it.', after: load }) }]
    if (d.role === 'client' && d.accepted && d.certified && !d.funded)
      return [{ d, title: `Fund deal ${d.dealId} with ${other}`, detail: 'Accepted and certified by Chainlink.', cta: `Fund ${fmt(Number(d.total))} USDC`,
        run: () => flow({ title: `Lock ${fmt(Number(d.total))} USDC for deal ${d.dealId}`, summary: 'Two PIN prompts: one lets the safe take the USDC, one locks it. Unpaid promises always come back to you.', cta: 'Confirm & lock', pin: true, working: 'Locking the USDC', steps: ['Allowing the safe to use your USDC', 'Locking the USDC in the safe', 'Waiting for the public record'], run: () => fundLiveDeal(d, getState().balance), done: `${fmt(Number(d.total))} USDC locked.`, next: 'The freelancer can now deliver.', after: () => { load(); void refreshBalance() } }) }]
    return []
  })

  return (
    <>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ fontSize: 22 }}>Needs your action</h3>
          <span className="bit num" style={{ fontSize: 22 }}>{todo.length}</span>
        </div>
        {todo.length ? todo.map((a, i) => (
          <div key={a.d.dealId} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '14px 0', borderTop: '1px solid var(--ink-12)', flexWrap: 'wrap' }}>
            <span className="ok-ic c-need"><Icon name="bang" /></span>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div>{a.title}</div>
              <div className="k mut">{a.detail}</div>
            </div>
            <Button size="sm" variant={i ? 'sec' : 'primary'} onClick={a.run}>{a.cta}</Button>
          </div>
        )) : <p className="k mut" style={{ paddingTop: 12, borderTop: '1px solid var(--ink-12)' }}>Nothing needs you right now.</p>}
      </Card>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ fontSize: 22 }}>My deals</h3>
          <span className="k mut">{deals ? 'Live from Arc' : 'Loading…'}</span>
        </div>
        {error && <p className="k" style={{ color: 'var(--red-text)' }}>{error}</p>}
        {deals && deals.length === 0 && <p className="k mut">No deals yet. <a href="#new">Write your first deal</a>.</p>}
        {deals && deals.length > 0 && (
          <div className="tscroll">
            <table>
              <thead>
                <tr><th>Deal</th><th>With</th><th>Total</th><th>Progress</th><th>Waiting on</th></tr>
              </thead>
              <tbody>
                {deals.map((d) => {
                  const p = progressOf(d)
                  const w = waitingOf(d)
                  return (
                    <tr key={d.dealId} className="row-link" tabIndex={0} onClick={() => { selectDeal(d.dealId); go('deal') }} onKeyDown={(e) => { if (e.key === 'Enter') { selectDeal(d.dealId); go('deal') } }}>
                      <td className="bit" style={{ fontSize: 16 }}>{d.dealId}</td>
                      <td>{d.role === 'client' ? 'Freelancer' : 'Client'} {short(d.role === 'client' ? d.freelancer : d.client)}</td>
                      <td className="num">{fmt(Number(d.total))}</td>
                      <td>
                        <div className="bar8">
                          {p.map((v, k) => (v ? <i key={k} style={{ flex: v, background: PROG_COL[k], opacity: k === 4 ? 0.45 : undefined }} /> : null))}
                        </div>
                        <div className="k mut num" style={{ marginTop: 4 }}>{fmt(p[0])} paid of {fmt(Number(d.total))}</div>
                      </td>
                      <td><Chip kind={w.chip} icon={w.icon}>{w.label}</Chip></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

export default function DashboardPage() {
  const session = useSettld((s) => s.session)
  const liveDeals = useSettld((s) => s.liveDeals)
  const { flow } = useFlow()
  const deals = useSettld((s) => s.deals)
  const actions = useSettld((s) => s.actions)
  const feed = useSettld((s) => s.feed)
  const balance = useSettld((s) => s.balance)

  const act = (a: ActionItem) => {
    if (a.kind === 'view') return go('deal')
    const d = deals.find((x) => x.id === a.dealId)
    if (!d) return
    const amt = d.total.toLocaleString('en-US')
    flow({
      title: `Lock ${amt} USDC for “Client × ${d.who}”`,
      summary: (
        <>
          You’re about to lock <b>{amt} USDC</b> in the safe. You can’t take it back early, but every dollar has a way out: unpaid promises come back to you.
        </>
      ),
      cta: 'Confirm & lock',
      pin: true,
      working: `Locking ${amt} USDC`,
      steps: ['Allowing the safe to use your USDC', 'Locking the USDC in the safe', 'Waiting for the public record · 2 to 5 s', 'Updating your deal'],
      run: () => fundDeal(d.id),
      done: `${amt} USDC locked. ${d.who} has been notified.`,
      next: 'Next: they deliver by 20 Nov.',
    })
  }

  // signed in for real: totals from the wallet's deals on Arc; otherwise the demo numbers
  const lm = session.live ? moneyOf(liveDeals ?? []) : null
  const money: [string, string | null, number][] = [
    ['Locked in deals', 'var(--ciel)', lm ? lm.locked : MONEY.locked],
    [lm && session.role === 'freelancer' ? 'Received' : 'Paid out · 30 d', 'var(--beige)', lm ? (session.role === 'freelancer' ? lm.received : lm.paidOut) : MONEY.paidOut30d],
    ['Frozen in disputes', 'var(--orange)', lm ? lm.frozen : MONEY.frozen],
    ['Available', null, balance],
  ]

  return (
    <section className="view on">
      <div className="ground gut">
        <div className="wrap">
          <PageHead
            eyebrow="Dashboard · signed in as Client"
            title={
              <>
                What needs you first. <span style={{ color: 'var(--beige)' }}>Then money, then deals.</span>
              </>
            }
            aside={
              <ButtonLink href="#new">
                <Icon name="plus" />
                Create deal
              </ButtonLink>
            }
          />
          <div className="grid side-360">
            <div className="grid" style={{ alignContent: 'start' }}>
              {session.live ? <LiveDealCards /> : (<>
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <h3 style={{ fontSize: 22 }}>Needs your action</h3>
                  <span className="bit num" style={{ fontSize: 22 }}>{actions.length}</span>
                </div>
                {actions.map((a, i) => (
                  <div key={a.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '14px 0', borderTop: '1px solid var(--ink-12)', flexWrap: 'wrap' }}>
                    <span className="ok-ic c-need"><Icon name="bang" /></span>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div>{a.title}</div>
                      <div className="k mut">{a.detail}</div>
                    </div>
                    <Button size="sm" variant={i ? 'sec' : 'primary'} onClick={() => act(a)}>
                      {a.cta}
                    </Button>
                  </div>
                ))}
              </Card>
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <h3 style={{ fontSize: 22 }}>My deals</h3>
                  <span className="k mut">Updated just now</span>
                </div>
                <div className="tscroll">
                  <table>
                    <thead>
                      <tr><th>Freelancer</th><th>Total</th><th>Progress</th><th>Waiting on</th><th /></tr>
                    </thead>
                    <tbody>
                      {deals.map((d) => (
                        <tr key={d.id} className="row-link" tabIndex={0} onClick={() => go('deal')} onKeyDown={(e) => e.key === 'Enter' && go('deal')}>
                          <td>
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                              <span className="ava">{d.initial}</span>
                              {d.who}
                            </div>
                          </td>
                          <td className="num">{fmt(d.total)}</td>
                          <td>
                            <div className="bar8">
                              {d.progress.map((v, k) => (v ? <i key={k} style={{ flex: v, background: PROG_COL[k], opacity: k === 4 ? 0.45 : undefined }} /> : null))}
                            </div>
                            <div className="k mut num" style={{ marginTop: 4 }}>
                              {fmt(d.progress[0])} paid of {fmt(d.total)}
                            </div>
                          </td>
                          <td>
                            <Chip kind={d.waiting.chip} icon={d.waiting.icon}>{d.waiting.label}</Chip>
                          </td>
                          <td><Icon name="arrow" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              </>)}
            </div>
            <div className="grid" style={{ alignContent: 'start' }}>
              <Card tone="dark">
                <div className="bit" style={{ fontSize: 18, marginBottom: 14 }}>Money</div>
                <div className="grid g2" style={{ gap: 18 }}>
                  {money.map(([l, c, v]) => (
                    <div key={l}>
                      <div className="k" style={{ color: 'var(--beige-70)' }}>
                        {c && <span style={{ display: 'inline-block', width: 10, height: 10, background: c, borderRadius: '50%' }} />} {l}
                      </div>
                      <div className="num" style={{ fontSize: 28 }}><CountUp value={v} format={fmt} /></div>
                    </div>
                  ))}
                </div>
                <div className="k" style={{ color: 'var(--beige-70)', marginTop: 14 }}>USDC · every number opens its receipts in Wallet.</div>
              </Card>
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <h3 style={{ fontSize: 20 }}>Recent activity</h3>
                  <a href="#wallet" className="k">All activity</a>
                </div>
                {session.live ? <p className="k mut">Your deal activity appears here as it happens: proposals, Chainlink checks and payouts.</p> : <Feed events={feed.slice(0, 5)} />}
              </Card>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
