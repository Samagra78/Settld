import { lazy, Suspense, useEffect } from 'react'
import { AppBar } from '../components/AppBar'
import { AuthGate } from '../components/AuthGate'
import { IconSprite } from '../components/Icon'
import { FlowProvider } from '../components/flow/FlowProvider'
import { restoreSession, startClocks } from '../data/store'
import { useRoute, type RouteId } from './router'
import { useReveal } from './useReveal'
import { useParallax } from './useParallax'
import { smoothScrollTo, useSmoothScroll } from './smoothScroll'
import { ScrollProgress } from '../components/ScrollProgress'

const PAGES: Record<RouteId, ReturnType<typeof lazy>> = {
  overview: lazy(() => import('../pages/OverviewPage')),
  timeline: lazy(() => import('../pages/TimelinePage')),
  dashboard: lazy(() => import('../pages/DashboardPage')),
  deal: lazy(() => import('../pages/DealPage')),
  new: lazy(() => import('../pages/NewDealPage')),
  court: lazy(() => import('../pages/CourtPage')),
  wallet: lazy(() => import('../pages/WalletPage')),
  signin: lazy(() => import('../pages/SignInPage')),
  signup: lazy(() => import('../pages/SignUpPage')),
}

// Pages that only a signed-in client or freelancer can open. Overview and Timeline are public;
// Arbitrators has its own World ID gate.
const GATED: Partial<Record<RouteId, { eyebrow: string; title: string }>> = {
  dashboard: { eyebrow: 'Dashboard · sign in', title: 'Sign in to see your deals.' },
  deal: { eyebrow: 'Deal · sign in', title: 'Only the two sides of a deal can open it.' },
  new: { eyebrow: 'New deal · sign in', title: 'Sign in to write a deal.' },
  wallet: { eyebrow: 'Wallet · sign in', title: 'Sign in to see your money.' },
}

export default function AppShell() {
  const route = useRoute()
  useEffect(() => startClocks(), [])
  useEffect(() => {
    void restoreSession()
  }, [])
  useSmoothScroll()
  useReveal(route)
  useParallax(route)
  useEffect(() => {
    smoothScrollTo(0, { immediate: true })
  }, [route])
  const Page = PAGES[route]
  return (
    <FlowProvider>
      <IconSprite />
      <ScrollProgress />
      <AppBar route={route} />
      <main>
        <Suspense fallback={<div className="ground" />}>
          {GATED[route] ? (
            <AuthGate key={route} eyebrow={GATED[route].eyebrow} title={GATED[route].title}>
              <Page />
            </AuthGate>
          ) : (
            <Page key={route} />
          )}
        </Suspense>
      </main>
    </FlowProvider>
  )
}
