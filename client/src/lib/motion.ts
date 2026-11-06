import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(QUERY).matches

function subscribe(cb: () => void) {
  const mq = window.matchMedia?.(QUERY)
  mq?.addEventListener('change', cb)
  return () => mq?.removeEventListener('change', cb)
}

/** Live prefers-reduced-motion flag */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false)
}
