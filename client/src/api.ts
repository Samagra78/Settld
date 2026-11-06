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

// The signed-in identity: the user is identified by their wallet address.
export type Me = {
  address: string
  walletId: string
  blockchain: string
}

export type TokenBalance = {
  amount: string
  token: { symbol?: string; name?: string }
}

// Circle error shape: { code, message }. 155106 = user already initialized.
// `status` is the HTTP status (401 = not signed in).
export class CircleError extends Error {
  code?: number
  status?: number
  constructor(message: string, code?: number, status?: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function request<T>(method: 'get' | 'post', path: string, body?: object): Promise<T> {
  try {
    const res = await http.request<T>({ method, url: path, data: body })
    return res.data
  } catch (e) {
    if (axios.isAxiosError(e) && e.response) {
      const d = e.response.data as { code?: number; message?: string }
      throw new CircleError(d?.message ?? e.message, d?.code, e.response.status)
    }
    throw e
  }
}
const post = <T>(path: string, body: object) => request<T>('post', path, body)
const get = <T>(path: string) => request<T>('get', path)

export const requestEmailOtp = (deviceId: string, email: string) =>
  post<EmailSession>('/auth/email', { deviceId, email })

export const initializeUser = (userToken: string) =>
  post<{ challengeId: string }>('/user/initialize', { userToken })

export const listWallets = (userToken: string) =>
  post<{ wallets: Wallet[] }>('/wallets', { userToken })

// ---- Session (identity = wallet address) ----------------------------------
// Login-phase calls above take the Circle userToken. After createSession, the
// server holds it and every call below acts only as the signed-in wallet.

export const createSession = (userToken: string) => post<Me>('/session', { userToken })
export const getMe = () => get<Me>('/me')
export const logout = () => post<{ ok: boolean }>('/logout', {})

export const getBalances = () => get<{ tokenBalances: TokenBalance[] }>('/balance')

// Mock top-up (testnet): the server sends 10 test USDC to the signed-in wallet.
export const addFunds = () =>
  post<{ txHash: string; amount: string; to: string }>('/funds/add', {})
