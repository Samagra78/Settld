import { isAddress } from 'viem'

/**
 * Why a freelancer address can't receive a deal, or null if it looks like a real wallet.
 * `isAddress` alone lets placeholders through (0x…01, 0x000…dead, 0x1111…), and the contract only
 * rejects the zero address, so a deal sent to one can never be accepted.
 */
export function freelancerAddressProblem(raw: string, myAddress?: string): string | null {
  const a = raw.trim()
  if (!a) return 'Paste the freelancer’s wallet address.'
  if (!isAddress(a, { strict: false })) return 'That isn’t a wallet address. It starts with 0x and has 40 more characters.'
  const hex = a.slice(2).toLowerCase()
  const zeros = hex.split('').filter((c) => c === '0').length
  const distinct = new Set(hex).size
  if (zeros >= 30 || distinct <= 2 || /^0{30,}|dead$|^(.)\1{35,}/.test(hex))
    return 'That looks like a placeholder address, not a real wallet. Nobody could accept the deal. Ask the freelancer for theirs (Wallet, then Show technical details).'
  if (myAddress && hex === myAddress.slice(2).toLowerCase()) return 'That’s your own wallet. The freelancer must be someone else.'
  return null
}
