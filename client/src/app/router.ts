import { useSyncExternalStore } from 'react'

// Hash routes, same as the design build (#overview, #how, ...).
// `private` tabs only appear in the bar once a client or freelancer is signed in.
export const ROUTES = [
  { id: 'overview', label: 'Overview', private: false },
  { id: 'timeline', label: 'Timeline', private: false },
  { id: 'dashboard', label: 'Dashboard', private: true },
  { id: 'deal', label: 'Deal', private: true },
  { id: 'new', label: 'New deal', private: true },
  { id: 'wallet', label: 'Wallet', private: true },
  { id: 'court', label: 'Arbitrators', private: false },
] as const

/** Pages reachable by link but not shown as tabs */
export const AUTH_ROUTES = ['signin', 'signup'] as const

export type RouteId = (typeof ROUTES)[number]['id'] | (typeof AUTH_ROUTES)[number]

const read = (): RouteId => {
  let h = window.location.hash.slice(1)
  if (h === 'how') h = 'timeline' // old link
  if ((AUTH_ROUTES as readonly string[]).includes(h)) return h as RouteId
  return (ROUTES.find((r) => r.id === h)?.id ?? 'overview') as RouteId
}

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

export const useRoute = () => useSyncExternalStore(subscribe, read, () => 'overview' as RouteId)

export const go = (r: RouteId) => {
  window.location.hash = `#${r}`
}
