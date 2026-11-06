import { fmt } from '../lib/format'

export type MoneySegment = { label: string; value: number; color: string }

/** Where every dollar is: one segment per bucket, sized by value. */
export function MoneyBar({ segments, big }: { segments: MoneySegment[]; big?: boolean }) {
  return (
    <div className={`money${big ? ' big' : ''}`} aria-hidden="true">
      {segments.map((m) => (
        <i key={m.label} style={{ flexGrow: m.value, background: m.color }} title={big ? `${m.label} ${fmt(m.value)}` : undefined} />
      ))}
    </div>
  )
}

export function MoneyKey({ segments }: { segments: MoneySegment[] }) {
  return (
    <div className="legend" style={{ color: 'var(--ink-62)', marginTop: 8 }}>
      {segments
        .filter((m) => m.value)
        .map((m) => (
          <span key={m.label}>
            <i style={{ background: m.color, boxShadow: 'inset 0 0 0 1px var(--ink-25)' }} />
            {m.label} {m.value}
          </span>
        ))}
    </div>
  )
}
