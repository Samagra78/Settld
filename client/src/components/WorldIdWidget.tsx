import { useEffect, useRef, useState } from 'react'
import { IDKitRequestWidget, proofOfHuman } from '@worldcoin/idkit'
import { startWorldId, verifyWorldId, type Attestation, type WorldIdRequest } from '../data/worldid'

/**
 * World's own IDKit widget (QR code for World App, or a link for the simulator on staging).
 * The proof is checked by our server with World before `onVerified` runs; closing the widget calls `onCancel`.
 */
export function WorldIdWidget({ open, onVerified, onCancel, onFail }: {
  open: boolean
  onVerified: (att: Attestation) => void
  onCancel: () => void
  /** `close` false: World's own error screen stays open (with Retry); only show the message */
  onFail: (message: string, close?: boolean) => void
}) {
  const [req, setReq] = useState<WorldIdRequest | null>(null)
  const att = useRef<Attestation | null>(null)
  const failure = useRef<string | null>(null)
  const done = useRef(false)

  useEffect(() => {
    if (!open) return
    done.current = false
    att.current = null
    failure.current = null
    let live = true
    startWorldId().then((r) => { if (live) setReq(r) }).catch((e: Error & { status?: number }) => {
      if (live) onFail(e.status === 401 ? 'Sign in with your email first: World ID is linked to your Settld wallet.' : e.message)
    })
    // each opening gets a fresh, single-use request from the server
    return () => { live = false; setReq(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open || !req) return null
  return (
    <IDKitRequestWidget
      open
      onOpenChange={(o) => { if (!o && !done.current) onCancel() }}
      app_id={req.appId}
      action={req.action}
      rp_context={req.rpContext}
      environment={req.environment}
      // the simulator (and older World App versions) still send World ID 3.0 proofs
      allow_legacy_proofs
      preset={proofOfHuman({ signal: req.signal })}
      handleVerify={async (result) => {
        try {
          att.current = await verifyWorldId(result)
        } catch (e) {
          failure.current = (e as Error).message
          throw e
        }
      }}
      onSuccess={() => { done.current = true; if (att.current) onVerified(att.current) }}
      // keep World's error screen up (it has Retry); just say why, in our words
      onError={(code) => { if (!done.current) onFail(failure.current ?? `World ID didn’t complete (${code}).`, false) }}
      autoClose
    />
  )
}
