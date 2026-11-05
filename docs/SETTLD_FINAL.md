# Settld: Final Plan

> ETHGlobal Mumbai · Nov 5–7, 2026 · Team of 3 · Coding starts 9 pm, Nov 5
> This is the **single source of truth**. It replaces all earlier docs.

---

## 0. In one line
**Settld turns a brand–creator deal into USDC escrow on Arc. Before any money goes in, it proves the deal can't get stuck. Each clause pays out on its own as soon as Chainlink's nodes verify it. A dispute freezes only the clause in question, and goes to an on-chain AI court where verified humans have the final say.**

**Tracks (3 partner programs):**
| Sponsor | Exact track | Prize |
|---|---|---|
| Arc / Circle | **Best Smart Contracts with Advanced Stablecoin Logic, In Arc Studio** | $3,000 |
| Chainlink | **Best Workflow with CRE** (CCIP optional, same partner) | $1,500 |
| World | **Best Use of IDKit** (not the "[Cont]" version) | $2,500 |

---

## 1. The story

**Act 1: the world today.** Brands pay creators for sponsored content, a global market worth hundreds of billions of dollars. A deal is a PDF and a promise: *"Post by the 20th, include our link, keep it up 30 days, show the product well. We'll pay on delivery."*

**Act 2: what goes wrong.**
- Creators deliver, then wait months to be paid, or lose the whole fee over one small disagreement.
- Brands pay up front, then the video disappears or the required disclosure is missing.
- Contracts are broken from the start: vague terms, and conditions that depend on each other so money ends up stuck.
- No realistic way to resolve it: a $500 dispute isn't worth a lawyer, the parties are in different countries, and every platform controls its own dispute process.

**Act 3: Settld.**
> *"We prove the contract can't get stuck before it's signed, pay each clause the moment it's verified, and when there's a dispute, freeze only that clause and send it to an on-chain court where AI judges first and verified humans have the final say."*

**Why not a real court?** These disputes are too small, too fast and too often cross-border. Nobody hires a lawyer over a $500 clause. eBay and PayPal settle huge numbers of small disputes outside courts because they hold the money. Settld does the same with **no platform in control**: the money is already in escrow, and **the ruling is the payment**. Neither party gives up the right to go to court.

---

## 2. What makes it different (the USP)
> **"Every dollar in a deal always has a way out. We prove it before funding, the contract enforces it while the deal runs, and a dispute only holds up the disputed clause."**

1. **Checked before funded:** a checker proves money can always reach an end state. Chainlink's nodes certify it, and the escrow refuses funding without the certificate.
2. **Clause-level escrow:** each clause has its own USDC, its own agreed proof and its own dispute. Day-by-day vesting and payout splits.
3. **On-chain AI court:** filings, evidence, 3 model opinions via CRE, the citation check and the majority count are all on-chain. If the nodes can't agree, the case goes to humans.
4. **Humans have the final say:** World ID-verified, anonymous, staked jurors. Parties can't judge their own case.

**What the jury may decide:** facts checked by Chainlink's nodes (posted? tag present? still public?) are **final**. An "oracle failure" claim triggers a **CRE re-check**, not a human vote. **Humans only rule on what machines can't measure** (quality, tone), and only on appeal.

Say *"we haven't seen another escrow that does all of these"*, not *"we're the only one"*. Search the ETHGlobal showcase for "escrow", "dispute" and "court" before making any "first" claim.

---

## 3. The deal flow, mapped to the Arc track

**Key:** 🔀 conditional flow · ⚙️ on-chain automation · 🪜 multi-step settlement · 🛡️ escrow with dispute and automatic release · 📅 vesting/payroll · ✂️ splitting · 🤖 software-to-software payment · ♻️ reusable contract · 🔵 Circle developer tool · 🎨 Arc Studio · ➕ small addition

1. **Draft:** brand and creator write the deal in plain English. ➕🔵 Sign-in via Circle Wallets (no MetaMask). 🎨 The app is built in the Arc Studio project.
2. **Extract:** a backend LLM creates structured clauses, each linked to its source sentence, every sentence accounted for, vague clauses flagged. **The AI never assigns money.**
3. **Set terms:** the parties set each clause's amount, agreed evidence and juror requirements, plus ✂️ payout splits (e.g. creator 85 / manager 10 / editor 5) and ➕🔵 currency (USDC or EURC).
4. **Check and certify:** the checker runs **inside CRE's WF0**, reading the clauses **from the contract**, then `certify(specHash)` on Arc. 🔀 The certificate unlocks funding. ♻️ This is ClauseEscrow's general certificate gate.
5. **Sign and fund:** both parties sign the exact structured version (EIP-712). The brand approves and deposits. 🔀 **Funding is refused without the certificate.** 🛡️ No admin key.
6. **Deliver:** the creator submits the video ID, which emits `ClauseSubmitted`.
7. **Verify:** WF1 (YouTube API: posted, link and #ad tag present) ⚙️ writes the result on-chain. WF2 (scheduled: still public?) 📅 releases that day's share. ♻️ Verification goes through the `IClauseVerifier` hook.
8. **Settle:** 🛡️🪜 each verified clause is paid after its dispute window, and `release()` can be called by anyone. ✂️ Every payout is split in the same transaction. 📅 Ongoing clauses vest day by day, and if one breaks the unpaid rest is refunded. 🔀 Failed clauses follow `onFail`. *(Stretch: cross-chain payout via Circle's cross-chain tooling, only if Arc confirms it.)*
9. **AI court:** subjective clauses and disputes go to `AICourt`. Filings and evidence IDs on-chain. WF3 runs 3 models at temperature 0, and the nodes agree only on `{band, citedEvidenceIds}`. **The contract rejects unregistered citations and counts the majority itself.** No agreement → humans. 🛡️ Only that clause is frozen. ➕🤖 The escrow pays the court's AI-compute fee from the dispute fee. ♻️ The court plugs in via the `ICourt` hook.
10. **Appeal:** escalate by posting **10% of the disputed clause's value** (with a minimum). Otherwise the AI ruling is carried out automatically. 🔀🪜
11. **Human jury:** 3–5 random jurors: World ID verified, qualified, deposit locked, no conflict of interest. They vote hidden, then reveal. **Majority is final**, for that clause only. ✂️ The losing bond is split among the majority jurors.
12. **Deadlines everywhere:** ⚙️ every phase has an on-chain timeout with a default outcome. Money never waits on anyone.

### Clause types
| Clause | Kind | Checked by |
|---|---|---|
| Video posted by a date | One-time | WF1 (YouTube) |
| Description contains the link and **#ad / partnership disclosure** | One-time | WF1 |
| Video stays public for N days | Ongoing (vests daily) | WF2 (scheduled) |
| Product clearly featured, positive tone | Subjective | WF3 AI court |

### Safety rules (must always hold)
1. The AI drafts; the parties decide the money. The AI never sets amounts.
2. Every clause links to its source sentence; no sentence goes missing.
3. Amounts add up to the total (enforced on-chain).
4. Both parties sign the same `specHash`.
5. The rules can't change after funding.
6. A dispute only touches that clause's money.
7. Every state has a deadline or a way out (the checker proves it).
8. No admin key, no withdrawal function.

---

## 4. Architecture
```
 ┌──────────── Arc Studio project (contracts + web app) ────────────┐
 │ Brand: deal builder · checker result · fund · dispute            │
 │ Creator: accept · submit video · payout timeline                 │
 │ Court: filings · 3 model opinions · citations · verdict          │
 │ Juror: World ID · hidden vote · earnings                         │
 └──────┬───────────────────────────────────────────┬───────────────┘
        │                                           │ IDKit
 ┌──────▼──────── Backend ──────────────┐      ┌────▼─────┐
 │ LLM clause extraction · IPFS          │◀────│ World ID │
 │ World ID proof → signed attestation   │      └──────────┘
 └──────┬────────────────────────────────┘
        │
 ┌──────▼─────────────── Arc testnet ───────────────────────────────┐
 │ ClauseEscrow (reusable core) → SettldEscrow                    │
 │ AICourt · JurorRegistry   (report receivers inherit ReceiverTemplate) │
 └──────▲──────────────────────────────▲────────────────────────────┘
        │ writeReport → forwarder        │ events
 ┌──────┴──────── Chainlink CRE (arc-testnet) ──────────────────────┐
 │ WF0 checker · WF1 YouTube · WF2 daily · WF3 court (3 LLMs)       │
 └──────────────────────────────────────────────────────────────────┘
```
**Rule:** off-chain parts only **propose** (drafts, briefs). **The chain and the oracle network decide** (certify, pay, rule, appeal).

---

## 5. Track alignment

### Arc: Best Smart Contracts with Advanced Stablecoin Logic, In Arc Studio
| Wish list | Settld | Status |
|---|---|---|
| Conditional escrow + on-chain dispute + automatic release | Steps 4, 5, 8, 9, 11 | ✅ Core |
| Programmable payroll / vesting | Steps 7, 8 | ✅ v2 |
| Treasury / payment splitting | Steps 3, 8, 11 | ✅ v2, **can't be cut** |
| Software-to-software payments | Step 9 (escrow pays the court fee) | ✅ v3 |
| Cross-chain conditional transfer | Step 8 | ➖ Stretch |
| **Bonus: reusable contracts** | `ClauseEscrow` + `IClauseVerifier` / `ICourt` hooks + reuse guide | ✅ Decide at H0 |

**Requirements checklist:**
- [ ] Contracts **and tests** written in Arc Studio; deployed (ask: from Studio, or with our own wallet?)
- [ ] App connected **"without leaving Studio"**: frontend in the Studio project
- [ ] Shareable **Studio project URL**; Studio shown in the demo (15–20 s clip)
- [ ] Working frontend + backend + architecture diagram
- [ ] Video covering the core functions + **Arc Studio + Circle developer tools**
- [ ] Detailed docs (README) + GitHub repo
- [ ] Bounty named exactly in the submission

**Arc facts:** chain ID `5042002` · RPC `https://rpc.testnet.arc.network` · explorer `testnet.arcscan.app` · USDC (ERC-20) `0x3600000000000000000000000000000000000000`, **6 decimals** · gas is USDC (native balance uses up to 18 decimals, so **never use `msg.value`, only the token interface**) · test USDC from the Circle Faucet (choose Arc Testnet) · Arc Studio = Circle's AI coding agent (generates contracts, tests and app code; Circle warns its output can be wrong, so review it).

### Chainlink: Best Workflow with CRE
| Workflow | Trigger | Does | Writes |
|---|---|---|---|
| WF0 Certify | HTTP (dealId) | EVM-reads the clauses → runs the checker | `Certify(specHash)` |
| WF1 Verify | Log `ClauseSubmitted` | YouTube API (filtered fields) | `Verified` / `Failed` |
| WF2 Daily | Cron (every minute in demo mode) | Is the video still public? | `Vest(days)` / `Broken` |
| WF3 Court | Log `CaseOpened` | 3 LLMs → agree on band + cited IDs | `Opinion` per model |

**Facts from the docs:**
- Arc Testnet supported: **CLI v1.0.7+, TS SDK v1.3.1+**; chain name `arc-testnet`
- Forwarders: **simulation (mock)** `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` · **production** `0x76c9cf548b4179F8901cda1f8623568b58215E62` (confirm with `cre workflow supported-chains`)
- The consumer inherits **`ReceiverTemplate`**, implements `_processReport(bytes report)`; production adds `setExpectedWorkflowId` / `setExpectedAuthor`. **Don't set those in simulation, or it fails.**
- Metadata is 64 bytes (don't require 62)
- Write path: `encodeAbiParameters` → `runtime.report({encodedPayload, encoderName:"evm", signingAlgo:"ecdsa", hashingAlgo:"keccak256"})` → `evmClient.writeReport(runtime, {receiver, report, gasConfig:{gasLimit:"500000"}})`; check both `txStatus` and `receiverContractExecutionStatus`
- HTTP response limit is about 25 KB, so fetch only the fields needed
- Replay protection: include the chain selector and timestamp in the payload
- ⚠️ **Open question:** do `simulate --broadcast` calls actually reach `onReport` on Arc? Person 1 tests this first.
- Templates: `sports-resolution-ts` (log trigger + multiple APIs + majority + write) → WF1/WF3 · `prediction-market-ts` (dispute + HTTP trigger) · `keeper-bot` (cron) → WF2 · LLM example: `cre-gcp-prediction-market-demo`

**Design decisions to show:** WF0 reads from the chain · nodes agree on structured fields only · no agreement → humans · contract checks citations · workflow-ID check + replay protection · minimal fetches · timeouts so the contract never waits on CRE.

**Optional CCIP:** Arc Testnet has 1 lane (→ Ethereum Sepolia), **0 tokens** (fees in LINK / WUSDC; selector `3034092155422581607`). Message-only use: send creator/juror reputation to a registry on Sepolia. Only if the rep confirms message-only counts.

### World: Best Use of IDKit
- **One human, one jury seat** (nullifier). Fake-account juries are impossible.
- **One action `settld-member`** for everyone → a stable ID across roles → **parties are blocked from their own jury**.
- **A record that sticks:** reputation is tied to the nullifier, so nobody can start over with a new wallet.
- The proof is bound to the wallet (the signal). It's verified on-chain if Arc has a verifier contract; otherwise the backend signs an attestation the contract checks (stated in the README).
- **Show the rejections live:** a duplicate human, and a party trying to join their own jury.
- **Juror eligibility:** World ID + passed a 3-question qualification test (backend attestation) + deposit + no conflict + score above threshold.

---

## 6. The big moment (finals demo, about 3 min)
1. **Problem (20s):** "Creators get paid months late, or not at all over one small issue."
2. **Checker (40s):** the brand builds the deal. Checker: *"If the video goes private, 'Product featured' has no way out: 300 USDC stuck."* Fix → ✅ VALID → CRE certifies. **Funding is refused without the certificate**, then the deposit goes through.
3. **Delivery (30s):** CRE nodes check YouTube → posting and disclosure clauses paid (split) → the 30-day clause starts paying daily.
4. **Breach (20s):** video made private → payments stop, the rest goes back to the brand, **exactly as the checker predicted.**
5. **On-chain court (50s):** the brand disputes "product featured" → filings on-chain → 3 models rule via CRE → **the contract rejects a made-up citation** → verdict 80% → only that clause's money moves.
6. **Humans decide (30s):** the creator appeals with a bond → *"Judges, you're the jury"* → World ID hidden vote → **the brand trying to join the jury is rejected** → settled on Arc in under a second.
7. **Close (10s):** *"Checked before funding. Disputes limited to one clause. AI judges first, humans have the final say."*

Script the bad cases so they behave the same every time. Keep a teammate's World ID ready as a backup juror. Add a 15–20 s Arc Studio clip to the video.

---

## 7. Shared interfaces: agree at H0 (9 pm), then freeze

**Clause (on-chain)**
```
Clause {
  uint8   kind        // 0 OneTime, 1 Ongoing, 2 Subjective
  uint8   checkType   // 0 POSTED_BY, 1 DESC_CONTAINS, 2 STAYS_PUBLIC, 3 QUALITY
  string  param       // e.g. "#TravelCoPartner"
  uint64  deadline
  uint256 amount      // token units (USDC 6 decimals)
  uint8   dependsOn   // clause index, 255 = none
  uint8   onFail      // 0 refund, 1 refundRemainder
  uint32  vestDays
  uint32  daysVested
  uint8   status      // Pending, Submitted, Verified, Failed, Disputed, Released, Refunded, Broken
  uint64  verifiedAt
}
Deal { brand, creator, token, total, specHash, funded, payees[], splitBps[] }
```
**Events:** `DealProposed(dealId)` · `DealAccepted(dealId)` · `DealFunded(dealId)` · `ClauseSubmitted(dealId, clauseId, string videoId)` · `ClauseDisputed(dealId, clauseId)` · `CaseOpened(caseId, dealId, clauseId)` · `ClauseSettled(dealId, clauseId, outcome)`

**CRE report:** `(uint8 kind, uint256 dealId, uint8 clauseId, uint8 value, bytes32 data, uint64 sourceSelector, uint64 timestamp)`. Kinds: 0 Certify (data = specHash) · 1 Verified · 2 Failed · 3 Vest (value = days) · 4 Broken · 5 Opinion (value = band; cited IDs encoded in data / an extended payload)

**Hand-offs:** P2 → contract addresses + ABI (after each deploy) · P1 → workflow IDs · P3 → backend URL

---

## 8. Build plan: each version fully works before the next starts
| Version | Includes | Target |
|---|---|---|
| **v1** | Deals entered in a form · WF0 checker + certificate gate · fund · WF1 YouTube · release / refund · dispute → World ID jury (one seat each, parties blocked) · everything in **one Studio project** · `ClauseEscrow` structure | **≈ H14**: tag + backup video |
| **v2** | 30-day clause + WF2 + daily vesting · **payout splits** · checker's stuck-money demo | ≈ H21 |
| **v3** | **`AICourt`** (filings, 3 opinions via WF3, on-chain citation check and majority) · appeal bond · juror stakes · hidden voting · random draw · escrow pays the court fee | ≈ H29 |
| **v4** | Plain-English extraction · EIP-712 signing · juror qualification test · one Circle developer tool (Circle Wallets / EURC) · reuse guide | If time allows |
| **v5** | Deliberation round in the court · what-if slider · CCIP reputation · cross-chain payout | Stretch |
| **Last 3 h** | **Freeze.** README, diagram, video (with the Studio clip), submit all 3 tracks | |

**Rules:** never work on version N+1 while version N is broken · interfaces only change if all three agree · anyone stuck more than an hour gets help from everyone.

### Tasks
**Person 1: CRE and checker**
- Update the TS SDK to ≥1.3.1 · `cre login` · `cre workflow supported-chains`
- **Test whether `--broadcast` changes state on Arc** (first task)
- `checker.ts`: a breadth-first search over clause states; pure, deterministic; unit tests (valid / circular dependency / stuck money)
- WF0 → WF1 → WF2 → WF3 (start from the templates, change to `arc-testnet`)
- YouTube API key as a CRE secret; filter the fields fetched

**Person 2: contracts in Arc Studio**
- Simple escrow first, to learn Studio
- `ClauseEscrow` (core + hooks) → `SettldEscrow` on `ReceiverTemplate` (mock forwarder for simulation)
- `proposeDeal` (amounts add up, ≤5 clauses, specHash computed from stored data), `acceptDeal`, `fundDeal` (certificate gate), `submitEvidence`, `_processReport`, `release` (callable by anyone, after the window), `refund`, `dispute`
- v2: vesting (multiply before dividing), splits · v3: `AICourt`, `JurorRegistry` (attestation check, one seat per nullifier, conflict check, hidden voting, stakes, bond split)
- Tests: amounts add up · USDC never created or lost · no double payment · a dispute only freezes its own clause · only the forwarder can report
- Share the Studio URL, addresses and ABI

**Person 3: app (in Studio) and backend**
- Wallet / Circle Wallets sign-in on Arc testnet; show USDC (and the local currency as an option)
- Pages: deal builder (with checker result) · deal page (a card per clause, buttons) · court (filings, 3 opinions, citations, verdict) · juror (World ID, hidden vote)
- Backend: World ID proof → signed attestation · trigger WF0 · LLM extraction (v4) · IPFS · demo mode (1 day = 1 minute)
- README, diagram, video

---

## 9. Pitches
**30 seconds (main):**
> "Brand–creator deals pay late, all at once, or not at all. Settld proves a deal can't trap money before it's funded, pays each clause in USDC the moment Chainlink's nodes verify it, and freezes only the disputed clause. Disputes go to an on-chain AI court where three models rule and the contract rejects made-up citations, and verified humans have the final say."

**Arc:**
> "Settld's contracts, built in Arc Studio, release USDC or EURC only on certified conditions, settle each clause in several steps with on-chain disputes and automatic release, vest ongoing work day by day, split every payout, pay the AI court's fees from contract to service, and run on ClauseEscrow, a building block other builders can reuse."

**Chainlink:**
> "CRE makes every decision about money: certifying the deal before funding, verifying deliveries, monitoring daily, and running a court where the nodes agree on AI rulings. Remove CRE and Settld knows nothing."

**World:**
> "Proof of human as the final say over AI: a jury fake accounts can't pack, that blocks conflicts of interest, with a track record nobody can escape by switching wallets."

---

## 10. Tough questions
- **What does the checker prove?** That there's a path where every clause ends paid or refunded, and that **from every reachable state money can still reach an end state**. It runs in milliseconds (about 2,400 states at most), so every node runs it.
- **Verified = executed?** The contract computes `specHash` from stored data; WF0 reads the clauses from the chain; the checker and contract share one transition table; tests replay the checker's paths against the contract.
- **Fake reports?** The `ReceiverTemplate` forwarder check **plus** the workflow ID (the forwarder is shared by everyone).
- **Unreliable LLMs?** Nodes agree on band + cited IDs only. Full reasoning on IPFS with a hash on-chain. Disagreement → humans.
- **Made-up citations?** The contract checks them against the on-chain evidence registry.
- **Hidden instructions in evidence?** Evidence is marked as data, 3 different models must be fooled, citations are required, and humans are the final appeal.
- **Why 3 models?** Nodes stop tampering; different models stop wrong answers. Harder to trick, less bias, no single provider decides, and a 2–1 split shows the case is close.
- **Doesn't the jury bypass the network?** Facts checked by the oracle network are final. Humans only judge what can't be measured, only on appeal, and the jury itself runs on-chain.
- **Why not court?** Too small, too fast, cross-border. The ruling is the payment. The right to go to court is kept.
- **Contract safety?** State updated before money moves · SafeERC20 · ReentrancyGuard · caller checks · no admin key · `release()` callable by anyone.
- **Did the AI write everything?** Studio generated drafts from our spec. We designed it, reviewed every function, changed what was wrong and wrote the tests. The commit history shows it.
- **USDC centralization?** Circle can freeze USDC, which is the trade-off of regulated dollars. The escrow logic has no admin.
- **Legal?** It's an escrow release rule both parties agreed to, not legal arbitration. Only hashes go on-chain, and sensitive files are encrypted.

---

## 11. Confirm with the sponsors
- [ ] **Arc:** what "without leaving Studio" covers (can the IDKit part live outside?) · which Circle developer tool they prefer · deploy from Studio or our own wallet? · several teammates in one Studio project? · is our ClauseEscrow-with-hooks approach right for the reuse bonus?
- [ ] **Chainlink:** does `--broadcast` call `onReport` on Arc? · do event triggers work on Arc? · is enabling the workflow-ID check only in production fine? · cron every minute? · does message-only CCIP count, and can we enter both CRE and CCIP?
- [ ] **World:** one action across roles OK? · is there a verifier on Arc, or is an attestation fine? · Orb level for jurors only? · binding the proof to the wallet (signal) · what the simulator supports
- [ ] **ETHGlobal:** submission deadline · round-1 format and length · maximum video length · partner judging at the booth or from submissions?
- [ ] **Showcase search** for "escrow", "dispute", "court"

## 12. How judging works
- **Partner prizes and finalist prizes are separate.** You can win both. Pick up to 3 partner programs on the submission form.
- **Round 1:** a short live demo with ETHGlobal judges. Top 8–10 → finals on stage.
- **Partner judging:** at the booth or from your submission, depending on the sponsor.
- ⚠️ Projects that rely **entirely on AI** without meaningful team contribution may be ineligible. Commit often, write your own tests, document what Studio generated and what you changed.

## 13. Chances (honest)
- **Arc: high** (3–4 wish-list items + reuse bonus) · **World: good** · **Chainlink CRE: good**
- **Finals:** possible if v3 works smoothly and the pitch leads with the checker and the on-chain court
- **Biggest risks:** the contracts slipping (the critical path) · CRE simulation not reaching Arc · "without leaving Studio" ruling out a separate frontend
