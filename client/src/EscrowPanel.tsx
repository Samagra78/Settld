import { useState, type FormEvent } from 'react'
import type { EscrowAction, getEscrowTransaction } from './api'

const maxUint256 = (1n << 256n) - 1n
const actionLabels = { approve: 'Approve USDC', fund: 'Fund escrow', release: 'Release escrow' }
const failedStates = new Set(['FAILED', 'DENIED', 'CANCELLED'])

type CheckStatus = () => ReturnType<typeof getEscrowTransaction>
type PendingTransaction = { kind: EscrowAction['kind']; checkStatus: CheckStatus }
type Notice = { title: string; message: string; explorerUrl?: string; error?: boolean }

export default function EscrowPanel({ onAction, onConfirmed }: {
  onAction: (action: EscrowAction) => Promise<CheckStatus>
  onConfirmed: () => void
}) {

  const [amount, setAmount] = useState('')
  const [creator, setCreator] = useState('')
  const [escrowId, setEscrowId] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState<PendingTransaction | null>(null)

  async function track({ kind, checkStatus }: PendingTransaction, explorerUrl?: string) {
    const title = actionLabels[kind]
    setNotice({ title, message: 'Submitted. Waiting for Arc Testnet confirmation…', explorerUrl })
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        const transaction = await checkStatus()
        if (transaction?.txHash && /^0x[\da-f]{64}$/i.test(transaction.txHash)) {
          const url = `https://explorer.testnet.arc.io/tx/${transaction.txHash}`
          if (explorerUrl !== url) {
            explorerUrl = url
            setNotice({ title, message: 'Broadcast. Waiting for confirmation…', explorerUrl })
          }
        }

        if (transaction?.state === 'COMPLETE' && explorerUrl) {
          setNotice({ title, message: 'Confirmed on Arc Testnet.', explorerUrl })
          setPending(null)
          onConfirmed()
          return
        }

        if (transaction && failedStates.has(transaction.state)) {
          setNotice({
            title,
            message: transaction.errorReason || `Circle marked this transaction ${transaction.state.toLowerCase()}.`,
            explorerUrl,
            error: true,
          })
          setPending(null)
          return
        }

        if (attempt < 29) await new Promise((resolve) => setTimeout(resolve, 2_000))
      }

      setNotice({ title, message: 'The receipt is still pending. Check status again in a moment.', explorerUrl })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not check Circle for a receipt.'
      setNotice({ title, message: `Transaction submitted. Status check failed: ${message}`, explorerUrl, error: true })
    }
  }

  async function submit(action: EscrowAction) {
    if (busy || pending) return
    const title = actionLabels[action.kind]
    setBusy(true)
    setNotice({ title, message: 'Waiting for Circle authorization…' })
    try {
      const checkStatus = await onAction(action)
      const transaction = { kind: action.kind, checkStatus }
      setPending(transaction)
      await track(transaction)
    } catch (error) {
      setNotice({ title, message: error instanceof Error ? error.message : 'Could not authorize the transaction.', error: true })
    } finally {
      setBusy(false)
    }
  }

  async function checkAgain() {
    if (busy || !pending) return
    setBusy(true)
    try {
      await track(pending, notice?.explorerUrl)
    } finally {
      setBusy(false)
    }
  }

  function approveOrFund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const [whole, fraction = ''] = amount.split('.')
    const units = BigInt(whole + fraction.padEnd(6, '0'))
    if (units <= 0n || units > maxUint256) {
      setNotice({ title: 'USDC amount', message: 'Enter a positive amount within the supported range.', error: true })
      return
    }

    const { submitter } = event.nativeEvent as SubmitEvent
    if (!(submitter instanceof HTMLButtonElement) || submitter.value !== 'fund') {
      void submit({ kind: 'approve', amount: units.toString() })
      return
    }

    const address = creator.trim()
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) {
      setNotice({ title: actionLabels.fund, message: 'Enter a valid creator wallet address.', error: true })
      return
    }
    void submit({ kind: 'fund', creator: address, amount: units.toString() })
  }

  function release(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = BigInt(escrowId)
    if (id > maxUint256) {
      setNotice({ title: actionLabels.release, message: 'Enter an escrow ID within the supported range.', error: true })
      return
    }
    void submit({ kind: 'release', id: id.toString() })
  }

  return (
    <section aria-labelledby="escrow-heading">
      <h2 id="escrow-heading">Arc Testnet escrow</h2>
      <p>Approve the USDC amount before funding escrow.</p>
      <form onSubmit={approveOrFund}>
        <fieldset disabled={busy || !!pending}>
          <label>
            USDC amount{' '}
            <input required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,6})?" maxLength={79}
              value={amount} onChange={(event) => setAmount(event.target.value)} />
          </label>{' '}
          <label>
            Creator wallet address{' '}
            <input value={creator} onChange={(event) => setCreator(event.target.value)} />
          </label>{' '}
          <button type="submit" value="approve">Approve USDC</button>{' '}
          <button type="submit" value="fund">Fund escrow</button>
        </fieldset>
      </form>
      <form onSubmit={release}>
        <fieldset disabled={busy || !!pending}>
          <label>
            Escrow ID{' '}
            <input required inputMode="numeric" pattern="[0-9]+" maxLength={78}
              value={escrowId} onChange={(event) => setEscrowId(event.target.value)} />
          </label>{' '}
          <button type="submit">Release escrow</button>
        </fieldset>
      </form>
      {notice && (
        <aside className="escrow-notice" aria-label="Escrow transaction">
          <div role={notice.error ? 'alert' : 'status'}>
            <strong>{notice.title}</strong>
            <p>{notice.message}</p>
          </div>
          {notice.explorerUrl && (
            <p><a href={notice.explorerUrl} target="_blank" rel="noreferrer">View transaction on Arc Explorer</a></p>
          )}
          {!busy && (
            <div>
              {pending && <button type="button" onClick={() => void checkAgain()}>Check status again</button>}{' '}
              <button type="button" onClick={() => { setPending(null); setNotice(null) }}>
                {pending ? 'Stop tracking' : 'Close'}
              </button>
            </div>
          )}
        </aside>
      )}
    </section>
  )
}
