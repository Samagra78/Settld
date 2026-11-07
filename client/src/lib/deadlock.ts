// Runs the shared deadlock checker (the same code Chainlink WF0 runs) on a draft deal.
import { checkDeal, CHECK_NAME, NO_DEPENDENCY, type CheckResult } from '../../../shared/checker'
import type { ClauseTerms } from '../../../shared/spec'
import type { DraftPromise } from '../data/types'

export { CHECK_NAME }
export type { CheckResult }

const USDC = 1_000_000n // 6 decimals

const toUnits = (n: number) => BigInt(Math.round((Number.isFinite(n) ? n : 0) * 1e6))

/** Draft promise -> on-chain ClauseTerms (kind 2 Subjective for AI checks, else 0 OneTime) */
export function toTerms(promises: DraftPromise[]): ClauseTerms[] {
  return promises.map((p) => ({
    kind: p.check === 7 ? 2 : 0,
    checkType: p.check,
    param: (p.param ?? '').trim(),
    deadline: BigInt(Math.floor(new Date(`${p.date}T23:59:59+05:30`).getTime() / 1000) || 0),
    amount: toUnits(p.amount),
    dependsOn: p.dep === '' ? NO_DEPENDENCY : Number(p.dep),
    onFail: p.fail === 'rest' ? 1 : 0,
    vestDays: 0,
  }))
}

export function checkDraft(promises: DraftPromise[], total: number): CheckResult {
  try {
    return checkDeal(toTerms(promises), toUnits(total))
  } catch (e) {
    return { valid: false, errors: [(e as Error).message], statesExplored: 0, summary: `Not safe to sign: ${(e as Error).message}`, outcomes: [] }
  }
}

/** checker messages print raw USDC units; show them in dollars */
export const prettyUnits = (msg: string) => msg.replace(/\b(\d{7,})\b/g, (m) => (Number(BigInt(m)) / Number(USDC)).toLocaleString('en-US'))
