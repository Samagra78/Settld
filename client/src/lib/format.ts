/** 1240 -> "1,240.00" */
export const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 102 -> "1:42" */
export const mmss = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`

/** 20412 -> "05:40:12" */
export const hms = (c: number) =>
  [Math.floor(c / 3600), Math.floor((c % 3600) / 60), c % 60].map((n) => String(n).padStart(2, '0')).join(':')

/** Rupee estimate in Indian grouping, for example 1,03,330 */
export const inr = (n: number) => Math.round(n).toLocaleString('en-IN')
