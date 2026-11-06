import { useEffect } from 'react'
import { prefersReducedMotion } from '../lib/motion'

/**
 * Depth effect: any element with data-depth="k" moves k px for every px scrolled, relative to where it
 * sits on screen. Positive k drifts with the page (feels further away), negative k moves against it
 * (feels closer). Kept small. Off under prefers-reduced-motion.
 */
export function useParallax(key: string) {
  useEffect(() => {
    if (prefersReducedMotion()) return
    let raf = 0
    const els = () => Array.from(document.querySelectorAll<HTMLElement>('[data-depth]'))
    const update = () => {
      raf = 0
      const mid = window.innerHeight / 2
      for (const el of els()) {
        const k = Number(el.dataset.depth) || 0
        const r = el.parentElement?.getBoundingClientRect()
        if (!r || r.bottom < -200 || r.top > window.innerHeight + 200) continue
        const off = (r.top + r.height / 2 - mid) * -k
        el.style.transform = `translate3d(0, ${off.toFixed(1)}px, 0)`
      }
    }
    const on = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', on, { passive: true })
    window.addEventListener('resize', on)
    // pages load lazily: place new depth layers as soon as they appear
    const mo = new MutationObserver(() => update())
    mo.observe(document.querySelector('main') ?? document.body, { childList: true, subtree: true })
    return () => {
      mo.disconnect()
      window.removeEventListener('scroll', on)
      window.removeEventListener('resize', on)
      cancelAnimationFrame(raf)
      els().forEach((el) => (el.style.transform = ''))
    }
  }, [key])
}
