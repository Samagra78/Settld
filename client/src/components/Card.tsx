import type { HTMLAttributes } from 'react'

/** White working surface (6px corners). tone="dark" for charcoal, "beige" for beige. */
export function Card({ tone, className, ...rest }: { tone?: 'dark' | 'beige' } & HTMLAttributes<HTMLDivElement>) {
  return <div className={['card', tone, className].filter(Boolean).join(' ')} {...rest} />
}
