import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../lib/motion'

/**
 * Counts from 0 to `value` the first time it scrolls into view (about 0.9 s, easing out).
 * Later changes count from the old value to the new one. Shows the final value under reduced motion.
 */
export function CountUp({ value, format = (n) => String(Math.round(n)), duration = 900 }: { value: number; format?: (n: number) => string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef(0)
  const started = useRef(false)
  const [text, setText] = useState(() => format(prefersReducedMotion() ? value : 0))

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (prefersReducedMotion()) {
      shown.current = value
      return
    }
    let raf = 0
    const run = () => {
      started.current = true
      const from = shown.current
      const t0 = performance.now()
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / duration)
        const v = from + (value - from) * (1 - Math.pow(1 - k, 3))
        shown.current = v
        setText(format(v))
        if (k < 1) raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    }
    if (started.current) {
      run()
      return () => cancelAnimationFrame(raf)
    }
    const io = new IntersectionObserver(
      (en) => {
        if (en[0].isIntersecting) {
          io.disconnect()
          run()
        }
      },
      { threshold: 0.4 },
    )
    io.observe(el)
    // failsafe: if the observer is late, start once the number is on screen
    const safety = setInterval(() => {
      const r = el.getBoundingClientRect()
      if (!started.current && r.top < window.innerHeight && r.bottom > 0) {
        io.disconnect()
        run()
      }
      if (started.current) clearInterval(safety)
    }, 1200)
    return () => {
      clearInterval(safety)
      io.disconnect()
      cancelAnimationFrame(raf)
    }
    // format is a stable formatter at every call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration])

  return (
    <span ref={ref} className="num">
      {prefersReducedMotion() ? format(value) : text}
    </span>
  )
}
