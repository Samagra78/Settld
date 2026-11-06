# contracts/

Solidity for Settld (V2). `ClauseEscrow` and `AICourt` were **built in Arc Studio** (Samagra); `JurorRegistry` is ours (Mehak).
All three live in `src/` and are compiled, tested and deployed together with Hardhat.

## Deployed (Arc testnet, chain 5042002)
| Contract | Address | Built |
|---|---|---|
| ClauseEscrow v2 | `0x403C33ADB6Fb8989EAA9E29a116996F642064151` | Arc Studio |
| AICourt | `0xb8f86C3f51e31c67cf27D55d788c80ac95B9A2b0` | Arc Studio |
| JurorRegistry v2 | `0xE932eCA0dEBB7A939749F035EA4209F43c42bC7E` | Hardhat (ours) |

- Owner of all three: `0xF808771A6F3d9094319eE344B0fF07009e84Ddc4` (Mehak's CRE test wallet).
- Forwarder (escrow + court): CRE mock forwarder `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1`. USDC `0x3600…0000` (6 decimals).
- Attester (World ID attestations): `0xDC930A8Fa2A3AE6820A30f2FF57863AaF772a861`.
- Linked: `escrow.setCourt(court)`, `court.setJury(registry)`, `registry.setCourt(court)`.
- Addresses + deploy txs: `../shared/addresses.json` and `../shared/deployments/arc-testnet-v2.json`. ABIs: `../shared/abi/`.
- The V1 escrow (`0xb950…1ea8`, no disputes, owned by Studio's shared wallet) is kept as `clauseEscrowV1` for history.

## Commands
```
npm install
npx hardhat test          # JurorRegistry tests + the 3-contract integration test
forge test                # Arc Studio's Foundry tests for ClauseEscrow + AICourt (needs Foundry + lib/forge-std)
DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.ts --network arcTestnet   # deploy + link all three
```
`lib/` is git-ignored: for `forge test`, install Foundry and run `forge install foundry-rs/forge-std --no-git`
(or copy `lib/forge-std` from the Arc Studio export).

## Files
| File | What |
|---|---|
| `src/ClauseEscrow.sol` | Deals, clauses, certificate gate (WF0), CRE verification reports (WF1), release / refund / expire, **disputes** (either party, 120 s window, reason), court split payouts, `resolveStuckDispute` (1-day escape), `evidenceOf`, `caseOf`, `disputeWindowEnd` |
| `src/AICourt.sol` | AI court: cases, kind-6 round reports from WF3 (word budget, extensions, 3–5 min deadline), `closeCase` (median of the three latest bands), appeal fee (10%), `finalize`, `rescueFee`, `claimFee` |
| `src/JurorRegistry.sol` | Human arbitrators (appeal only): World ID attestation → one wallet per human, commit/reveal band votes, majority + strikes, suspension per World ID |
| `src/IAICourt.sol`, `src/IJurorRegistry.sol`, `src/IClauseEscrowView.sol` | Interfaces between the three |
| `src/cre/` | Chainlink CRE report receiver base (`ReceiverTemplate`) |
| `src/mocks/MockUSDC.sol` | Hardhat tests only. Never deploy |
| `test/JurorRegistry.test.ts` | Registry tests (24) |
| `test/Settld.Integration.test.ts` | All three contracts wired like production: no-appeal 80/20 split, appeal overruled by World ID arbitrators, court round rules |
| `test-forge/`, `test-helpers/` | Arc Studio's Foundry tests (ClauseEscrow + AICourt) |
| `scripts/deploy.ts` | Deploys and links all three; writes `shared/deployments/arc-testnet-v2.json` |

## Known and accepted for the testnet demo
- The mock forwarder does no sender checks, so anyone could forge CRE reports. Use the production forwarder before relying on it.
- Fee payouts that fail become claimable credits (`claimFee`) instead of blocking finalize.
