import type { CheckResult } from '../lib/deadlock'
import { prettyUnits } from '../lib/deadlock'
import { Icon } from './Icon'

/**
 * The "No deadlock" certificate. Shown to everyone before anyone signs.
 * certifiedTx: once Chainlink WF0 certified the deal on-chain, link to that transaction.
 */
export function Certificate({ result, certifiedTx, explorer }: { result: CheckResult; certifiedTx?: string; explorer?: string }) {
  const ok = result.valid
  return (
    <div className="grid" style={{ gap: 10 }} aria-live="polite">
      {ok ? (
        <div className="k" style={{ background: 'var(--blue)', color: 'var(--white)', padding: 12, borderRadius: 6, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Icon name="shield" />
          <span>
            <b style={{ fontWeight: 500 }}>{certifiedTx ? 'Certified by Chainlink' : 'No deadlock'}</b> · {prettyUnits(result.summary)}
            {certifiedTx && explorer && (
              <>
                {' '}
                <a href={`${explorer}/tx/${certifiedTx}`} target="_blank" rel="noreferrer">
                  View the certificate
                </a>
              </>
            )}
          </span>
        </div>
      ) : (
        <div className="k" style={{ background: 'var(--white)', color: 'var(--red-text)', boxShadow: 'inset 0 0 0 1px var(--red)', padding: 12, borderRadius: 6, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Icon name="cross" />
          <span>
            <b style={{ fontWeight: 500 }}>Money could get stuck.</b> {prettyUnits(result.errors[0] ?? result.summary)}
          </span>
        </div>
      )}
      {ok && result.outcomes.length > 0 && <Outcomes result={result} />}
    </div>
  )
}

/** Small diagram: each clause -> Paid / Refunded, with "depends on" arrows */
function Outcomes({ result }: { result: CheckResult }) {
  return (
    <div className="grid" style={{ gap: 6 }}>
      {result.outcomes.map((o) => (
        <div key={o.clause} style={{ display: 'grid', gridTemplateColumns: '34px minmax(0,1fr) auto', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <span className="bit" style={{ fontSize: 18 }}>C{o.clause}</span>
          <span className="mut" style={{ minWidth: 0 }}>
            {o.dependsOn !== null && (
              <>
                <Icon name="back" /> depends on C{o.dependsOn} ·{' '}
              </>
            )}
            {o.check}
          </span>
          <span style={{ display: 'flex', gap: 4 }}>
            {o.canBePaid && <span className="chip c-paid">Paid</span>}
            {o.canBeRefunded && <span className="chip c-locked">Refunded</span>}
          </span>
        </div>
      ))}
      <div className="k mut">Checked {result.statesExplored} possible states.</div>
    </div>
  )
}
