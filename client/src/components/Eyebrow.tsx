import type { CSSProperties, ReactNode } from 'react'

/** Jersey label with the brand gradient rule */
export function Eyebrow({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`eb${className ? ` ${className}` : ''}`} style={style}>
      {children} <i />
    </div>
  )
}

/** Page heading row on workspace pages */
export function PageHead({ eyebrow, title, aside, children, maxWidth }: { eyebrow: ReactNode; title: ReactNode; aside?: ReactNode; children?: ReactNode; maxWidth?: number }) {
  return (
    <div className="page-head">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth }}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1>{title}</h1>
        {children}
      </div>
      {aside}
    </div>
  )
}
