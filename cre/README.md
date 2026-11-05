# cre/ (Person 1)

Chainlink CRE workflows (TypeScript SDK ≥ 1.3.1, CLI ≥ 1.0.7, bun), targeting `arc-testnet`.

Planned folders:
- `ping/` (S2: minimal workflow writing a number to `Ping.sol` with `--broadcast`)
- `wf0-certify/` (HTTP trigger → read clauses from Arc → checker → `Certify`)
- `wf1-verify/` (log trigger on `ClauseSubmitted` → YouTube API → `Verified` / `Failed`)
- `wf2-daily/` (V2, cron → `Vest` / `Broken`)
- `wf3-court/` (V3, three LLMs → `Opinion`)
- `shared/checker.ts` (deterministic, no network or randomness, so it can run inside WF0)

Start from the official templates: `sports-resolution-ts`, `prediction-market-ts`, `keeper-bot` (https://github.com/smartcontractkit/cre-templates). Change `chainSelectorName` to `arc-testnet` and use the Arc forwarder from `docs/INTERFACES.md`.

Secrets (YouTube / LLM keys) go in CRE secrets, never in the repo.
