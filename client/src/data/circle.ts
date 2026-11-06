// Circle user-controlled wallets: email code sign-in, PIN wallet, and PIN approval for every transaction.
// The Circle API key stays on the server. This tab keeps Circle's userToken in sessionStorage so a page
// reload doesn't ask for a new email code (it is gone when the tab closes, and Circle expires it anyway).
import { W3SSdk } from '@circle-fin/w3s-pw-web-sdk'
import type { LoginConfigs } from '@circle-fin/w3s-pw-web-sdk/dist/src/types'
import { CircleError, createSession, initializeUser, listWallets, requestEmailOtp, type Me } from '../api'

const appId = import.meta.env.VITE_CIRCLE_APP_ID as string

type Login = { userToken: string; encryptionKey: string }

let sdk: W3SSdk | null = null
const LOGIN_KEY = 'settld.circle'
function loadLogin(): Login | null {
  try {
    const raw = sessionStorage.getItem(LOGIN_KEY)
    const l = raw ? (JSON.parse(raw) as Login) : null
    return l?.userToken && l?.encryptionKey ? l : null
  } catch {
    return null
  }
}
function saveLogin(l: Login | null) {
  try {
    if (l) sessionStorage.setItem(LOGIN_KEY, JSON.stringify(l))
    else sessionStorage.removeItem(LOGIN_KEY)
  } catch {
    /* storage blocked: the code step simply comes back after a reload */
  }
}
let login: Login | null = loadLogin()
let pendingLogin: { resolve: (l: Login) => void; reject: (e: Error) => void } | null = null

// The email is remembered on this device so a PIN action after a page reload can re-open the
// email-code step itself (the userToken that Circle's PIN window needs is kept in memory only).
const EMAIL_KEY = 'settld.email'
export function rememberEmail(email: string) {
  try {
    localStorage.setItem(EMAIL_KEY, email)
  } catch {
    /* storage blocked */
  }
}
export function rememberedEmail(): string {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? ''
  } catch {
    return ''
  }
}

// While Circle's own window (code or PIN) is open, our modal steps aside so it can't cover it
const circleOpen = (on: boolean) => document.body.classList.toggle('circle-open', on)

function getSdk(): W3SSdk {
  if (sdk) return sdk
  sdk = new W3SSdk({ appSettings: { appId } }, (error, result) => {
    const p = pendingLogin
    pendingLogin = null
    if (error || !result) p?.reject(new Error(error?.message || 'Email code was not accepted.'))
    else p?.resolve({ userToken: result.userToken, encryptionKey: result.encryptionKey })
  })
  return sdk
}

/** Step 1: email a 6-digit code. Step 2 (Circle's own window) collects it. Resolves once verified. */
export async function emailCodeLogin(email: string): Promise<Login> {
  const s = getSdk()
  const deviceId = await s.getDeviceId()
  const sendCode = async () => {
    const t = await requestEmailOtp(deviceId, email)
    s.updateConfigs({
      appSettings: { appId },
      // `email` is read at runtime (Circle quickstart) but missing from the SDK's published types
      loginConfigs: { deviceToken: t.deviceToken, deviceEncryptionKey: t.deviceEncryptionKey, otpToken: t.otpToken, email: { email } } as LoginConfigs,
    })
  }
  await sendCode()
  // "Send again" in Circle's code window: email a fresh code and hand the window the new token
  s.setOnResendOtpEmail(() => {
    sendCode().catch((e) => pendingLogin?.reject(new Error((e as Error).message || 'Could not send a new code.')))
  })
  const done = new Promise<Login>((resolve, reject) => (pendingLogin = { resolve, reject }))
  circleOpen(true)
  s.verifyOtp()
  try {
    login = await done
  } finally {
    circleOpen(false)
  }
  saveLogin(login)
  rememberEmail(email)
  return login
}

/** Runs a Circle challenge (PIN setup or a transaction) in Circle's window */
export function approveWithPin(challengeId: string): Promise<void> {
  if (!login) return Promise.reject(new Error('For your security, sign in with your email code again to approve payments.'))
  const s = getSdk()
  s.setAuthentication(login)
  circleOpen(true)
  return new Promise<void>((resolve, reject) => {
    s.execute(challengeId, (error, result) => {
      circleOpen(false)
      // an expired or revoked token: forget it so the next action asks for a fresh email code
      if (error && /token|expired|unauthori[sz]ed|155104|155105/i.test(`${error.message} ${(error as { code?: number }).code ?? ''}`)) {
        login = null
        saveLogin(null)
        reject(new Error('Your Circle sign-in expired. Try again: we will email you a new code first.'))
        return
      }
      if (error) reject(new Error(error.message || 'PIN approval failed.'))
      else if (result?.status === 'COMPLETE' || result?.status === 'IN_PROGRESS') resolve()
      else reject(new Error('The PIN approval was not completed.'))
    })
  })
}

/** First sign-in creates the wallet (the user picks a PIN); later sign-ins just load it. Then opens the server session. */
export async function walletAndSession(l: Login): Promise<Me> {
  try {
    const { challengeId } = await initializeUser(l.userToken)
    await approveWithPin(challengeId)
    await new Promise((r) => setTimeout(r, 2500)) // Circle indexes the new wallet
  } catch (e) {
    if (!(e instanceof CircleError && e.code === 155106)) throw e // 155106 = wallet already exists
  }
  for (let i = 0; i < 5; i++) {
    const { wallets } = await listWallets(l.userToken)
    if (wallets.length) return createSession(l.userToken)
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('Your wallet is still being created. Try signing in again in a few seconds.')
}

export const canApprove = () => !!login

/**
 * Call BEFORE preparing any transaction that needs the PIN. After a page reload the server session is
 * still valid but Circle's PIN window needs a fresh email code, so this asks for it first instead of
 * failing at the PIN after the transaction was already prepared.
 */
export async function ensurePinReady(): Promise<void> {
  if (login) return
  const email = rememberedEmail()
  if (!email) throw new Error('To approve with your PIN, sign out and sign in again with your email code.')
  await emailCodeLogin(email)
}
export const forgetLogin = () => {
  login = null
  saveLogin(null)
}
