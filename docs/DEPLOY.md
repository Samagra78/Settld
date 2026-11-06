# Deploying the Settld backend

## How we run it (our CRE account has no API keys → "Plan B")
| Where | What runs | Settings |
|---|---|---|
| **Host (Railway)** | API, World ID, arbitrator dashboard, court data, read-only `/monitor` — always online | `AUTOMATION_ENABLED=false`, `MONGODB_URI` (Atlas), `NODE_ENV=production` |
| **Laptop** (`npm run dev` in `server/`) | watcher + keeper: runs the Chainlink CRE workflows (`cre` is logged in here) and settles payouts | `AUTOMATION_ENABLED=true`, **same** `MONGODB_URI` |

Both use the same MongoDB Atlas database, so everything the laptop's automation does (certificates, AI court rounds,
verdicts, payouts, transcripts) shows up on the hosted API immediately. `bun run host-env` (in `scripts/`) writes the
host's settings to `.env.deploy` with automation off. If CRE API keys become available, set `CRE_API_KEY` on the host
and run `HOST_AUTOMATION=true bun run host-env` to move the automation to the host too.

One container runs everything the backend does: the API, the database connection, the watcher (runs the Chainlink
CRE workflows with the `cre` CLI when contract events appear on Arc) and the keeper (settles payouts).
The smart contracts are already deployed on Arc testnet (`shared/addresses.json`).

## What you need (accounts only you can create)
| What | Where | Env var |
|---|---|---|
| MongoDB Atlas free cluster | cloud.mongodb.com → Connect → Drivers → full `mongodb+srv://…` string | `MONGODB_URI` |
| Chainlink CRE API key | app.chain.link → Account Settings → API keys | `CRE_API_KEY` |
| A host that runs Docker 24/7 | **Railway** (recommended: always on, deploys this Dockerfile) — Render's free tier sleeps after 15 min, which stops the watcher | — |

## Environment variables on the host
Copy every value from `server/.env` and `cre/.env` (never commit them), plus:
```
NODE_ENV=production
MONGODB_URI=mongodb+srv://…            # Atlas
CRE_API_KEY=…                           # Chainlink, lets the cre CLI run without a browser login
AUTOMATION_ENABLED=true
MONITOR_PUBLIC=true                     # optional: read-only /monitor page for judges
FRONTEND_ORIGIN=https://your-frontend   # if the site is on another domain (enables the login cookie cross-site)
```
`cre/.env` keys (`CRE_ETH_PRIVATE_KEY`, `GROQ_API_KEY_ALL`, `GEMINI_API_KEY_ALL`, `NVIDIA_API_KEY_ALL`,
`COURT_WRITE_TOKEN_ALL`, `YOUTUBE_API_KEY_ALL`, `GITHUB_TOKEN_ALL`) are written into the container's `cre/.env` at start
by `docker-entrypoint.sh`.

Tip: `bun run host-env` in `scripts/` writes all of them into `.env.deploy` (git-ignored) for a single paste into the
host's "raw environment" editor.

## Railway
1. railway.app → New Project → Deploy from GitHub repo → pick the repo, branch `dev`. It finds the `Dockerfile`.
2. Variables → Raw Editor → paste `.env.deploy`.
3. Settings → Networking → Generate Domain. The API is at `https://<domain>/api/...`, the monitor at `/monitor`.
4. Check: `https://<domain>/api/health` → `{"ok":true}`, `/api/automation/status` → `"enabled": true`.

## Notes
- Arc RPC: `ARC_RPC_URL=https://arc-testnet.drpc.org` (the public endpoint rate-limits). dRPC's free plan only allows
  small log ranges, so the watcher reads 90 blocks at a time (`LOG_CHUNK_BLOCKS`).
- Our CRE access is simulation-only, so workflows run as `cre workflow simulate … --broadcast` inside the container
  (real transactions through Chainlink's mock forwarder on Arc testnet).
- Developer pages (`/worldid-test`, `/circle-test`) and the test helpers are not served in production.
