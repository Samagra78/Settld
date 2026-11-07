// Types for the framework-free 3D module (settld3d.js).
export type ClauseState = 'locked' | 'checking' | 'verified' | 'paid' | 'frozen' | 'returned' | 'failed'

export interface SceneController {
  dispose(): void
  play(): void
  pause(): void
  replay(): void
  setTime(seconds: number): void
  ready?: Promise<unknown>
}

export interface HandshakeController extends SceneController {
  setScroll(k: number): void
}

export interface VaultClause {
  id: string
  amount?: number
  state: ClauseState
  progress?: number
}

export interface VaultController extends SceneController {
  setClauses(list: VaultClause[]): void
}

export interface JuryController extends SceneController {
  setTimer(fraction: number): void
  decide(side: 'creator' | 'brand'): void
  setArbiter(on: boolean): void
}

export interface CoinsController extends SceneController {
  payout(stackId: string, coins: number): void
}

type Opts = Record<string, unknown> & {
  labels?: HTMLElement | null
  onPick?: (id: string | null) => void
}

export const Settld3D: {
  handshake(canvas: HTMLCanvasElement, opts: Opts & { handUrl: string }): HandshakeController
  vault(canvas: HTMLCanvasElement, opts: Opts & { clauses: VaultClause[] }): VaultController
  jury(canvas: HTMLCanvasElement, opts: Opts): JuryController
  coins(canvas: HTMLCanvasElement, opts: Opts & { stacks: { id: string; paid: number; locked: number }[] }): CoinsController
}
