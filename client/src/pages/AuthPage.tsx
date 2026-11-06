import { useEffect } from 'react'
import { go } from '../app/router'
import { AuthCard } from '../components/AuthGate'
import { PageHead } from '../components/Eyebrow'
import { useSettld } from '../data/store'

/** Shared by #signin and #signup: opens the card on the right tab, then goes to the Dashboard */
export function AuthPage({ mode }: { mode: 'in' | 'up' }) {
  const signedIn = useSettld((s) => s.session.signedIn)
  // already signed in (or just finished): straight to the dashboard
  useEffect(() => {
    if (signedIn) go('dashboard')
  }, [signedIn])
  return (
    <section className="view on">
      <div className="ground gut">
        <div className="wrap">
          <PageHead
            eyebrow={mode === 'in' ? 'Sign in' : 'Sign up'}
            title={mode === 'in' ? 'Welcome back.' : <>Start your first deal <span style={{ color: 'var(--beige)' }}>in a minute.</span></>}
          />
          <AuthCard key={mode} initial={mode} />
        </div>
      </div>
    </section>
  )
}
