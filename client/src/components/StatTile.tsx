import type { CSSProperties, ReactNode } from 'react'
import type { IconName } from '../data/types'
import { Icon } from './Icon'

/** One tile in the stats row. color draws the 4px top rule; hot makes it the orange call-out. */
export function StatTile({ label, icon, color, hot, children }: { label: ReactNode; icon: IconName; color: string; hot?: boolean; children: ReactNode }) {
  return (
    <div className={`stat${hot ? ' hot' : ''}`} style={{ '--c': color } as CSSProperties}>
      <span className="l">
        <Icon name={icon} />
        {label}
      </span>
      <span className={hot ? 'v' : 'num v'}>{children}</span>
    </div>
  )
}

export function StatRow({ children }: { children: ReactNode }) {
  return <div className="stats">{children}</div>
}
