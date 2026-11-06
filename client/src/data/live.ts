// Live reads from the Express server (proxied as /api). Each call returns the server's answer, or the
// matching fixture when there is no signed-in session or the server is not running, so every page
// works offline for the demo and switches to live data on its own once the backend answers.
import { API } from '../lib/apiBase'
import { useEffect, useState } from 'react'
import * as F from './fixtures'
import type { ArbitratorDashboard, ArbitratorMe, AutomationStatus, CourtCaseResponse, CourtStatus, OpenCase } from './types'

export type Source = 'live' | 'demo'
export type Loaded<T> = { data: T; source: Source; error?: string }

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { credentials: 'include', headers: { accept: 'application/json' } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error((body as { message?: string }).message || `HTTP ${r.status}`), { status: r.status })
  return body as T
}

async function liveOr<T>(path: string, fallback: T): Promise<Loaded<T>> {
  try {
    return { data: await getJson<T>(path), source: 'live' }
  } catch (e) {
    return { data: fallback, source: 'demo', error: (e as Error).message }
  }
}

export const api = {
  automation: () => liveOr<AutomationStatus>('/automation/status', { enabled: false, running: null, queued: [], recent: [] }),
  courtCase: (caseId: string) =>
    liveOr<CourtCaseResponse>(`/court/${caseId}`, { caseId, transcriptHash: '0x', transcript: F.COURT_TRANSCRIPT }),
  courtStatus: (caseId: string) =>
    liveOr<CourtStatus>(`/court/${caseId}/status`, {
      caseId, aiVerdict: 100, appealDeadline: null, canAppeal: true, appealFeeUnits: String(F.CASE_META.appealFee * 1e6),
      appealed: false, finalized: false, finalBand: null, byHumans: false,
    }),
  arbitratorMe: () => liveOr<ArbitratorMe>('/arbitrator/me', { wallet: '', verified: false, arbitrator: false, canAccessCourt: false }),
  arbitratorDashboard: () => liveOr<ArbitratorDashboard>('/arbitrator/dashboard', F.ARB_DASHBOARD),
  arbitratorCases: () => liveOr<{ cases: OpenCase[] }>('/arbitrator/cases', { cases: F.OPEN_CASES }),
}

/** Loads once on mount (and every `pollMs` if given). Returns null until the first answer. */
export function useLive<T>(load: () => Promise<Loaded<T>>, pollMs?: number): Loaded<T> | null {
  const [v, setV] = useState<Loaded<T> | null>(null)
  useEffect(() => {
    let alive = true
    const run = () => load().then((x) => alive && setV(x))
    run()
    const tm = pollMs ? setInterval(run, pollMs) : undefined
    return () => {
      alive = false
      clearInterval(tm)
    }
    // load is a stable api.* reference at every call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs])
  return v
}

/** USDC units (6 decimals) to a number */
export const units = (u: string | number) => Number(u) / 1e6
