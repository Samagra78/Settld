# WF1 — Verify submission (skeleton, V1a)

**Trigger:** `ClauseSubmitted(uint256 indexed dealId, uint8 clauseId, string videoId)` emitted by ClauseEscrow on Arc.
**Does (V1b):** reads the clause from the contract → calls the YouTube Data API (`part=snippet,status`, filtered fields) → decides pass/fail → sends a 7-field report (`shared/report.ts`, kind 1 Verified / 2 Failed).

**Status:** waiting for Samagra's ClauseEscrow (V1a) to emit `ClauseSubmitted`.
Build it from the `sports-resolution-ts` template (log trigger + HTTP + writeReport), set `chainSelectorName` to `arc-testnet`.

Simulate against a real event:
```bash
cre workflow simulate wf1-verify --target staging-settings --non-interactive --trigger-index 0 --evm-tx-hash <TX_THAT_EMITTED_ClauseSubmitted> --evm-event-index 0
```
