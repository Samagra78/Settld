# shared/

Code and data used by the contracts, the Chainlink workflows, the server and the website.

| File | What it is |
|---|---|
| `report.ts` | The 7-field report format Chainlink sends to ClauseEscrow (`encodeReport` / `decodeReport`) |
| `spec.ts` | The deal fingerprint: `specHash = keccak256(abi.encode(ClauseTerms[]))` |
| `checker.ts` | Deadlock checker: proves a deal's money can never get stuck (runs inside CRE WF0) |
| `checker.test.ts` | Checker tests |
| `fixtures/` | Example deal + expected report bytes everyone tests against |
| `make-fixtures.ts` | Regenerates `fixtures/reports.json` |
| `addresses.json` | Deployed contract addresses on Arc testnet |
| `abi/` | Contract ABIs (`ClauseEscrow.json` = deployed, `.reference.json` = draft) |

```bash
bun install
bun test            # checker tests
bun run fixtures    # regenerate fixtures/reports.json
```
