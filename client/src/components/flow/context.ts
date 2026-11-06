import { createContext, useContext, type ReactNode } from 'react'

export type FlowField = {
  id: string
  label: string
  placeholder?: string
  defaultValue?: string
  type?: 'text' | 'number' | 'email'
  /** narrow fields sit beside the previous one (140px column) */
  narrow?: boolean
}

/** Every money action: confirm, then working steps (optional PIN), then done with a toast. */
export type FlowOptions = {
  kicker?: string
  title: string
  summary: ReactNode
  fields?: FlowField[]
  /** return the id of the field that is wrong to block the flow */
  validate?: (values: Record<string, string>) => string | null
  cta: string
  pin?: boolean
  fee?: boolean
  working: string
  steps: string[]
  /** real work; runs alongside the step animation and must finish before Done */
  run?: (values: Record<string, string>) => Promise<void>
  done: string
  next?: string
  okLabel?: string
  receipt?: boolean
  after?: (values: Record<string, string>) => void
}

export type FlowApi = {
  flow: (o: FlowOptions) => void
  toast: (content: ReactNode) => void
}

export const FlowContext = createContext<FlowApi | null>(null)

export function useFlow() {
  const ctx = useContext(FlowContext)
  if (!ctx) throw new Error('useFlow must be used inside FlowProvider')
  return ctx
}
