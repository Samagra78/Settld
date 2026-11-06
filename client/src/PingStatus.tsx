import { useEffect, useState } from 'react'

const refreshMs = 5_000

type PingView =
  | { status: 'loading' }
  | { status: 'ready'; last: string }
  | { status: 'unavailable'; message: string }

export default function PingStatus() {
  const [ping, setPing] = useState<PingView>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    let nextRefresh: ReturnType<typeof setTimeout> | undefined

    async function refresh() {
      try {
        const response = await fetch('/api/ping', {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(refreshMs)]),
        })
        const data = await response.json().catch(() => null)
        if (controller.signal.aborted) return

        if (response.ok && typeof data?.last === 'string') {
          setPing({ status: 'ready', last: data.last })
        } else {
          setPing({
            status: 'unavailable',
            message: typeof data?.error === 'string' ? data.error : 'Could not read Ping.',
          })
        }
      } catch {
        if (!controller.signal.aborted) {
          setPing({ status: 'unavailable', message: 'Could not reach the Ping service.' })
        }
      } finally {
        if (!controller.signal.aborted) {
          nextRefresh = setTimeout(() => void refresh(), refreshMs)
        }
      }
    }

    void refresh()
    return () => {
      controller.abort()
      clearTimeout(nextRefresh)
    }
  }, [])

  return (
    <section aria-labelledby="ping-heading">
      <h2 id="ping-heading">Chainlink Ping</h2>
      <div aria-live="polite">
        {ping.status === 'loading' && <p>Loading Ping…</p>}
        {ping.status === 'ready' && <p>Last value: <code>{ping.last}</code></p>}
        {ping.status === 'unavailable' && <p>{ping.message}</p>}
      </div>
    </section>
  )
}
