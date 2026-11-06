import { useState, type FormEvent } from 'react'
import CreateDeal from './CreateDeal'
import { getDealStatus, getDealTransaction, getProposedDeal, type DealAction, type DealStatus } from './api'

const clauseStatuses = ['Pending', 'Submitted', 'Verified', 'Failed', 'Disputed', 'Released', 'Refunded']
const failedStates = new Set(['FAILED', 'DENIED', 'CANCELLED'])
type Notice = { message: string; error?: boolean; explorerUrl?: string }
type Pending = { refId: string; proposal: boolean }

export default function DealActions({ walletAddress, onAuthorize, onConfirmed }: {
  walletAddress: string
  onAuthorize: (action: DealAction) => Promise<string>
  onConfirmed: () => void
}) {
  const [dealId, setDealId] = useState('')
  const [deal, setDeal] = useState<DealStatus | null>(null)
  const [clauseId, setClauseId] = useState(0)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [videoId, setVideoId] = useState('')

  async function loadDeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    setDeal(null)
    try {
      setDeal(await getDealStatus(dealId))
      setClauseId(0)
      setVideoId('')
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'Could not load the deal.', error: true })
    } finally {
      setBusy(false)
    }
  }

  async function track({ refId, proposal }: Pending, explorerUrl?: string) {
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        const tx = await getDealTransaction(refId)
        if (tx?.txHash && /^0x[\da-f]{64}$/i.test(tx.txHash)) {
          explorerUrl = `https://explorer.testnet.arc.io/tx/${tx.txHash}`
          setNotice({ message: 'Broadcast. Waiting for confirmation…', explorerUrl })
        }
        if (tx?.state === 'COMPLETE' && explorerUrl && tx.txHash) {
          const id = proposal ? (await getProposedDeal(tx.txHash)).dealId : dealId
          setPending(null)
          setNotice({ message: proposal ? `Deal ${id} created on Arc Testnet.` : 'Confirmed on Arc Testnet.', explorerUrl })
          onConfirmed()
          if (proposal) {
            setDealId(id)
            setClauseId(0)
            setVideoId('')
          }
          await getDealStatus(id).then(setDeal).catch(() => setDeal(null))
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
      const transaction = { refId, proposal: action.kind === 'propose' }
      setPending(transaction)
      setNotice({ message: 'Submitted. Waiting for confirmation…' })
      await track(transaction)
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'Could not submit the transaction.', error: true })
    } finally {
      setBusy(false)
    }
  }

  const fundBlock = deal && (!deal.accepted ? 'The creator must accept the deal before funding.'
    : !deal.certified ? 'Chainlink must certify the deal before funding.'
    : deal.funded ? 'The deal is already funded.' : null)
  const isCreator = deal?.creator.toLowerCase() === walletAddress.toLowerCase()
  const isBrand = deal?.brand.toLowerCase() === walletAddress.toLowerCase()
  const clause = deal?.clauses[clauseId]
  const canRefund = !!(deal?.funded && clause && (clause.status === 3 || (
    clause.status < 5 && deal.clauses[clause.dependsOn]?.status === 6
  )))

  return (
    <section aria-labelledby="deal-actions-heading">
      <h2 id="deal-actions-heading">ClauseEscrow</h2>
      <CreateDeal disabled={busy || !!pending} onCreate={(proposal) => void run(proposal)} />
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
          <p>Total: {deal.total} USDC</p>
          <p>Brand <code>{deal.brand}</code></p>
          <p>Creator <code>{deal.creator}</code></p>
          <ul>
            {deal.clauses.map((terms, index) => (
              <li key={index}>
                Clause {index + 1} · {terms.amount} USDC · {clauseStatuses[terms.status] ?? 'Unknown'}
                <p>{terms.checkType === 1 ? `Description contains ${terms.param}` : 'Video posted by deadline'}</p>
                <p>Deadline {new Date(Number(terms.deadline) * 1_000).toLocaleString()}</p>
                <p>{terms.dependsOn === 255 ? 'No dependency' : `Depends on clause ${terms.dependsOn + 1}`} · {terms.onFail === 1 ? 'Refund remainder on failure' : 'Refund clause on failure'}</p>
              </li>
            ))}
          </ul>
          {fundBlock && <p>{fundBlock}</p>}
          {isCreator && !deal.accepted && <button disabled={busy || !!pending} onClick={() => void run({ kind: 'accept', dealId })}>
            Accept deal
          </button>}{' '}
          {isBrand && <button disabled={busy || !!pending || !!fundBlock} onClick={() => void run({ kind: 'fund', dealId })}>
            Fund deal
          </button>}
          {deal.clauses.length > 0 && (
            <div>
              <label>
                Clause{' '}
                <select value={clauseId} disabled={busy || !!pending} onChange={(event) => setClauseId(Number(event.target.value))}>
                  {deal.clauses.map(({ status }, id) => (
                    <option key={id} value={id}>{id + 1} · {clauseStatuses[status] ?? 'Unknown'}</option>
                  ))}
                </select>
              </label>{' '}
              <button disabled={busy || !!pending || !deal.funded || deal.clauses[clauseId]?.status !== 2}
                onClick={() => void run({ kind: 'release', dealId, clauseId })}>
                Release clause
              </button>
              <button disabled={busy || !!pending || !canRefund} onClick={() => void run({ kind: 'refund', dealId, clauseId })}>
                Refund clause
              </button>
              {isCreator && deal.funded && clause?.status === 0 && (
                <form onSubmit={(event) => { event.preventDefault(); void run({ kind: 'submit', dealId, clauseId, videoId: videoId.trim() }) }}>
                  <label>YouTube video ID <input required pattern="[A-Za-z0-9_\-]{11}" maxLength={11}
                    value={videoId} onChange={(event) => setVideoId(event.target.value)} disabled={busy || !!pending} /></label>{' '}
                  <button disabled={busy || !!pending}>Submit video</button>
                </form>
              )}
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
