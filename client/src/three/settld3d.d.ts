// Types for settld3d.js (framework-free three.js scenes). Each factory takes a canvas plus
// options and returns a controller. Call dispose() when the view unmounts.

export type ClauseState3D =
  | 'locked'
  | 'checking'
  | 'verified'
  | 'paid'
  | 'returning'
  | 'returned'
  | 'failed'
  | 'frozen'
  | 'pending'

export interface Controller {
  play(): void
  pause(): void
  replay(): void
  setTime(seconds: number): void
  time(): number
  isPlaying(): boolean
  dispose(): void
  ready: Promise<unknown>
}

export interface HandshakeController extends Controller {
  setScroll(k: number): void
}

export interface VaultClause {
  id: string
  amount?: number
  state: ClauseState3D
  progress?: number
}

export interface VaultController extends Controller {
  setClauses(list: VaultClause[]): void
  focus(id: string | null): void
}

export interface CoinsController extends Controller {
  payout(stackId: string, coins: number): void
}

export interface JuryController extends Controller {
  setTimer(fraction: number): void
  seal(i: number): void
  reveal(): void
  decide(side: 'creator' | 'brand'): void
  setArbiter(on: boolean): void
}

type Opts = Record<string, unknown>

export interface Settld3DApi {
  handshake(canvas: HTMLCanvasElement, opts?: Opts & { handUrl?: string }): HandshakeController
  vault(
    canvas: HTMLCanvasElement,
    opts: Opts & {
      clauses: VaultClause[]
      labels?: HTMLElement | null
      onPick?: (id: string | null) => void
    },
  ): VaultController
  coins(
    canvas: HTMLCanvasElement,
    opts: Opts & {
      stacks: { id: string; paid: number; locked: number }[]
      labels?: HTMLElement | null
      onPick?: (id: string | null) => void
    },
  ): CoinsController
  jury(
    canvas: HTMLCanvasElement,
    opts: Opts & { labels?: HTMLElement | null; onPick?: (id: string | null) => void },
  ): JuryController
  moment(canvas: HTMLCanvasElement, opts?: Opts): Controller
}

export declare const Settld3D: Settld3DApi
export default Settld3D
