import axios from 'axios'

// All Circle calls go through our Express server (proxied via /api by Vite),
// so the Circle API key never reaches the browser.
const http = axios.create({ baseURL: '/api' })

export type EmailSession = {
  deviceToken: string
  deviceEncryptionKey: string
  otpToken: string
}

export type Wallet = {
  id: string
  address: string
  blockchain: string
}

export type TokenBalance = {
  amount: string
  token: { symbol?: string; name?: string }
}

// Circle error shape: { code, message }. 155106 = user already initialized.
export class CircleError extends Error {
  code?: number
  constructor(message: string, code?: number) {
    super(message)
    this.code = code
  }
}

async function post<T>(path: string, body: object): Promise<T> {
  try {
    const res = await http.post<T>(path, body)
    return res.data
  } catch (e) {
    if (axios.isAxiosError(e) && e.response) {
      const d = e.response.data as { code?: number; message?: string }
      throw new CircleError(d?.message ?? e.message, d?.code)
    }
    throw e
  }
}

export const requestEmailOtp = (deviceId: string, email: string) =>
  post<EmailSession>('/auth/email', { deviceId, email })

export const initializeUser = (userToken: string) =>
  post<{ challengeId: string }>('/user/initialize', { userToken })

export const listWallets = (userToken: string) =>
  post<{ wallets: Wallet[] }>('/wallets', { userToken })

export const getBalances = (userToken: string, walletId: string) =>
  post<{ tokenBalances: TokenBalance[] }>('/balance', { userToken, walletId })
