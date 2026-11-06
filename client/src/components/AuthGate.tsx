import { useState, type ReactNode } from 'react'
import { signInParty, useSettld, type Session } from '../data/store'
import { Button } from './Button'
import { Card } from './Card'
import { PageHead } from './Eyebrow'
import { Icon } from './Icon'
import { useFlow } from './flow/context'

/** Sign in / sign up for clients and freelancers. Renders children once signed in. */
export function AuthGate({ children, eyebrow, title }: { children: ReactNode; eyebrow: string; title: ReactNode }) {
  const signedIn = useSettld((s) => s.session.signedIn)
  const checking = useSettld((s) => s.session.checking)
  if (signedIn) return <>{children}</>
  // still checking for an existing session: show the empty ground instead of flashing the sign-in form
  if (checking) return <section className="view on"><div className="ground" /></section>
  return (
    <section className="view on">
      <div className="ground gut">
        <div className="wrap">
          <PageHead eyebrow={eyebrow} title={title} />
          <AuthCard />
        </div>
      </div>
    </section>
  )
}

export function AuthCard({ after, initial = 'in' }: { after?: () => void; initial?: 'in' | 'up' }) {
  const { toast } = useFlow()
  const [mode, setMode] = useState<'in' | 'up'>(initial)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Session['role']>('client')
  const [bad, setBad] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null)

  // Real sign-in. Circle shows its own windows for the 6-digit code and (first time) the PIN,
  // so this runs inline instead of inside our modal.
  const go = async () => {
    const e = email.trim()
    if (!/.+@.+\..+/.test(e)) {
      setBad(true)
      document.getElementById('auth-email')?.focus()
      return
    }
    setBusy(true)
    setStatus({ text: 'Sending a 6-digit code to your email. Enter it in the Circle window that opens.' })
    try {
      await signInParty(e, role)
      setStatus({ text: 'Signed in.' })
      toast(<><Icon name="check" /> {mode === 'in' ? 'You’re signed in.' : 'Your account and wallet are ready.'}</>)
      after?.()
    } catch (err) {
      setStatus({ text: (err as Error).message || 'Sign-in didn’t go through. Try again.', error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid side-360">
      <Card className="grid" style={{ gap: 16 }}>
        <div className="btn-row" role="tablist" aria-label="Sign in or sign up">
          <Button size="sm" variant={mode === 'in' ? 'primary' : 'sec'} role="tab" aria-selected={mode === 'in'} onClick={() => setMode('in')}>Sign in</Button>
          <Button size="sm" variant={mode === 'up' ? 'primary' : 'sec'} role="tab" aria-selected={mode === 'up'} onClick={() => setMode('up')}>Sign up</Button>
        </div>
        <div>
          <label className="f" htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            className={`in${bad ? ' field-bad' : ''}`}
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setBad(false) }}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
        </div>
        <div>
          <span className="f" style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>I’m here as</span>
          <div className="grid g2" role="radiogroup" aria-label="I am here as">
            {([['client', 'Client', 'I pay for work'], ['freelancer', 'Freelancer', 'I deliver work']] as const).map(([v, t, d]) => (
              <button key={v} type="button" className="opt" role="radio" aria-checked={role === v} onClick={() => setRole(v)}>
                <span className="rad" />
                <span><span style={{ display: 'block' }}>{t}</span><span className="k mut">{d}</span></span>
              </button>
            ))}
          </div>
        </div>
        <div className="btn-row">
          <Button onClick={go} disabled={busy}>{busy ? 'Waiting for your code…' : mode === 'in' ? 'Sign in with email' : 'Create account'}</Button>
        </div>
        {status && (
          <p className="k" role="status" style={{ color: status.error ? 'var(--red-text)' : 'var(--ink-62)' }}>{status.text}</p>
        )}
        <p className="k mut">{mode === 'up' ? 'New here? After the code you choose a 6-digit PIN. It approves every payment from your wallet.' : 'No password. We email you a 6-digit code.'}</p>
        <p className="k mut">World ID comes after you sign in: verify you’re a unique human from the Court page. It’s linked to your wallet, so it can’t replace the email sign-in.</p>
      </Card>
      <Card tone="dark" className="grid" style={{ gap: 10 }}>
        <span className="bit" style={{ fontSize: 18 }}>Why sign in</span>
        <p className="k" style={{ color: 'var(--beige-70)' }}>Your deals, your money and your timeline are private to you and the other side of each deal.</p>
        <p className="k" style={{ color: 'var(--beige-70)' }}>Payments are approved with a PIN in your own Circle wallet. Settld can never move your money.</p>
      </Card>
    </div>
  )
}
