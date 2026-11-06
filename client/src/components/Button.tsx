import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'

// One button system: orange = do it, outline (sec) = optional, blue = check, ink = dark.
// Heights are fixed in CSS (44 default, 36 sm, 56 big) and never stretch.
export type ButtonVariant = 'primary' | 'sec' | 'blue' | 'ink'
export type ButtonSize = 'md' | 'sm' | 'big'

type Common = { variant?: ButtonVariant; size?: ButtonSize; full?: boolean; children: ReactNode }

const cls = ({ variant = 'primary', size = 'md', full }: Omit<Common, 'children'>, extra?: string) =>
  ['btn', variant !== 'primary' && variant, size !== 'md' && size, full && 'full', extra].filter(Boolean).join(' ')

export function Button({ variant, size, full, className, type = 'button', ...rest }: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={cls({ variant, size, full }, className)} {...rest} />
}

export function ButtonLink({ variant, size, full, className, ...rest }: Common & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={cls({ variant, size, full }, className)} {...rest} />
}
