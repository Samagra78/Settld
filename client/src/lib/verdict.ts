// A dispute ends one of two ways: the freelancer gets the whole clause, or the client gets it all back.
// On-chain that is band 100 or band 0 (AICourt still accepts 50 and 80, so anything else is shown as is).
export type Side = 'freelancer' | 'client'

export const sideOf = (band: number): Side => (band >= 50 ? 'freelancer' : 'client')

/** Short label, for chips: "Pay Freelancer" / "Refund Client" */
export const verdictShort = (band: number) =>
  band === 100 ? 'Pay Freelancer' : band === 0 ? 'Refund Client' : `Freelancer ${band}%`

/** Plain sentence: "Freelancer gets all 200 USDC" */
export const verdictLong = (band: number, amount: number) =>
  band === 100
    ? `Freelancer gets all ${amount} USDC`
    : band === 0
      ? `Client gets all ${amount} USDC back`
      : `Freelancer gets ${(amount * band) / 100} USDC, Client ${amount - (amount * band) / 100}`
