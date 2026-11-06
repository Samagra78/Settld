# cre/

Chainlink CRE workflows (TypeScript, bun) for Settld, targeting `arc-testnet`.
Your Arc test key goes in `cre/.env` as `CRE_ETH_PRIVATE_KEY` (gitignored).

| Workflow | Trigger | What it does | Status |
|---|---|---|---|
| `ping/` | cron | Sends one number to the Ping contract (proves CRE → Arc) | ✅ live (42) |
| `wf0-certify/` | **log `DealAccepted`** (automatic) + HTTP `{"dealId": N}` (manual) | Reads the deal from ClauseEscrow, rechecks specHash, runs `shared/checker.ts`, sends a Certify report | ✅ live (deal 2 certified automatically) |
| `wf1-verify/` | **log `ClauseSubmitted`** (automatic) | Reads the clause, checks the YouTube video (nodes agree on the verdict), sends Verified / Failed | ✅ live (deal 2: clause 0 Verified, clause 1 Failed) |

Run from this folder (`--broadcast` sends a real transaction through the mock forwarder):

```bash
cre workflow simulate ping --target staging-settings --non-interactive --trigger-index 0 --broadcast

# WF0 automatic: replay the creator's acceptDeal transaction
cre workflow simulate wf0-certify --target staging-settings --non-interactive --trigger-index 1 --evm-tx-hash <acceptTx> --evm-event-index 0 --broadcast
# WF0 manual
cre workflow simulate wf0-certify --target staging-settings --non-interactive --trigger-index 0 --http-payload "{\"dealId\":1}" --broadcast

# WF1 automatic: replay the creator's submitEvidence transaction
cre workflow simulate wf1-verify --target staging-settings --non-interactive --trigger-index 0 --evm-tx-hash <submitTx> --evm-event-index 0 --broadcast
```

**YouTube key (optional):** put a YouTube Data API v3 key in `cre/.env` as `YOUTUBE_API_KEY_ALL=...`.
Without it, WF1 uses YouTube's public oEmbed lookup: it checks the video exists and is public, and checks
hashtags against the **title only** (reading the description needs the key).

**Test helpers** (`scripts/`): `bun run create-deal` → `bun run fund-and-submit <deal> <clause> <videoId>` → `bun run settle <deal>`.
