import { useState, type FormEvent } from 'react'

const maxUint256 = (1n << 256n) - 1n

export default function ApprovalPanel({ onApprove }: { onApprove: (amount: string) => Promise<void> }) {
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    const [whole, fraction = ''] = amount.split('.')
    const units = BigInt(whole + fraction.padEnd(6, '0'))
    if (units <= 0n || units > maxUint256) {
      setMessage('Enter a positive USDC amount within the supported range.')
      return
    }

    setBusy(true)
    setMessage('Waiting for Circle approval…')
    try {
      await onApprove(units.toString())
      setAmount('')
      setMessage('Approval submitted.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not submit the approval.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="approval-heading">
      <h2 id="approval-heading">Approve USDC</h2>
      <form onSubmit={(event) => void approve(event)}>
        <label>
          USDC amount{' '}
          <input
            required
            inputMode="decimal"
            pattern="[0-9]+([.][0-9]{1,6})?"
            maxLength={79}
            value={amount}
            disabled={busy}
            onChange={(event) => {
              setAmount(event.target.value)
              setMessage('')
            }}
          />
        </label>{' '}
        <button type="submit" disabled={busy}>Approve</button>
      </form>
      <p role="status">{message}</p>
    </section>
  )
}
