import { useEffect, useState } from 'react'
import { go, ROUTES, type RouteId } from '../app/router'
import { signOut, useSettld } from '../data/store'
import { Logo } from './Icon'

export function AppBar({ route }: { route: RouteId }) {
  const session = useSettld((s) => s.session)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 12)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  return (
    <header className={`bar${scrolled ? ' scrolled' : ''}`}>
      <div className="bar-in wrap gut">
        <a className="logo" href="#overview" aria-label="Settld, overview">
          <Logo />
          <span>Settld</span>
        </a>
        <nav className="tabs" aria-label="Sections">
          {ROUTES.filter((r) => !r.private || session.signedIn).map((r) => (
            <a key={r.id} className="tab" href={`#${r.id}`} aria-current={r.id === route ? 'page' : undefined}>
              {r.label}
            </a>
          ))}
        </nav>
        <div className="bar-right">
          <span className="pill net">
            <span className="dot" />
            Arc testnet
          </span>
          {session.signedIn ? (
            <>
              <span className="pill" title={session.email}>
                {session.worldId && <span className="dot" style={{ background: 'var(--orange)', borderRadius: '50%' }} />}
                {session.role === 'client' ? 'Client' : 'Freelancer'}
                {session.worldId ? ' · verified human' : ''}
              </span>
              <button type="button" className="btn sec sm" style={{ color: 'var(--white)' }} onClick={() => { signOut(); go('overview') }}>
                Sign out
              </button>
            </>
          ) : (
            <>
              <a className="btn sec sm" style={{ color: 'var(--white)' }} href="#signin">Sign in</a>
              <a className="btn sm" href="#signup">Sign up</a>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
