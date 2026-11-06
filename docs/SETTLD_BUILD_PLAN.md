# Settld: Build Plan (version by version)

> Companion to `SETTLD_FINAL.md` (the product, the story, the tracks). This doc covers **what we build, in what order, and who does what.**
> Start: ~1:30 am, Nov 6 · Approach: **Arc first, then thin end-to-end slices** · Every version must fully work before the next one starts.

---

## How we work
1. **Arc first.** The contracts and app work on Arc with a **tester wallet standing in for Chainlink**. CRE replaces the tester later with **no contract code change**: the contract inherits `ReceiverTemplate`, so we only call `setForwarderAddress(...)`.
2. **Thin end-to-end slices.** All three of us build the same feature at once (screen → contract → CRE → screen), each on our own layer.
3. **Integrate every 60–90 minutes**, not at the end.
4. **A version is done** only when it works end to end on Arc testnet **3 times in a row**. Then: commit → git tag → record a 20-second clip.
5. **Stuck for 30 minutes? Say so.** Everyone helps.
6. **Interfaces change only if all three agree.** Update `docs/INTERFACES.md` first.
7. **Commit small and often**, with clear messages. Judges check commit history, and AI-only work can be ruled ineligible.

## Stack (final)
| Layer | Choice |
|---|---|
| Contracts | Solidity ^0.8.24 + OpenZeppelin (SafeERC20, ReentrancyGuard, ECDSA, EIP712) · Foundry (or Studio's test runner) · `ReceiverTemplate.sol` / `IReceiver.sol` from the CRE `sports-resolution-ts` template |
| Frontend | **Vite + React + TypeScript** · Tailwind · wagmi v2 + viem + @tanstack/react-query + RainbowKit · @worldcoin/idkit · sonner |
| Backend | **Express 5 + TypeScript (tsx)** in `server/` · viem (signs attestations) · cors · dotenv · Vite proxy `/api` → `http://localhost:3000` |
| CRE | CRE CLI ≥1.0.7, TS SDK ≥1.3.1, bun · chain name `arc-testnet` |
| Storage | JSON store in the backend until v3, then Pinata (IPFS) |
| Not using | Next.js, a database, a subgraph, Docker, Redux, Hardhat |

**Arc facts:** chain ID `5042002` · RPC `https://rpc.testnet.arc.network` · explorer `testnet.arcscan.app` · USDC `0x3600000000000000000000000000000000000000` (**6 decimals, never `msg.value`**) · Circle Faucet → Arc Testnet
**CRE forwarders on Arc:** mock (simulation) `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` · production `0x76c9cf548b4179F8901cda1f8623568b58215E62`

## Repo layout
```
settld/
├── contracts/   src/ ClauseEscrow.sol SettldEscrow.sol JurorRegistry.sol AICourt.sol ReceiverTemplate.sol IReceiver.sol
│                test/
├── cre/         wf0-certify/ wf1-verify/ wf2-daily/ wf3-court/   shared/ checker.ts report.ts
├── client/      Vite React TS app   src/lib/ abi.ts chain.ts report.ts
├── server/      Express + TS (tsx)  src/index.ts src/routes/ worldid.ts certify.ts deals.ts
└── docs/        INTERFACES.md architecture.png
```
`.gitignore` must include `.env*` **before the first commit.** Test wallets only.

---

## Version overview
| Version | Goal | Clock target | Tag |
|---|---|---|---|
| **V0** | Arc + Arc Studio setup; a USDC transaction from the UI | 1:30 → 2:30 am | `v0` |
| **V1a** | Full escrow on Arc, with the tester wallet as the oracle | 2:30 → 6:00 am | `v1a` |
| **V1b** | CRE replaces the tester (WF0 certify + WF1 verify) | 6:00 → 10:00 am | `v1b` |
| **V1c** | Disputes + World ID human jury → **v1 complete** | 10:00 am → 2:00 pm | `v1` + backup video |
| **V2** | Day-by-day vesting (WF2) + payout splits | 2:00 → 6:00 pm | `v2` |
| **V3** | On-chain AI court (WF3) + appeal bond + staked jury | 6:00 pm → midnight | `v3` |
| **V4** | Extraction, EIP-712, Circle developer tool, reuse guide | If time allows | `v4` |
| **Freeze** | README, diagram, video (with the Studio clip), submit | Last 3 hours | `final` |

If a version slips, **cut scope inside it**. Don't start the next one.

---

## V0: Arc and Arc Studio setup
**Functionality:** connect a wallet → see the USDC balance → fund a simple escrow → release it.
| Area | Requirements |
|---|---|
| Setup | One shared Arc Studio project (save the **shareable URL**) · 3 test wallets: **brand, creator, tester** · Arc testnet added · test USDC for all three |
| Contract | Simple escrow (fund → release) generated **in Studio**, with tests, deployed |
| Frontend | Connect wallet, USDC balance, Fund, Release |
| Backend | Express "hello" route + Vite proxy working |
| Done when | Fund + release from the UI, visible on arcscan |

## V1a: full escrow on Arc (tester wallet = oracle)
**Functionality:**
- Brand creates a deal with up to 3 clauses ("posted by date", "description contains text"), with amounts, dependency and `onFail`
- Creator accepts
- **Tester sends `Certify`** → brand approves + funds. **Funding fails without a certificate.**
- Creator submits a video ID
- **Tester sends `Verified` / `Failed`**
- Verified → after the 2-minute window, **anyone calls `release()`**
- Failed → refund

| Area | Requirements |
|---|---|
| Contracts | `ClauseEscrow` (core) inheriting `ReceiverTemplate`, plus `SettldEscrow` · `proposeDeal` (amounts add up, ≤5 clauses, `specHash = keccak256(abi.encode(clauses))`) · `acceptDeal` · `fundDeal` (certificate gate, SafeERC20) · `submitEvidence` (emits `ClauseSubmitted`) · `_processReport` (Certify / Verified / Failed) · `release` (window passed + dependency Released) · `refund` · **forwarder = tester wallet** |
| Tests | Amounts add up · funding without a certificate reverts · USDC never created or lost · no double payment · only the forwarder can report · dependency respected |
| Frontend | **Role switch** (Brand / Creator / Oracle simulator) · **Create deal** (clause form, running total must match) · **Deal page** (a card per clause: status, amount, timer; buttons Accept / Approve + Fund / Submit video / Release / Refund) · **Oracle simulator panel** (send Certify / Verified / Failed) · local-currency equivalent · readable errors · explorer links |
| Backend | `POST/GET /api/deals`: stores the plain-English text and clause JSON by `specHash` · `/api/report/encode`: encodes reports for the simulator panel (shared `report.ts`) |
| Done when | Full path 3× from scratch, including one clause failing → refund while another pays out |

## V1b: CRE replaces the tester
**Functionality:** the same product; Chainlink's nodes send the reports. The checker blocks a broken deal.
| Area | Requirements |
|---|---|
| CRE | **WF0:** HTTP trigger with `dealId` → EVM-read the clauses → `checker.ts` (breadth-first search) → `Certify(specHash)` · **WF1:** watches `ClauseSubmitted` → YouTube API (`part=snippet,status`, filtered fields) → `Verified` / `Failed` · `writeReport` with gas config · both statuses checked |
| Contracts | `setForwarderAddress(0x6E9E…eDc1)` (mock forwarder). **No other change.** Workflow-ID check **off** in simulation. |
| Frontend | Simulator panel hidden (dev toggle) · "Certify" calls the backend → WF0 · shows the checker's reason on refusal · "Verified by Chainlink" + transaction link |
| Backend | `POST /api/certify`: triggers WF0 (HTTP trigger, or runs `cre workflow simulate … --broadcast` in demo mode) |
| Done when | A real YouTube video gets verified by CRE and paid on Arc · a circular-dependency deal is refused |

## V1c: disputes + World ID jury → v1 complete
**Functionality:** the brand disputes during the window → only that clause freezes → 3 World ID-verified jurors (not parties) vote → majority settles it.
| Area | Requirements |
|---|---|
| Contracts | `dispute()` (brand, within window, freezes one clause) · `JurorRegistry`: `registerPerson(nullifier, attestation)` (one per nullifier; checks the backend's ECDSA signature), parties' nullifiers recorded at accept/fund, `vote(dealId, clauseId, payCreator)` (registered and not a party), majority of 3 → escrow settles |
| Tests | Duplicate nullifier rejected · party vote rejected · dispute freezes only its own clause · majority settles correctly |
| Frontend | "Verify with World ID" (IDKit simulator, action `settld-member`, signal = wallet) · Dispute button with countdown · **Juror page** (disputed clauses, vote buttons, live count) |
| Backend | `POST /api/worldid`: verify the proof → sign `(nullifier, wallet)` with `ATTESTER_PRIVATE_KEY` → return the signature |
| Done when | Dispute → 3 votes → settled · duplicate human rejected · party blocked → **tag `v1`, record the backup video, write the first README sections** |

## V2: vesting + splits
**Functionality:** "Stays public for N days" pays out day by day; going private stops payments and refunds the rest; every payout is split.
| Area | Requirements |
|---|---|
| Contracts | `STAYS_PUBLIC` clause: `vestDays`, `daysVested`, `Vest` (multiply before dividing), `Broken` → refund the rest and apply `onFail` to dependent clauses · `payees[]` + `splitBps[]` applied on every release |
| CRE | **WF2:** cron (every minute in demo mode) → still public? → `Vest(days)` / `Broken` · checker handles "a dependency breaks" (the stuck-money demo) |
| Frontend | Vesting progress bar · split editor · checker warning shown before certify · demo clock (1 day = 1 minute) |
| Backend | Demo-mode time settings |
| Done when | Video made private mid-way → the rest is refunded exactly as the checker predicted · splits paid correctly |

## V3: on-chain AI court
**Functionality:** subjective clause or dispute → filings on-chain → 3 models via CRE → the contract checks citations and counts the majority → appeal with a bond → staked World ID jury → final.
| Area | Requirements |
|---|---|
| Contracts | `AICourt`: open case, `fileStatement(cid, evidenceIds)`, evidence registry, `Opinion` reports, **on-chain citation check**, **on-chain majority**, timeout → humans · appeal bond (10% of the clause, with a minimum) · equal juror stakes · hidden-then-revealed voting · random draw (`prevrandao`) · losing bond split among majority jurors · escrow pays the court's fee |
| CRE | **WF3:** watches `CaseOpened` → 3 providers at temperature 0 → agree on `{band, citedIds}` → `Opinion` reports |
| Frontend | Courtroom page: filings, 3 opinions + citations, the rejected made-up citation highlighted, verdict, Appeal button showing the bond · juror hidden-vote flow |
| Backend | Filing form → Pinata (IPFS) · packages the evidence for WF3 |
| Done when | The full demo story (`SETTLD_FINAL.md` §6) runs from start to finish |

## V4: if time allows
Plain-English extraction (`/api/extract`) · EIP-712 signing of `specHash` · juror qualification test · **one Circle developer tool** (Circle Wallets sign-in or EURC) · `ClauseEscrow` reuse guide in the README

## Freeze (last 3 hours)
README (sections for Arc / CRE / World ID, "Built in Arc Studio", "Reuse ClauseEscrow", trust assumptions) · architecture diagram · video (≤ limit, includes the **Studio clip**) · Studio URL · contract addresses + explorer links · submission naming each bounty exactly.

---

# V1 in detail: who does what

## Hour 0 (everyone, ~15 min): agree on the interfaces
Write `docs/INTERFACES.md` with: the `Clause` / `Deal` structs, the events, the **CRE report format** `(uint8 kind, uint256 dealId, uint8 clauseId, uint8 value, bytes32 data, uint64 sourceSelector, uint64 timestamp)`, and the chain configuration. See `SETTLD_FINAL.md` §7. **Freeze it.**

## V0 (1:30 → 2:30 am)
| Person | Tasks |
|---|---|
| **P1 (CRE)** | 30 min: update the SDK to ≥1.3.1 · `cre login` · `cre workflow supported-chains` · **test whether `simulate --broadcast` changes state on a test contract on Arc** → report the result to the team. Then help with V0 setup. |
| **P2 (contracts)** | Create the Arc Studio project, share the URL · generate the simple escrow + tests in Studio · deploy · share address + ABI |
| **P3 (app)** | `client/` (Vite React TS) + `server/` (Express + TypeScript) · wagmi config for Arc testnet · connect wallet + USDC balance · Fund / Release buttons against P2's contract · Vite proxy |
| **Checkpoint 2:30** | Fund + release from the UI on arcscan → tag `v0` |

## V1a (2:30 → 6:00 am)
| Person | Tasks | Hands off |
|---|---|---|
| **P2 (contracts)** | Arc Studio prompt (`SETTLD_FINAL.md` / the earlier chat) → `ClauseEscrow` + `SettldEscrow` on `ReceiverTemplate` · review the output against the safety rules · tests · deploy with **forwarder = tester wallet** | ABI + address → `client/src/lib/abi.ts` (by 3:45) |
| **P1 (CRE)** | Write the shared `report.ts` (viem `encodeAbiParameters`, the exact format) · write `checker.ts` v1 (breadth-first search: circular dependency, unreachable end state, amounts add up) + unit tests · prepare the WF0/WF1 folders from the templates, set to `arc-testnet` | `report.ts` → P3 (by 3:00) |
| **P3 (app)** | Role switch · Create deal page · Deal page · Oracle simulator panel (uses `report.ts`, sends from the tester wallet) · `/api/deals` · `/api/report/encode` | Pages wired to the ABI (by 5:00) |
| **Checkpoint 3:45** | Contract deployed; simulator panel sends Certify and the certificate appears | |
| **Checkpoint 5:00** | Full path once: propose → accept → certify → fund → submit → verified → release | |
| **Checkpoint 6:00** | 3× from scratch, including a failed clause → refund → tag `v1a` | |

**Sleep shift 1 (after 6:00):** P3 sleeps 6:00–9:00 (their V1b work is the lightest). P1 and P2 continue.

## V1b (6:00 → 10:00 am)
| Person | Tasks |
|---|---|
| **P1 (CRE)** | WF0: HTTP trigger → EVM read of the clauses → `checker.ts` → `Certify` · WF1: log trigger on `ClauseSubmitted` → YouTube API → `Verified` / `Failed` · simulate with `--broadcast` against the real contract |
| **P2 (contracts)** | `setForwarderAddress(mock forwarder)` · add any getters WF0 needs to read the clauses · keep the tests green · start `JurorRegistry` + `dispute()` for V1c (on a branch) |
| **P3 (app, from 9:00)** | Hide the simulator behind a dev toggle · Certify button → `/api/certify` → WF0 · show the checker's reason / "Verified by Chainlink" + transaction link |
| **Checkpoint 8:00** | WF0 certifies a real deal on Arc |
| **Checkpoint 10:00** | Real YouTube video → CRE verifies → paid · broken deal refused → tag `v1b` |

**Sleep shift 2:** P1 sleeps 10:00–1:00 (V1c needs them least). P2 sleeps 1:00–4:00 pm, after V1c's contract work is merged.

## V1c (10:00 am → 2:00 pm)
| Person | Tasks |
|---|---|
| **P2 (contracts)** | `dispute()` · `JurorRegistry` (`registerPerson` checks the attester signature, one per nullifier; parties' nullifiers recorded; `vote` blocks parties; majority of 3 → settle) · tests · deploy, share ABI |
| **P3 (app)** | `/api/worldid` (verify proof → sign attestation) · IDKit button (simulator, action `settld-member`, signal = wallet) · Dispute button + countdown · Juror page with live count |
| **P1 (CRE, after 1:00 pm)** | Make sure WF1 doesn't verify a disputed clause · start WF2 for V2 |
| **Checkpoint 12:00** | World ID registration recorded on-chain |
| **Checkpoint 2:00 pm** | Dispute → 3 votes → settled · duplicate human rejected · party blocked → **tag `v1` · record the backup video · README v1 sections** |

---

# Step-by-step integration plan: small steps, all three together

Each step takes **30–60 minutes**. In every step, **all three of us build one small piece of the same feature**, then **integrate it together and test it** before anyone moves on. That means the app never goes more than an hour without working end to end.

## The routine for every step
1. **Start (2 min):** read the step aloud and agree what "done" looks like.
2. **Build (25–50 min):** each person does their part.
3. **Integrate (5–10 min):** pull, run the **smoke script**, click through the UI together.
4. **Commit and tag the step** (`s1`, `s2`, …), then move on.

**If a step's test fails, nobody starts the next step.** All three fix it.

## Two shared tools (make these in step 1)
- **`shared/fixtures/`**: one example deal (`deal1.json`) plus the **expected encoded report bytes** for each report type. **The contract tests, the CRE code and the frontend all test against the same fixtures**, so the encoding can't silently drift apart.
- **`scripts/smoke.ts`** (maintained by P1): runs the full path built so far **from the command line** against Arc testnet and prints ✅ or ❌ for each stage. Run it at the end of every step, so anything that breaks is caught immediately.

---

## V0: foundation

### S1: interfaces + repo (15 min)
| P1 | P2 | P3 |
|---|---|---|
| Create `shared/fixtures/deal1.json` + `report.ts` (encoding) | Create the Arc Studio project, share the URL | Create the repo (`client/`, `server/`, `contracts/`, `cre/`, `shared/`, `docs/`), `.gitignore` with `.env*` |

**Test:** `docs/INTERFACES.md` committed, all three can pull the repo and open the Studio project.

### S2: the first end-to-end test, a "Ping" contract (45 min) ⭐
The **hardest connection, CRE → Arc → UI, is proven first**, on a tiny contract.
| P1 | P2 | P3 |
|---|---|---|
| Minimal workflow that sends `report(number)` with `simulate --broadcast` | `Ping.sol` inherits `ReceiverTemplate`, stores the last number, emits `Pinged`; forwarder = **mock forwarder**; deploy from Studio | Vite app: connect wallet (Arc testnet), read and show `Ping.last()`, refreshing every few seconds |

**Test:** P1 runs the workflow → **the number appears in P3's UI.**
**If it fails:** CRE can't write to Arc in simulation. Switch Ping's forwarder to the **tester wallet**, carry on with the rest of the plan, and P1 takes the question to the Chainlink team.

### S3: USDC moves (45 min)
| P1 | P2 | P3 |
|---|---|---|
| Add "fund + release" to `smoke.ts` | Simple escrow: `fund` (SafeERC20 `transferFrom`), `release`; tests | USDC balance, **Approve → Fund** (two steps), Release, explorer links, sonner toasts |

**Test:** fund and release from the UI, the balances change, and the smoke script passes → **tag `v0`**

---

## V1a: the escrow on Arc (tester wallet = oracle)

### S4: create and read a deal (45 min)
| P1 | P2 | P3 |
|---|---|---|
| `checker.ts` v0: run locally on `deal1.json` (amounts add up, no circular dependencies) | `proposeDeal` (amounts add up, `specHash`), `acceptDeal`, getters `getDeal` / `getClause`; tests using `deal1.json` | Create-deal form (1 clause) → transaction → deal page reads it back |

**Test:** create the deal in the UI, accept it as the creator, the deal page shows the clauses and `specHash` matches `checker.ts`'s computed hash.

### S5: certificate gate (45 min)
| P1 | P2 | P3 |
|---|---|---|
| Fixture: the expected `Certify` report bytes; check `report.ts` produces exactly those bytes | `_processReport` → Certify; `fundDeal` requires the certificate; **switch the forwarder to the tester wallet** for V1a; tests using the fixture bytes | **Oracle simulator panel:** "Send Certify" from the tester wallet; Fund button disabled until certified, with the reason shown |

**Test:** fund **before** the certificate → refused · send Certify → fund → works.

### S6: deliver → verified → released (60 min)
| P1 | P2 | P3 |
|---|---|---|
| WF1 skeleton: log trigger on `ClauseSubmitted`, decodes the event (simulate without broadcast) | `submitEvidence` (emits the event), `_processReport` → Verified, `release` (2-minute window, callable by anyone); tests | Submit-video field · "Send Verified" in the simulator · countdown timer · Release button |

**Test:** submit → WF1 skeleton **logs the right deal and clause** → simulator sends Verified → after 2 minutes, Release → creator's balance goes up.

### S7: multiple clauses, failure, dependency (60 min)
| P1 | P2 | P3 |
|---|---|---|
| `checker.ts`: dependencies + `onFail` + "can money always reach an end state?"; unit tests (valid / circular / stuck) | Up to 5 clauses, `dependsOn`, Failed → `refund`; tests | Multi-clause form with a running total · "Send Failed" · Refund button · status colours |

**Test:** 2-clause deal: C1 Verified → released, C2 Failed → refunded · run 3 times from scratch · smoke script passes → **tag `v1a`**

---

## V1b: Chainlink takes over

### S8: real WF0 certification (60 min)
| P1 | P2 | P3 |
|---|---|---|
| WF0: HTTP trigger with `dealId` → EVM read of the clauses → `checker.ts` → `Certify` (`--broadcast`) | `setForwarderAddress(mock forwarder)`; add any read functions WF0 needs | "Certify" button → `POST /api/certify` → triggers WF0; shows the checker's reason if refused |

**Test:** a valid deal is certified by CRE · a circular-dependency deal is refused, with the reason shown in the UI.

### S9: real WF1 YouTube check (60 min)
| P1 | P2 | P3 |
|---|---|---|
| WF1: YouTube API (`part=snippet,status`, filtered fields) → Verified / Failed; API key as a CRE secret | Support: make sure Verified / Failed from CRE behave exactly like the tester's; tests still green | "Verified by Chainlink" badge + transaction link; simulator hidden behind a dev toggle |

**Test:** a real public video with the tag → Verified → released · wrong tag → Failed → refunded → **tag `v1b`**

---

## V1c: disputes + World ID jury

### S10: World ID registration (60 min)
| P1 | P2 | P3 |
|---|---|---|
| `server/` attestation signing with viem (`sign(nullifier, wallet)`) + a fixture signature | `JurorRegistry.registerPerson(nullifier, sig)`: checks the attester signature (ECDSA), one per nullifier; tests using the fixture | IDKit button (simulator, action `settld-member`, signal = wallet) → `POST /api/worldid` → registers on-chain |

**Test:** register → the nullifier is on-chain · **the same World ID again → rejected.**

### S11: dispute freezes one clause (45 min)
| P1 | P2 | P3 |
|---|---|---|
| WF1 skips clauses already disputed | `dispute()` (brand, within window) freezes only that clause; parties' nullifiers recorded; tests | Dispute button with countdown; frozen clause shown, other clauses still releasable |

**Test:** dispute C2 → C2 frozen · C1 still releases normally.

### S12: jury vote settles it (60 min)
| P1 | P2 | P3 |
|---|---|---|
| `smoke.ts`: registers 3 test jurors + votes, from the command line | `vote(dealId, clauseId, payCreator)` (registered and not a party); majority of 3 → settle; tests | Juror page: disputed clauses, vote buttons, live count, result |

**Test:** 3 jurors vote → settled correctly · **a party trying to vote → rejected** · full v1 path run 3 times → **tag `v1` · record the backup video**

---

## V2 and V3 use the same routine
- **V2:** S13 vesting clause (contract + WF2 + progress bar) → S14 Broken → refund the rest (+ the checker's stuck-money warning) → S15 payout splits → tag `v2`
- **V3:** S16 open a case + filings + evidence registry → S17 WF3 one model → one Opinion → S18 three models + on-chain citation check + majority → S19 appeal bond + staked hidden voting → S20 escrow pays the court fee → tag `v3`

---

## V1 checklist (everything must be ✅ before V2)
- [ ] Arc Studio project URL shared, and the contracts were built and tested in Studio
- [ ] `ClauseEscrow` (reusable core) + `SettldEscrow` deployed on Arc testnet
- [ ] Funding refused without a CRE certificate
- [ ] WF0 certifies by reading clauses from the chain; the checker refuses a broken deal
- [ ] WF1 verifies a real YouTube video; Verified → release, Failed → refund
- [ ] A dispute freezes only that clause; the World ID jury settles it
- [ ] Duplicate human rejected · party blocked from voting
- [ ] Frontend + backend working; explorer links for every action
- [ ] Tests green: amounts add up · USDC never created or lost · no double payment · only the forwarder can report
- [ ] Backup video recorded · tag `v1` pushed
