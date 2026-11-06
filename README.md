# Settld

**Every clause, settled. No dollar left stuck.**

Settld turns a brand–creator deal into USDC escrow on Arc. Before any money goes in, Chainlink proves the deal can't get stuck. Each clause pays out on its own as soon as Chainlink's nodes verify it. A dispute freezes only the clause in question, and goes to an on-chain court where World ID-verified humans have the final say.

Built at ETHGlobal Mumbai 2026 for:
- **Arc / Circle**: Best Smart Contracts with Advanced Stablecoin Logic, In Arc Studio
- **Chainlink**: Best Workflow with CRE
- **World**: Best Use of IDKit

Product plan: [`docs/SETTLD_FINAL.md`](docs/SETTLD_FINAL.md) · Build plan: [`docs/SETTLD_BUILD_PLAN.md`](docs/SETTLD_BUILD_PLAN.md) · Interfaces: [`docs/INTERFACES.md`](docs/INTERFACES.md)

## What works today (Arc testnet)
| Piece | Status |
|---|---|
| **ClauseEscrow** — deals with clauses, certificate gate, per-clause release, refunds incl. cascade, `expire()` | ✅ deployed via Arc Studio · `0xb95014696c71fb6d3269c5d09713075185191ea8` |
| **Chainlink WF0 (certify)** — reads the deal from the chain, rechecks specHash, runs the deadlock checker, certifies | ✅ certified deal 1 on-chain |
| **Chainlink Ping** — proves CRE → Arc delivery through the forwarder | ✅ `Ping.lastNumber() = 42` |
| **Login** — Circle user-controlled wallets (email code + PIN), balance, test top-up | ✅ |
| **Website** — Ping status, approve USDC, load a deal, fund, release | ✅ |
| WF1 (verify video), create/accept/submit screens, disputes + World ID jury, AI court | ⏳ in progress |

All addresses: [`shared/addresses.json`](shared/addresses.json).

## Repo layout
| Folder | What |
|---|---|
| `contracts/` | Solidity (ClauseEscrow, Chainlink receiver) + tests + deploy script |
| `cre/` | Chainlink CRE workflows: `ping/`, `wf0-certify/`, `wf1-verify/` |
| `shared/` | Report format, deal fingerprint, deadlock checker, fixtures, addresses, ABIs |
| `server/` | Express 5 + TypeScript backend (Circle wallets, prepares escrow transactions) |
| `client/` | Vite + React + TypeScript website |
| `scripts/` | `smoke.ts` (escrow end-to-end test), `create-deal.ts` (test deal on ClauseEscrow) |
| `docs/` | Plans and interfaces |

## Running locally
```bash
cd server && npm install && npm run dev     # http://localhost:3000   (needs server/.env)
cd client && npm install && npm run dev     # http://localhost:5173   (needs client/.env)
```

Tests and scripts:
```bash
cd shared && bun install && bun test                       # deadlock checker tests
cd scripts && bun install && bun run smoke                 # escrow test with test wallets (scripts/.env)
cd scripts && bun run create-deal                          # make a test deal on ClauseEscrow
cd cre && cre workflow simulate wf0-certify --target staging-settings --non-interactive --trigger-index 0 --http-payload "{\"dealId\":1}" --broadcast
```

## How we work with git
- Nobody pushes to `main`. `main` only receives `dev` at version tags.
- `dev` is the integration branch. Each person works on their own branch and merges into `dev` once it builds and tests pass.
- No `.env` files or keys in commits. Each folder has a `.env.example` with the names only.
- `docs/INTERFACES.md` changes only when all three agree.
