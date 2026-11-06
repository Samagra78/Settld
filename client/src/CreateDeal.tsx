import { useState, type FormEvent } from 'react'
import type { Proposal } from './api'

const blankClause = { amount: '', deadline: '', checkType: 0, param: '', dependsOn: 255, onFail: 0 }
const amountPattern = '[0-9]+([.][0-9]{1,6})?'
const scale = 1_000_000n

function units(amount: string) {
  if (!new RegExp(`^${amountPattern}$`).test(amount)) return 0n
  const [whole, fraction = ''] = amount.split('.')
  return BigInt(whole) * scale + BigInt(fraction.padEnd(6, '0'))
}

export default function CreateDeal({ disabled, onCreate }: { disabled: boolean; onCreate: (proposal: Proposal) => void }) {
  const [creator, setCreator] = useState('')
  const [clauses, setClauses] = useState([{ ...blankClause }])
  const [error, setError] = useState('')
  const total = clauses.reduce((sum, clause) => sum + units(clause.amount), 0n)
  const remainder = (total % scale).toString().padStart(6, '0').replace(/0+$/, '')

  function change(index: number, fields: Partial<typeof blankClause>) {
    setClauses(clauses.map((clause, i) => i === index ? { ...clause, ...fields } : clause))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const terms = clauses.map(({ deadline, amount, param, ...clause }) => ({
      ...clause, kind: 0, vestDays: 0, deadline: Math.floor(Date.parse(deadline) / 1_000).toString(),
      amount: units(amount).toString(), param: clause.checkType === 1 ? param.trim() : '',
    }))
    if (total > (1n << 256n) - 1n || terms.some((clause) => clause.amount === '0')) {
      setError('Enter positive clause amounts within the supported USDC range.')
      return
    }
    if (terms.some((clause) => !(Number(clause.deadline) > Date.now() / 1_000))) {
      setError('Set a future deadline for each clause.')
      return
    }
    if (terms.some((clause) => clause.checkType === 1 && !clause.param)) {
      setError('Enter a hashtag for each description check.')
      return
    }
    setError('')
    onCreate({ kind: 'propose', creator: creator.trim(), total: total.toString(), clauses: terms })
  }

  return (
    <details>
      <summary>Create deal</summary>
      <form onSubmit={submit}>
        <fieldset disabled={disabled}>
          <label>Creator wallet <input required pattern="0x[0-9a-fA-F]{40}" value={creator} onChange={(e) => setCreator(e.target.value)} /></label>
          {clauses.map((clause, index) => (
            <fieldset key={index}>
              <legend>Clause {index + 1}</legend>
              <label>USDC <input required inputMode="decimal" pattern={amountPattern} maxLength={79} value={clause.amount}
                onChange={(e) => change(index, { amount: e.target.value })} /></label>{' '}
              <label>Deadline <input required type="datetime-local" value={clause.deadline}
                onChange={(e) => change(index, { deadline: e.target.value })} /></label>{' '}
              <label>Check <select value={clause.checkType} onChange={(e) => change(index, { checkType: Number(e.target.value) })}>
                <option value={0}>Video posted by deadline</option>
                <option value={1}>Description contains hashtag</option>
              </select></label>{' '}
              {clause.checkType === 1 && <label>Hashtag <input required value={clause.param}
                onChange={(e) => change(index, { param: e.target.value })} /></label>}{' '}
              <label>Depends on <select value={clause.dependsOn} onChange={(e) => change(index, { dependsOn: Number(e.target.value) })}>
                <option value={255}>None</option>
                {clauses.slice(0, index).map((_, earlier) => <option key={earlier} value={earlier}>Clause {earlier + 1}</option>)}
              </select></label>{' '}
              <label>On failure <select value={clause.onFail} onChange={(e) => change(index, { onFail: Number(e.target.value) })}>
                <option value={0}>Refund clause</option>
                <option value={1}>Refund remainder</option>
              </select></label>
            </fieldset>
          ))}
          <p>Total: {total / scale}{remainder && `.${remainder}`} USDC</p>
          <button type="button" disabled={clauses.length === 5} onClick={() => setClauses([...clauses, { ...blankClause }])}>Add clause</button>{' '}
          <button type="button" disabled={clauses.length === 1} onClick={() => setClauses(clauses.slice(0, -1))}>Remove last clause</button>{' '}
          <button>Propose deal</button>
          {error && <p role="alert">{error}</p>}
        </fieldset>
      </form>
    </details>
  )
}
