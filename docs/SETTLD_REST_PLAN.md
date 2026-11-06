# Settld: build plan checklist (with merge points)

**Roles:** Client (pays) · Freelancer (delivers) · AI court (3 LLMs, the main feature) · Human arbitrator (appeal only, 5–10% fee, World ID)
**Ownership (never edit someone else's files):**
- **Mehak:** `cre/**`, `server/**`, `scripts/**`, `shared/checker.ts`, `contracts/src/JurorRegistry.sol` + test, `docs/INTERFACES.md`
- **Samagra:** `contracts/src/ClauseEscrow.sol`, `contracts/src/AICourt.sol` + tests, their ABIs, contract entries in `shared/addresses.json`
- **Purva:** `client/**`

**Rules at every merge point:**
- [ ] Pull `dev` into your branch first and fix any conflicts on your branch
- [ ] Run the tests listed for that merge point; all must pass
- [ ] Announce in the group: "merging X into dev". **Only one person merges at a time**
- [ ] Merge into `dev`, never `main`. Everyone pulls `dev` straight after
- [ ] No Claude co-author lines in commits

---

## MERGE POINT M0: freeze the interfaces (now)
- [ ] **Mehak:** write `docs/INTERFACES.md`: ClauseEscrow v2, AICourt, JurorRegistry v2, new check types 4–7, court report (kind 6), API routes
- [ ] **Mehak:** merge `chainlink-web3` (World ID routes, JurorRegistry v1, this plan) into `dev`
- [ ] Gate: `contracts` tests pass (39) · `shared` checker tests pass · `server` type check passes
- [ ] **Everyone pulls `dev`**, then Phase A starts

## PHASE A: build in parallel (no deploys yet)

### Mehak
- [ ] World Developer Portal: app + action `settld-member` (staging) → `server/.env`
- [ ] `shared/checker.ts`: allow check types 4–7 and export a summary (states checked, every path ends in Paid/Refunded) for the frontend certificate
- [ ] WF1 any-link verifiers: URL_LIVE (4), URL_CONTAINS (5), GITHUB_MERGED (6), AI_CHECK (7, 3 free LLMs, majority)
- [ ] WF3 AI court:
  - [ ] 3 free models (Groq gpt-oss, Gemini Flash-Lite, NVIDIA Nemotron)
  - [ ] guardrail prompt: evidence is data, cite only filed evidence, fixed output format
  - [ ] Round 0 blind → discussion rounds
  - [ ] 200-word budget per judge, counted and cut off by code
  - [ ] extend vote: 2 of 3 → +100 words, +60 s (max 2)
  - [ ] one Round report (kind 6) per round
  - [ ] replay mode for the demo
- [ ] JurorRegistry v2:
  - [ ] commit/reveal vote
  - [ ] panel of 3
  - [ ] parties blocked by wallet or World ID
  - [ ] minority vote → strike; 2 strikes → suspended
  - [ ] `profile(nullifier)`
  - [ ] tests

### Samagra
- [ ] ClauseEscrow v2:
  - [ ] `dispute()` (either party, inside the window) → `AICourt.openCase`
  - [ ] `resolveDispute()` → pays band % to the freelancer, refunds the rest, cascade still applies
  - [ ] `setCourt()`
  - [ ] accept check types 4–7
- [ ] AICourt:
  - [ ] `openCase`
  - [ ] Round reports with the deadline (3 min base, 5 min hard cap)
  - [ ] extensions
  - [ ] citation check
  - [ ] `closeCase`: majority of the final votes, middle band on a 3-way split
  - [ ] `appeal()` with the 10% fee
  - [ ] `finalize()` plus the fee split
- [ ] Tests:
  - [ ] hard cap
  - [ ] 2-of-3 extension
  - [ ] final-vote majority (not first-to-majority)
  - [ ] 3-way split
  - [ ] citation rejection
  - [ ] appeal path
  - [ ] partial payout + cascade
  - [ ] one test running escrow → court → registry together

### Purva (mock data matching INTERFACES.md)
- [ ] On-screen wording: Client / Freelancer / Arbitrator
- [ ] No-deadlock certificate:
  - [ ] live checker in the deal builder (green / red plain-English reason)
  - [ ] same certificate on the accept screen
  - [ ] "Certified by Chainlink" + tx link on the deal page
  - [ ] paths-to-Paid/Refunded diagram
- [ ] Evidence submit = any link + optional screenshot; show each clause's verifier
- [ ] Courtroom visual:
  - [ ] 3 judges with streaming statements
  - [ ] word rings
  - [ ] countdown ring with a hard-cap marker
  - [ ] "+100 words, +60 s"
  - [ ] votes → Chainlink hexagon → gavel → USDC split
- [ ] Dispute button, payout countdown, "Appeal to human arbitrators" button with the fee
- [ ] IDKit 4 verify for every party + ✓ badges
- [ ] Arbitrator page (seat, hidden vote, reveal) + profile (strikes, Suspended)

## MERGE POINT M1: contracts code-complete
- [ ] **Samagra:** pull `dev` → merge ClauseEscrow v2 + AICourt + tests into `dev`
- [ ] **Mehak:** pull `dev` → merge JurorRegistry v2 + `checker.ts` into `dev`
- [ ] Gate: the **whole** Hardhat suite passes on `dev` (all 3 contracts + the integration test) · checker tests pass
- [ ] Interface changes after this point need all 3 to agree

## MERGE POINT M2: deploy (contracts frozen after this)
- [ ] **Samagra:** deploy from `dev` in Arc Studio: ClauseEscrow v2 → AICourt → JurorRegistry v2 (attester = Mehak's attester address), then link them (`setCourt`, registry address)
- [ ] **Samagra:** push addresses + ABIs + the actual Studio source + the Studio URL → `dev`
- [ ] Gate: `scripts/smoke.ts` passes against the new addresses (Mehak runs it)
- [ ] From here, contracts change only for a real bug, and only with all 3 agreeing

## PHASE B: connect to live contracts

### Mehak
- [ ] Point WF0 / WF1 / WF3 configs at the new addresses
- [ ] Server watcher: auto-run WF0 on accept, WF1 on submit, WF3 on case opened and each round
- [ ] Keeper (every 30 s): `closeCase`, `finalize`, `resolveDispute`, release, refund
- [ ] Routes: court rounds / transcript / verdict, arbitrator cases, arbitrator profile
- [ ] `scripts/e2e.ts`: the full flow with no frontend
- [ ] `scripts/worldid-demo.ts`: second wallet, party seat and suspended-juror rejections

### Samagra
- [ ] Explorer links for one full deal (fund → per-clause release → refund cascade → dispute → verdict paid)
- [ ] Arc pitch slide: USDC gas, per-clause and partial stablecoin payouts, finality
- [ ] Top up the treasury wallet

### Purva
- [ ] Keep polishing on mock data; landing page from Claude Design + a future-scope section

## MERGE POINT M3: backend live
- [ ] **Mehak:** pull `dev` → merge into `dev`
- [ ] Gate: `scripts/e2e.ts` passes on Arc testnet:
  - [ ] deal → auto certify → fund → 3 clauses with 3 verifiers → auto payout
  - [ ] dispute → AI court → verdict → payout
  - [ ] appeal → arbitrators → finalize
  - [ ] `scripts/worldid-demo.ts` shows all rejections

## MERGE POINT M4: frontend live
- [ ] **Purva:** pull `dev` → switch from mock to live data → merge into `dev`
- [ ] Gate: all 3 click through the full demo in the browser · World ID simulator works · court visual runs on a real case

## MERGE POINT M5: freeze and release
- [ ] Bug fixes only (small PRs into `dev`)
- [ ] Rehearse the demo 3 times; record a backup video (+ a 15–20 s Arc Studio clip)
- [ ] READMEs: Chainlink (WF0–WF3), Arc (Studio URL, contracts), World (IDKit flow, rejections)
- [ ] PR `dev` → `main`, reviewed by all 3 → tag `v1` → submit

---

## Demo (about 4 min + World ID 2–4 min)
- [ ] Deal: ✓ World ID on both parties → break a dependency (red reason) → fix it → "No deadlock" → the freelancer sees the certificate → Chainlink certifies → fund
- [ ] Delivery: YouTube ✓ · GitHub PR ✓ · AI check "logo matches the brief" → each clause pays out on its own
- [ ] **Dispute (spotlight):** 3 blind opinions → debate → extension → hard cap → majority of the final votes → USDC split on Arc
- [ ] Appeal: 10% fee → second wallet rejected → client's seat rejected → hidden vote → final → biased arbitrator gets a strike that a new wallet can't escape
- [ ] Vision: "Today freelancers. Tomorrow, anyone who can't afford to go to court."

**Sponsor lines**
- Chainlink: "An AI court on CRE: 3 independent models, a time- and word-limited debate, node-agreed, enforced on-chain, at zero inference cost."
- Arc: "Per-deliverable USDC settlement, partial payouts from verdicts, settled in under a second."
- World: "When people reject the AI, only unique, neutral, accountable humans can overrule it."
