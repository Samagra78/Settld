import { useEffect, useRef, useState } from 'react'
import { W3SSdk } from '@circle-fin/w3s-pw-web-sdk'
import type { LoginConfigs } from '@circle-fin/w3s-pw-web-sdk/dist/src/types'
import EscrowPanel from './EscrowPanel'
import PingStatus from './PingStatus'
import {
  CircleError,
  addFunds,
  getBalances,
  initializeUser,
  listWallets,
  prepareEscrowAction,
  requestEmailOtp,
  type EscrowAction,
  type Wallet,
} from './api'

const appId = import.meta.env.VITE_CIRCLE_APP_ID as string

type Login = { userToken: string; encryptionKey: string }

function App() {
  const sdkRef = useRef<W3SSdk | null>(null)
  const [deviceId, setDeviceId] = useState('')
  const [email, setEmail] = useState('')
  const [otpReady, setOtpReady] = useState(false)
  const [login, setLogin] = useState<Login | null>(null)
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [usdc, setUsdc] = useState<string | null>(null)
  const [status, setStatus] = useState('Loading SDK...')
  const [isError, setIsError] = useState(false)

  const say = (msg: string, error = false) => {
    setStatus(msg)
    setIsError(error)
  }

  // Create the SDK once. onLoginComplete fires after the user enters the OTP.
  useEffect(() => {
    const sdk = new W3SSdk(
      { appSettings: { appId } },
      (error, result) => {
        if (error || !result) {
          say(error?.message ?? 'Email verification failed', true)
          return
        }
        setLogin({ userToken: result.userToken, encryptionKey: result.encryptionKey })
        say('Logged in. Click "Create / load wallet".')
      },
    )
    sdkRef.current = sdk
    sdk
      .getDeviceId()
      .then((id) => {
        setDeviceId(id)
        say('Ready. Enter an email.')
      })
      .catch(() => say('Failed to get device id', true))
  }, [])

  const loadWallet = async (userToken: string) => {
    const { wallets } = await listWallets(userToken)
    if (wallets.length === 0) {
      say('Wallet is still being created, click again in a few seconds.')
      return
    }
    const w = wallets[0]
    setWallet(w)
    const { tokenBalances } = await getBalances(userToken, w.id)
    const entry = tokenBalances.find((t) => t.token?.symbol?.startsWith('USDC'))
    setUsdc(entry?.amount ?? '0')
    say('Wallet loaded.')
  }

  // Mock card top-up: the server sends 10 test USDC from a treasury wallet.
  const [adding, setAdding] = useState(false)
  const topUp = async () => {
    if (!login) return
    try {
      setAdding(true)
      say('Processing payment...')
      const r = await addFunds(login.userToken)
      say(`Added ${r.amount} USDC (test funds). Updating balance...`)
      await loadWallet(login.userToken)
      say(`Added ${r.amount} USDC (test funds).`)
    } catch (e) {
      say((e as Error).message, true)
    } finally {
      setAdding(false)
    }
  }

  // Step 1: ask Circle to email an OTP; hand the session tokens to the SDK.
  const sendOtp = async () => {
    try {
      say('Requesting OTP...')
      const s = await requestEmailOtp(deviceId, email)
      sdkRef.current?.updateConfigs({
        appSettings: { appId },
        // `email` is used at runtime (per Circle's quickstart) but missing from
        // the SDK's published types (v1.1.11), hence the cast.
        loginConfigs: {
          deviceToken: s.deviceToken,
          deviceEncryptionKey: s.deviceEncryptionKey,
          otpToken: s.otpToken,
          email: { email },
        } as LoginConfigs,
      })
      setOtpReady(true)
      say('OTP sent. Check your inbox (and spam), then click "Verify OTP".')
    } catch (e) {
      say((e as Error).message, true)
    }
  }

  // Step 2: Circle's hosted window collects the OTP.
  const verifyOtp = () => sdkRef.current?.verifyOtp()

  const runEscrowAction = async (action: EscrowAction) => {
    const sdk = sdkRef.current
    if (!sdk || !login || !wallet) throw new Error('Load your wallet before using escrow.')

    const { challengeId } = await prepareEscrowAction(login.userToken, wallet.id, action)
    sdk.setAuthentication(login)
    await new Promise<void>((resolve, reject) => {
      sdk.execute(challengeId, (error, result) => {
        if (error) reject(new Error(error.message || 'Circle could not authorize the transaction.'))
        else if (result?.status === 'COMPLETE') resolve()
        else reject(new Error('Circle did not complete the transaction authorization.'))
      })
    })
  }

  // Step 3: initialize the user (first time) -> challenge -> user sets PIN -> wallet.
  const createOrLoadWallet = async () => {
    if (!login) return
    try {
      say('Initializing user...')
      const { challengeId } = await initializeUser(login.userToken)
      const sdk = sdkRef.current!
      sdk.setAuthentication(login)
      sdk.execute(challengeId, async (error) => {
        if (error) {
          say(error.message ?? 'Challenge failed', true)
          return
        }
        say('Wallet created. Loading...')
        await new Promise((r) => setTimeout(r, 2000)) // let Circle index it
        await loadWallet(login.userToken).catch((e) => say((e as Error).message, true))
      })
    } catch (e) {
      if (e instanceof CircleError && e.code === 155106) {
        // user already has a wallet, just load it
        await loadWallet(login.userToken).catch((err) => say((err as Error).message, true))
        return
      }
      say((e as Error).message, true)
    }
  }

  return (
    <main style={{ maxWidth: 520, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>Settld</h1>

      <input
        type="email"
        placeholder="you+brand@gmail.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ width: '100%', padding: 8, marginBottom: 12 }}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={sendOtp} disabled={!deviceId || !email}>
          1. Send OTP
        </button>
        <button onClick={verifyOtp} disabled={!otpReady || !!login}>
          2. Verify OTP
        </button>
        <button onClick={createOrLoadWallet} disabled={!login || !!wallet}>
          3. Create / load wallet
        </button>
      </div>

      <p style={{ color: isError ? 'red' : 'inherit' }}>{status}</p>

      {wallet && (
        <div>
          <p>
            <strong>Address:</strong> <code>{wallet.address}</code>
          </p>
          <p>
            <strong>Chain:</strong> {wallet.blockchain}
          </p>
          <p>
            <strong>USDC:</strong> {usdc}
          </p>
          <button onClick={topUp} disabled={adding}>
            {adding ? 'Adding...' : 'Add $10 (test funds)'}
          </button>
          <p style={{ fontSize: 12, opacity: 0.7 }}>
            Mock payment: nothing is charged. Testnet USDC is sent to your wallet.
          </p>
        </div>
      )}

      {login && wallet && <EscrowPanel key={wallet.id} onAction={runEscrowAction} />}
      <PingStatus />
    </main>
  )
}

export default App
