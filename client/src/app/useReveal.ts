import { useLayoutEffect } from 'react'
import { prefersReducedMotion } from '../lib/motion'

// Scroll reveals: content slides up into place as it enters the viewport, siblings staggered.
// It works in every browser (no scroll-timeline needed), is skipped under prefers-reduced-motion,
// and each element animates only the first time it enters.
const TARGETS = [
  '.rv',
  '.rv2 > *',
  '.ground .page-head',
  '.ground .card',
  '.ground .stage3d',
  '.ground .clause',
  '.ground .stats',
  '.ground ol > li',
  'section.sec h2',
].join(',')

export function useReveal(key: string) {
  useLayoutEffect(() => {
    if (prefersReducedMotion() || !('IntersectionObserver' in window)) return
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return
          e.target.classList.add('in')
          // after the entrance, drop the stagger delay so hover effects respond instantly
          setTimeout(() => e.target.classList.add('settled'), 1300)
          io.unobserve(e.target)
        })
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    )
    const seen = new WeakSet<Element>()
    const scan = () => {
      document.querySelectorAll(TARGETS).forEach((el) => {
        if (seen.has(el)) return
        seen.add(el)
        const i = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0
        ;(el as HTMLElement).style.setProperty('--rv-d', `${Math.min(i, 6) * 70}ms`)
        el.classList.add('rvx')
        io.observe(el)
      })
    }
    scan()
    // pages load lazily and re-render, so pick up new elements as they appear
    const mo = new MutationObserver(scan)
    mo.observe(document.querySelector('main') ?? document.body, { childList: true, subtree: true })
    // failsafe: if the observer is ever late (background tab, odd layout), never leave content hidden
    const safety = setInterval(() => {
      document.querySelectorAll('.rvx:not(.in)').forEach((el) => {
        if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('in', 'settled')
      })
    }, 1500)
    return () => {
      clearInterval(safety)
      mo.disconnect()
      io.disconnect()
    }
  }, [key])
}
