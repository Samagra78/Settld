import { useEffect, useRef, type RefObject } from 'react'
import type { Controller } from './settld3d'

/**
 * Mounts one settld3d scene on a canvas for the life of the page and disposes it on unmount.
 * create() runs once; later changes go through the returned controller ref.
 */
export function useScene<C extends Controller>(canvas: RefObject<HTMLCanvasElement | null>, create: (cv: HTMLCanvasElement) => C) {
  const ctl = useRef<C | null>(null)
  const make = useRef(create)
  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    let c: C | null = null
    try {
      c = make.current(cv)
    } catch (e) {
      console.warn('3D unavailable', e)
    }
    ctl.current = c
    return () => {
      ctl.current = null
      try {
        c?.dispose()
      } catch {
        /* already gone */
      }
    }
  }, [canvas])
  return ctl
}
