import type { CSSProperties, ReactNode } from 'react'
import type { ChipKind, IconName } from '../data/types'
import { Icon } from './Icon'

/** Status chip (4px corners). Pass kind for a design-system variant, or style for a one-off ground. */
export function Chip({ kind, icon, children, style }: { kind?: ChipKind; icon?: IconName; children: ReactNode; style?: CSSProperties }) {
  return (
    <span className={`chip${kind ? ` c-${kind}` : ''}`} style={style}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  )
}
