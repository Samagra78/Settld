import { useEffect, useRef, useState } from 'react'
import { W3SSdk } from '@circle-fin/w3s-pw-web-sdk'
import type { LoginConfigs } from '@circle-fin/w3s-pw-web-sdk/dist/src/types'
import ApprovalPanel from './ApprovalPanel'
import DealActions from './DealActions'
import PingStatus from './PingStatus'
import {
  CircleError,
  addFunds,
  createSession,
  getBalances,
  getMe,
  initializeUser,
  listWallets,
  logout,
  prepareApproval,
  prepareDealAction,
  requestEmailOtp,
  type DealAction,
  type Me,
} from './api'

const appId = import.meta.env.VITE_CIRCLE_APP_ID as string

type Login = { userToken: string; encryptionKey: string }

function App() {
  const sdkRef = useRef<W3SSdk | null>(null)
  const [deviceId, setDeviceId] = useState('')
  const [email, setEmail] = useState('')
  const [otpReady, setOtpReady] = useState(false)
  const [login, setLogin] = useState<Login | null>(null)
  const [me, setMe] = useState<Me | null>(null) // signed-in identity: wallet address
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

  const loadBalance = async () => {
    const { tokenBalances } = await getBalances()
    const entry = tokenBalances.find((t) => t.token?.symbol?.startsWith('USDC'))
    setUsdc(entry?.amount ?? '0')
  }

  // Already signed in (cookie session from an earlier login)? Show who we are.
  useEffect(() => {
    getMe()
      .then(async (m) => {
        setMe(m)
        await loadBalance()
        say('Signed in (session restored).')
      })
      .catch(() => {}) // 401 = not signed in, nothing to restore
  }, [])

  // Exchange the Circle login for a server session keyed to the wallet address.
  const loadWallet = async (userToken: string) => {
    const { wallets } = await listWallets(userToken)
    if (wallets.length === 0) {
      say('Wallet is still being created, click again in a few seconds.')
      return
    }
    setMe(await createSession(userToken))
    await loadBalance()
    say('Signed in.')
  }

  const signOut = async () => {
    await logout().catch(() => {})
    setMe(null)
    setUsdc(null)
    setLogin(null)
    setOtpReady(false)
    say('Signed out.')
  }

  // Mock card top-up: the server sends 10 test USDC from a treasury wallet.
  const [adding, setAdding] = useState(false)
  const topUp = async () => {
    try {
      setAdding(true)
      say('Processing payment...')
      const r = await addFunds()
      // use the on-chain balance the server read after the transfer (Circle's index can lag a few seconds)
      if (r.balance !== undefined) setUsdc(r.balance)
      else await loadBalance()
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

  const authorizeChallenge = async (challengeId: string) => {
    const sdk = sdkRef.current
    if (!sdk || !login || !me) throw new Error('Sign in with Circle to authorize the transaction.')

    sdk.setAuthentication(login)
    await new Promise<void>((resolve, reject) => {
      sdk.execute(challengeId, (error, result) => {
        if (error) reject(new Error(error.message || 'Circle authorization failed.'))
        else if (result?.status === 'COMPLETE') resolve()
        else reject(new Error('Circle did not complete the authorization challenge.'))
      })
    })
  }

  const approveUsdc = async (amount: string) => {
    const { challengeId } = await prepareApproval(amount)
    await authorizeChallenge(challengeId)
  }

  const authorizeDealAction = async (action: DealAction) => {
    const { challengeId, refId } = await prepareDealAction(action)
    await authorizeChallenge(challengeId)
    return refId
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
        <button onClick={sendOtp} disabled={!!me || !deviceId || !email}>
          1. Send OTP
        </button>
        <button onClick={verifyOtp} disabled={!!me || !otpReady || !!login}>
          2. Verify OTP
        </button>
        <button onClick={createOrLoadWallet} disabled={!login || !!me}>
          3. Create / load wallet
        </button>
      </div>

      <p style={{ color: isError ? 'red' : 'inherit' }}>{status}</p>

      {me && (
        <div>
          <p>
            <strong>Signed in as:</strong> <code>{me.address}</code>
          </p>
          <p>
            <strong>Chain:</strong> {me.blockchain}
          </p>
          <p>
            <strong>USDC:</strong> {usdc}
          </p>
          <button onClick={topUp} disabled={adding}>
            {adding ? 'Adding...' : 'Add $10 (test funds)'}
          </button>
          <button onClick={signOut} style={{ marginLeft: 8 }}>
            Sign out
          </button>
          <p style={{ fontSize: 12, opacity: 0.7 }}>
            Mock payment: nothing is charged. Testnet USDC is sent to your wallet.
          </p>
          <PingStatus />
          {me.blockchain === 'ARC-TESTNET' && (login ? (
            <>
              <ApprovalPanel key={me.walletId} onApprove={approveUsdc} />
              <DealActions key={`deal-${me.walletId}`} walletAddress={me.address} onAuthorize={authorizeDealAction} onConfirmed={() => {
                void loadBalance().catch(() => say('Transaction confirmed. Could not refresh the wallet balance.', true))
              }} />
            </>
          ) : (
            <p>To approve USDC after restoring a session, sign out and verify your email again.</p>
          ))}
        </div>
      )}
    </main>
  )
}

export default App
