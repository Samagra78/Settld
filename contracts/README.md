# contracts/

Solidity for Settld. Draft written here and tested with Hardhat; the same `.sol` files are pasted into **Arc Studio** to deploy (the Arc prize wants the Studio clip).

```
npm install
npm test        # 25 tests, uses ../shared/fixtures (deal1.json + reports.json)
npm run abi     # writes ../shared/abi/ClauseEscrow.json
```

## What is actually deployed
The live contract (`shared/addresses.json`) was **generated and deployed in Arc Studio** from the same spec; the files in `src/` are the tested reference draft, not what is on chain. Use **`shared/abi/ClauseEscrow.json`** (the deployed ABI). `shared/abi/ClauseEscrow.reference.json` is the draft's ABI and does not match.

Differences to know about (deployed vs the table below):
- Getter `usdc()` (not `token()`); forwarder functions are `getForwarderAddress` / `setForwarderAddress`; `setExpectedWorkflowName` takes a `string`.
- Constants are `RELEASE_WINDOW` (120) and `SUBMITTED_TIMEOUT` (86400); status numbers are exposed as `Pending()`, `Submitted()`, ... `Refunded()`.
- `dependsOn` must be a strictly earlier clause index. `DealCertified(dealId)` has no `specHash`.
- Custom error names differ (e.g. `ReleaseWindowActive`, `RefundNotAllowed`, `InvalidReportKind`, `NotExpired`, `DependencyNotReleased`).
- Owner is Studio's shared deployer wallet, so the forwarder and workflow checks cannot be changed on this deployment. Deploy anew (with your own wallet) before relying on the production forwarder.
- Known and accepted for the testnet demo: the mock forwarder does no sender checks, so anyone could forge reports; and `release` / `refund` pay directly, so a USDC-blocked creator or brand would stall that clause.

## Files
| File | What |
|---|---|
| `src/ClauseEscrow.sol` | Reusable escrow core: deals, clauses, certificate gate, CRE report receiver, release/refund |
| `src/ReceiverTemplate.sol`, `src/IReceiver.sol` | CRE report receiver base. **Review against Chainlink's upstream `cre-templates` before production.** Differs in one way: forwarder can never be `address(0)` |
| `src/mocks/MockUSDC.sol` | Tests only. Never deploy |
| `test/ClauseEscrow.test.ts` | Tests |

`SettldEscrow` (creator-deal app on top) is not written yet; `ClauseEscrow` already covers the whole V1a flow.

## Deploy
Constructor: `ClauseEscrow(forwarder, usdc)`.
- `usdc` = `0x3600000000000000000000000000000000000000` (6 decimals)
- `forwarder` = **tester wallet** for V1a (it calls `onReport` itself); mock forwarder `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` for CRE simulation; production forwarder later.

After deploy: put the address in `docs/INTERFACES.md` and `shared/addresses.json`, set `ESCROW_ADDRESS` in `server/.env`.

## Functions (what CRE and the client call)
| Function | Who | Notes |
|---|---|---|
| `proposeDeal(creator, total, ClauseTerms[])` → `dealId` | brand | ids start at 1. `specHash` computed on-chain. Amounts must add up, 1-5 clauses |
| `acceptDeal(dealId)` | creator | |
| `fundDeal(dealId)` | brand | needs accepted **and** certified. Brand must `approve` USDC first |
| `submitEvidence(dealId, clauseId, videoId)` | creator | emits `ClauseSubmitted` (WF1 trigger) |
| `onReport(metadata, report)` | forwarder only | 7-field report from `shared/report.ts`. Kinds: 0 Certify, 1 Verified, 2 Failed |
| `release(dealId, clauseId)` | anyone | Verified + 120 s window passed + dependency Released → pays creator |
| `refund(dealId, clauseId)` | anyone | Failed, or dependency Refunded (cascade) → pays brand |
| `expire(dealId, clauseId)` | anyone | Pending past deadline, or Submitted with no report for 1 day → Failed |
| `getDeal(dealId)`, `getClause(dealId, i)`, **`getClauses(dealId)`**, `clauseCount`, `certified(dealId)`, `dealCount` | view | `getClauses` is what CRE WF0 reads |

Not in V1a: `dispute` / jury (`Disputed` status is reserved), vesting (`vestDays` stored, unused), report kinds 3-5.

## Trust assumptions
- Only the forwarder can report. The owner (deployer) can change the forwarder and the optional workflow checks, so a malicious owner could forge reports. Money still only ever goes to the deal's own creator or brand, never a third party. **Call `renounceOwnership()` after setup** once the forwarder is final.
- No function lets anyone withdraw funds. Terms cannot change after proposal.
- `sourceSelector` and `timestamp` in reports are carried but not checked; authenticity comes from the forwarder (plus workflow ID/author checks in production).
