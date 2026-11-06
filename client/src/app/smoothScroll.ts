import Lenis from 'lenis'
import 'lenis/dist/lenis.css'
import { useEffect } from 'react'
import { prefersReducedMotion } from '../lib/motion'

// Smooth, slightly inertial scrolling for the whole page (Lenis). Off under prefers-reduced-motion,
// where the browser's normal scrolling is used instead.
let lenis: Lenis | null = null

export function useSmoothScroll() {
  useEffect(() => {
    if (prefersReducedMotion()) return
    const l = new Lenis({ lerp: 0.09, smoothWheel: true, wheelMultiplier: 0.9, touchMultiplier: 1.2 })
    lenis = l
    let raf = requestAnimationFrame(function frame(t) {
      l.raf(t)
      raf = requestAnimationFrame(frame)
    })
    return () => {
      cancelAnimationFrame(raf)
      l.destroy()
      lenis = null
    }
  }, [])
}

/** Glide to an element or a y position (jumps instantly when reduced motion is on) */
export function smoothScrollTo(target: HTMLElement | number, opts: { offset?: number; immediate?: boolean } = {}) {
  const offset = opts.offset ?? -80
  if (lenis) {
    lenis.scrollTo(target, { offset: typeof target === 'number' ? 0 : offset, immediate: opts.immediate, duration: 0.9 })
    return
  }
  const y = typeof target === 'number' ? target : target.getBoundingClientRect().top + window.scrollY + offset
  window.scrollTo({ top: y, behavior: 'auto' })
}
