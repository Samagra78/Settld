import { useState, type FormEvent } from 'react'
import type { EscrowAction } from './api'

const maxUint256 = (1n << 256n) - 1n
const actionLabels = { approve: 'Approve USDC', fund: 'Fund escrow', release: 'Release escrow' }

export default function EscrowPanel({ onAction }: { onAction: (action: EscrowAction) => Promise<void> }) {
  const [amount, setAmount] = useState('')
  const [creator, setCreator] = useState('')
  const [escrowId, setEscrowId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(action: EscrowAction) {
    if (busy) return
    setBusy(true)
    setMessage('Waiting for Circle authorization…')
    try {
      await onAction(action)
      setMessage(`${actionLabels[action.kind]} submitted.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not submit the transaction.')
    } finally {
      setBusy(false)
    }
  }

  function approveOrFund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const [whole, fraction = ''] = amount.split('.')
    const units = BigInt(whole + fraction.padEnd(6, '0'))
    if (units <= 0n || units > maxUint256) {
      setMessage('Enter a positive USDC amount within the supported range.')
      return
    }

    const { submitter } = event.nativeEvent as SubmitEvent
    if (!(submitter instanceof HTMLButtonElement) || submitter.value !== 'fund') {
      void submit({ kind: 'approve', amount: units.toString() })
      return
    }

    const address = creator.trim()
    if (!/^0x[0-9a-f]{40}$/i.test(address) || /^0x0{40}$/i.test(address)) {
      setMessage('Enter a valid creator wallet address to fund escrow.')
      return
    }
    void submit({ kind: 'fund', creator: address, amount: units.toString() })
  }

  function release(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = BigInt(escrowId)
    if (id > maxUint256) {
      setMessage('Enter an escrow ID within the supported range.')
      return
    }
    void submit({ kind: 'release', id: id.toString() })
  }

  return (
    <section aria-labelledby="escrow-heading">
      <h2 id="escrow-heading">Arc Testnet escrow</h2>
      <p>Approve the USDC amount before funding escrow.</p>
      <form onSubmit={approveOrFund}>
        <fieldset disabled={busy}>
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
        <fieldset disabled={busy}>
          <label>
            Escrow ID{' '}
            <input required inputMode="numeric" pattern="[0-9]+" maxLength={78}
              value={escrowId} onChange={(event) => setEscrowId(event.target.value)} />
          </label>{' '}
          <button type="submit">Release escrow</button>
        </fieldset>
      </form>
      <p role="status">{message}</p>
    </section>
  )
}
