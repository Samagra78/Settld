import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { CountUp } from '../components/CountUp'
import { Chip } from '../components/Chip'
import { PageHead } from '../components/Eyebrow'
import { Notifications } from '../components/Feed'
import { Icon } from '../components/Icon'
import { useFlow } from '../components/flow/context'
import { ACCOUNT, COIN_STACKS, MONEY, NOTIFICATIONS } from '../data/fixtures'
import { addTestUsdc, getState, loadHistory, sendUsdc, useSettld } from '../data/store'
import { freelancerAddressProblem } from '../lib/address'
import type { PaymentKind } from '../data/types'
import { fmt, inr } from '../lib/format'
import Settld3D from '../three/settld3d'
import type { CoinsController } from '../three/settld3d'
import { useScene } from '../three/useScene'

const FILTERS: [PaymentKind | 'all', string][] = [['all', 'All'], ['received', 'Received'], ['paid', 'Paid'], ['locked', 'Locked'], ['returned', 'Returned']]

export default function WalletPage() {
  const { flow, toast } = useFlow()
  const balance = useSettld((s) => s.balance)
  const payments = useSettld((s) => s.payments)
  const session = useSettld((s) => s.session)
  // signed in: the table shows this wallet's real transactions, each with its receipt on Arc's explorer
  useEffect(() => { if (session.live) void loadHistory().catch(() => {}) }, [session.live, session.address])
  const [copied, setCopied] = useState(false)
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(session.address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      toast(<><Icon name="bang" /> Couldn’t copy. Select the address and copy it by hand.</>)
    }
  }
  const [wf, setWf] = useState<PaymentKind | 'all'>('all')
  const [adding, setAdding] = useState(false)
  const [coinInfo, setCoinInfo] = useState('Drag to turn · click a stack to filter the list')
  const cv = useRef<HTMLCanvasElement>(null)
  const labels = useRef<HTMLDivElement>(null)

  const scene = useScene<CoinsController>(cv, (c) =>
    Settld3D.coins(c, {
      stacks: COIN_STACKS.map(({ id, paid, locked }) => ({ id, paid, locked })),
      labels: labels.current,
      camR: 3.0,
      camY: 0.36,
      onPick: (id) => {
        const st = COIN_STACKS.find((s) => s.id === id)
        if (st) {
          setWf(st.filter)
          setCoinInfo('List filtered · click the All filter to reset')
        }
      },
    }),
  )

  const addFunds = async () => {
    setAdding(true)
    try {
      const added = await addTestUsdc()
      toast(<><Icon name="check" /> {fmt(added)} USDC added. Test money, not real dollars.</>)
    } catch (e) {
      toast(<><Icon name="bang" /> {(e as Error).message}</>)
    } finally {
      setAdding(false)
    }
  }

  const send = () =>
    flow({
      kicker: 'Send USDC', title: 'Send test USDC', summary: 'Moves USDC from your wallet to a wallet address on Arc. Transfers can’t be undone, so check the address.',
      cta: 'Send · PIN', pin: true,
      fields: [
        { id: 'to', label: 'To (0x wallet address)', placeholder: '0x…' },
        { id: 'amt', label: 'Amount', type: 'number', defaultValue: '10', narrow: true },
      ],
      validate: (v) => (freelancerAddressProblem(v.to, getState().session.address) ? 'to' : !(+v.amt > 0 && +v.amt <= getState().balance) ? 'amt' : null),
      working: 'Sending USDC', steps: ['Checking your balance', 'Sending on Arc', 'Waiting for the public record'],
      run: (v) => sendUsdc(v.to.trim(), +v.amt),
      done: 'USDC sent.', next: 'It shows in Payouts & receipts.',
    })

  const rows = payments.filter((p) => wf === 'all' || p.kind === wf)

  return (
    <section className="view on">
      <div className="ground gut">
        <div className="wrap">
          <PageHead eyebrow="Wallet" title="Every number opens its receipt." aside={<Chip style={{ background: 'var(--beige)', color: 'var(--ink)' }}>Test money on Arc Testnet: not real dollars</Chip>} />
          <div className="grid side-380">
            <div className="grid" style={{ alignContent: 'start' }}>
              <Card style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
                <div>
                  <div className="bit" style={{ fontSize: 16 }}>Balance</div>
                  <div className="num" style={{ fontSize: 'clamp(44px,6vw,72px)', lineHeight: 1, marginTop: 8 }}>
                    <CountUp value={balance} format={fmt} /> <span style={{ fontSize: 18 }} className="mut">USDC</span>
                  </div>
                  <div className="k mut num" style={{ marginTop: 6 }}>≈ ₹{inr(balance * ACCOUNT.inrRate)} · 1 USDC ≈ ₹{ACCOUNT.inrRate}</div>
                  {session.address && (
                    <div className="grid" style={{ gap: 6, marginTop: 14 }}>
                      <span className="k mut">Your wallet address · share it so a client can send you a deal</span>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                        <code className="num" style={{ fontSize: 14, background: 'var(--beige)', borderRadius: 4, padding: '6px 8px', overflowWrap: 'anywhere', minWidth: 0 }}>{session.address}</code>
                        <Button size="sm" variant="sec" onClick={copyAddress}>{copied ? <><Icon name="check" />Copied</> : 'Copy'}</Button>
                      </div>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start', maxWidth: 280 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <Button disabled={adding} onClick={addFunds}>{adding ? 'Sending test USDC…' : 'Add test USDC'}</Button>
                    <Button variant="sec" onClick={send}>Send</Button>
                  </div>
                  <span className="k mut">Mock payment: nothing is charged. Testnet USDC is sent to your wallet.</span>
                </div>
              </Card>
              <div className="stage3d" style={{ height: 330 }}>
                <canvas ref={cv} role="img" aria-label="Your money by deal as coin stacks. Solid beige coins are already yours; outlined blue coins are still locked in that deal." />
                <div className="lbls" ref={labels}>
                  {COIN_STACKS.map((s) => (
                    <div key={s.id} className="v3l" data-l={s.id}><span className="v3t"><b>{s.label}</b><br />{s.sub}</span></div>
                  ))}
                </div>
                <div style={{ position: 'absolute', left: 14, top: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="bit" style={{ fontSize: 16 }}>Money by deal</span>
                  <span className="legend"><span><i style={{ background: '#FFE6D0' }} />In your wallet</span><span><i style={{ boxShadow: 'inset 0 0 0 1px #007BFF' }} />Still locked</span></span>
                </div>
                <Button size="sm" style={{ position: 'absolute', right: 12, top: 10 }} onClick={() => { scene.current?.payout('d2', 2); setCoinInfo('Freelancer B · clause 3 paid 500 · two coins moved into your wallet') }}>
                  Preview a payout
                </Button>
                <div className="hint">{coinInfo}</div>
              </div>
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                  <h3 style={{ fontSize: 22 }}>Payouts &amp; receipts</h3>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {FILTERS.map(([k, l]) => (
                      <Button key={k} size="sm" variant={wf === k ? 'primary' : 'sec'} aria-pressed={wf === k} onClick={() => setWf(k)}>{l}</Button>
                    ))}
                  </div>
                </div>
                <div className="tscroll">
                  <table>
                    <thead><tr><th>When</th><th>What</th><th>Who moved it</th><th style={{ textAlign: 'right' }}>Amount</th><th /></tr></thead>
                    <tbody>
                      {rows.length ? rows.map((p) => (
                        <tr key={p.id}>
                          <td className="bit" style={{ fontSize: 16 }}>{p.when}</td>
                          <td>{p.what}</td>
                          <td><span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><span className="ava"><Icon name={p.who.icon} /></span>{p.who.label}</span></td>
                          <td className="num" style={{ textAlign: 'right' }}>{p.amount > 0 ? '+' : '−'}{fmt(Math.abs(p.amount))}</td>
                          <td>{p.href
                            ? <a href={p.href} target="_blank" rel="noreferrer" className="k" title="Open this transaction on Arc's explorer">Receipt</a>
                            : <span className="k mut" title="Demo row: sign in to see your real transactions">Demo</span>}</td>
                        </tr>
                      )) : <tr><td colSpan={5} className="mut">Nothing here yet.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
            <div className="grid" style={{ alignContent: 'start' }}>
              <Card tone="dark" className="grid" style={{ gap: 14 }}>
                <div className="grid g2" style={{ gap: 14 }}>
                  {([['Locked in deals', MONEY.locked], ['Received · 30 d', MONEY.received30d], ['Frozen in disputes', MONEY.frozen], ['Paid by me · 30 d', MONEY.paidOut30d]] as const).map(([l, v]) => (
                    <div key={l}><div className="k" style={{ color: 'var(--beige-70)' }}>{l}</div><div className="num" style={{ fontSize: 26 }}><CountUp value={v} format={fmt} /></div></div>
                  ))}
                </div>
              </Card>
              <Card className="grid" style={{ gap: 8 }}>
                <h3 style={{ fontSize: 20 }}>Notifications</h3>
                <Notifications items={NOTIFICATIONS} />
              </Card>
              <Card className="grid" style={{ gap: 8 }}>
                <h3 style={{ fontSize: 20 }}>Cross-chain payout</h3>
                <p className="k mut">Coming later: receive payouts on another network. Today every payout lands here on Arc.</p>
              </Card>
              <details className="card k">
                <summary style={{ cursor: 'pointer' }}>Show technical details</summary>
                <div className="bit" style={{ marginTop: 10, fontSize: 15, textTransform: 'none', letterSpacing: '.03em', lineHeight: 1.4 }}>Account {session.address || ACCOUNT.address} · {ACCOUNT.network} · USDC {ACCOUNT.usdc}</div>
              </details>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
