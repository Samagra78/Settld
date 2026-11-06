import { useState, type FormEvent } from 'react'
import { getDealStatus, getDealTransaction, type DealAction, type DealStatus } from './api'

const clauseStatuses = ['Pending', 'Submitted', 'Verified', 'Failed', 'Disputed', 'Released', 'Refunded']
const failedStates = new Set(['FAILED', 'DENIED', 'CANCELLED'])
type Notice = { message: string; error?: boolean; explorerUrl?: string }

export default function DealActions({ onAuthorize, onConfirmed }: {
  onAuthorize: (action: DealAction) => Promise<string>
  onConfirmed: () => void
}) {
  const [dealId, setDealId] = useState('')
  const [deal, setDeal] = useState<DealStatus | null>(null)
  const [clauseId, setClauseId] = useState(0)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  async function loadDeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    setDeal(null)
    try {
      setDeal(await getDealStatus(dealId))
      setClauseId(0)
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'Could not load the deal.', error: true })
    } finally {
      setBusy(false)
    }
  }

  async function track(refId: string, explorerUrl?: string) {
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        const tx = await getDealTransaction(refId)
        if (tx?.txHash && /^0x[\da-f]{64}$/i.test(tx.txHash)) {
          explorerUrl = `https://explorer.testnet.arc.io/tx/${tx.txHash}`
          setNotice({ message: 'Broadcast. Waiting for confirmation…', explorerUrl })
        }
        if (tx?.state === 'COMPLETE' && explorerUrl) {
          setPending(null)
          setNotice({ message: 'Confirmed on Arc Testnet.', explorerUrl })
          onConfirmed()
          await getDealStatus(dealId).then(setDeal).catch(() => setDeal(null))
          return
        }
        if (tx && failedStates.has(tx.state)) {
          setPending(null)
          setNotice({ message: tx.errorReason || `Circle marked the transaction ${tx.state.toLowerCase()}.`, error: true, explorerUrl })
          return
        }
        if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
      setNotice({ message: 'The transaction is still pending.', explorerUrl })
    } catch {
      setNotice({ message: 'Transaction submitted. Could not check its status. Try checking again.', error: true, explorerUrl })
    }
  }

  async function run(action: DealAction) {
    if (busy || pending) return
    setBusy(true)
    setNotice({ message: 'Checking the deal and preparing Circle authorization…' })
    try {
      const refId = await onAuthorize(action)
      setPending(refId)
      setNotice({ message: 'Submitted. Waiting for confirmation…' })
      await track(refId)
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'Could not submit the transaction.', error: true })
    } finally {
      setBusy(false)
    }
  }

  const fundBlock = deal && (!deal.accepted ? 'The creator must accept the deal before funding.'
    : !deal.certified ? 'Chainlink must certify the deal before funding.'
    : deal.funded ? 'The deal is already funded.' : null)

  return (
    <section aria-labelledby="deal-actions-heading">
      <h2 id="deal-actions-heading">ClauseEscrow</h2>
      <form onSubmit={(event) => void loadDeal(event)}>
        <label>
          Deal ID{' '}
          <input required inputMode="numeric" pattern="[0-9]+" maxLength={78} value={dealId} disabled={busy || !!pending}
            onChange={(event) => { setDealId(event.target.value); setDeal(null) }} />
        </label>{' '}
        <button disabled={busy || !!pending}>Load deal</button>
      </form>
      {deal && (
        <div>
          <p>{deal.accepted ? 'Accepted' : 'Awaiting acceptance'} · {deal.certified ? 'Certified' : 'Awaiting certification'} · {deal.funded ? 'Funded' : 'Unfunded'}</p>
          {fundBlock && <p>{fundBlock}</p>}
          <button disabled={busy || !!pending || !!fundBlock} onClick={() => void run({ kind: 'fund', dealId })}>
            Fund deal
          </button>
          {deal.clauses.length > 0 && (
            <div>
              <label>
                Clause{' '}
                <select value={clauseId} disabled={busy || !!pending} onChange={(event) => setClauseId(Number(event.target.value))}>
                  {deal.clauses.map(({ status }, id) => (
                    <option key={id} value={id}>{id} · {clauseStatuses[status] ?? 'Unknown'}</option>
                  ))}
                </select>
              </label>{' '}
              <button disabled={busy || !!pending || !deal.funded || deal.clauses[clauseId]?.status !== 2}
                onClick={() => void run({ kind: 'release', dealId, clauseId })}>
                Release clause
              </button>
            </div>
          )}
        </div>
      )}
      {notice && (
        <aside className="escrow-notice" aria-label="Escrow status">
          <p role={notice.error ? 'alert' : 'status'}>{notice.message}</p>
          {notice.explorerUrl && <p><a href={notice.explorerUrl} target="_blank" rel="noreferrer">View on Arc Explorer</a></p>}
          {!busy && (pending ? (
            <button onClick={() => {
              setBusy(true)
              void track(pending, notice.explorerUrl).finally(() => setBusy(false))
            }}>Check status again</button>
          ) : (
            <button onClick={() => setNotice(null)}>Close</button>
          ))}
        </aside>
      )}
    </section>
  )
}
