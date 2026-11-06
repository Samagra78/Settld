# Settld

**Every clause, settled. No dollar left stuck.**

Settld turns a brand–creator deal into USDC escrow on Arc. Before any money goes in, it proves the deal can't get stuck. Each clause pays out on its own as soon as Chainlink's nodes verify it. A dispute freezes only the clause in question, and goes to an on-chain AI court where World ID-verified humans have the final say.

Built at ETHGlobal Mumbai 2026 for:
- **Arc / Circle**: Best Smart Contracts with Advanced Stablecoin Logic, In Arc Studio
- **Chainlink**: Best Workflow with CRE
- **World**: Best Use of IDKit

Full product plan: [`docs/SETTLD_FINAL.md`](docs/SETTLD_FINAL.md) · Build plan: [`docs/SETTLD_BUILD_PLAN.md`](docs/SETTLD_BUILD_PLAN.md) · Shared interfaces: [`docs/INTERFACES.md`](docs/INTERFACES.md)

## Repo layout
| Folder | What | Owner |
|---|---|---|
| `client/` | Vite + React 19 + TypeScript web app | Person 3 |
| `server/` | Express 5 + TypeScript backend (run with tsx), port 3000 | Person 3 |
| `contracts/` | Solidity contracts + Foundry tests (built in Arc Studio) | Person 2 |
| `cre/` | Chainlink CRE workflows (TypeScript) + checker | Person 1 |
| `shared/` | Fixtures and report encoding shared by all three | Everyone |
| `docs/` | Plans, interfaces, architecture diagram | Everyone |

## Running locally
```bash
cd server && npm install && npm run dev     # http://localhost:3000
cd client && npm install && npm run dev     # http://localhost:5173  (proxies /api to :3000)
```

## How we work with git
- **Nobody pushes to `main`.** `main` only receives merges from `dev` at version tags (`v0`, `v1a`, `v1b`, `v1`, `v2`, `v3`).
- **`dev`** is the integration branch. All work merges into `dev` through pull requests.
- **One branch per step and person:** `s<step>/<area>-<short-name>`, for example:
  - `s2/contracts-ping`, `s2/cre-ping-workflow`, `s2/client-read-ping`
- **Flow for every step:**
  1. `git checkout dev && git pull`
  2. `git checkout -b s<step>/<area>-<name>`
  3. Small commits with clear messages
  4. Push the branch, open a PR into `dev`, one teammate reviews
  5. Merge, then all three pull `dev` and run the step's integration test together
- **Before merging into `dev`:** it builds, tests pass, and no `.env` or keys are included.
- **Interfaces** (`docs/INTERFACES.md`) change only in a PR that all three approve.

## Environment variables
Never commit them. Each folder gets a `.env.example` listing the names only.
