# cre/

Chainlink CRE workflows (TypeScript, bun) for Settld, targeting `arc-testnet`.
Your Arc test key goes in `cre/.env` as `CRE_ETH_PRIVATE_KEY` (gitignored).

| Workflow | Trigger | What it does | Status |
|---|---|---|---|
| `ping/` | cron | Sends one number to the Ping contract (proves CRE → Arc) | ✅ live (42) |
| `wf0-certify/` | HTTP `{"dealId": N}` | Reads the deal from ClauseEscrow, rechecks specHash, runs `shared/checker.ts`, sends a Certify report | ✅ live (deal 1 certified) |
| `wf1-verify/` | log `ClauseSubmitted` | YouTube check → Verified / Failed report | planned |

Run from this folder (`--broadcast` sends a real transaction through the mock forwarder):

```bash
cre workflow simulate ping --target staging-settings --non-interactive --trigger-index 0 --broadcast
cre workflow simulate wf0-certify --target staging-settings --non-interactive --trigger-index 0 --http-payload "{\"dealId\":1}" --broadcast
```
