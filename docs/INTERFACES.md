# Settld: Shared Interfaces (v1)

> **Frozen once agreed.** Changes only through a PR approved by all three of us.
> Contracts (P2), CRE (P1) and the app (P3) must all match this file exactly.

## Chain
| Item | Value |
|---|---|
| Network | Arc testnet |
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://explorer.testnet.arc.io` (`testnet.arcscan.app` redirects here) |
| CRE chain name | `arc-testnet` |
| USDC (ERC-20) | `0x3600000000000000000000000000000000000000`, **6 decimals**. Never use `msg.value`. |
| CRE forwarder (simulation / mock) | `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` |
| CRE forwarder (production) | `0x76c9cf548b4179F8901cda1f8623568b58215E62` |
| Tester wallet (manual oracle; swap in with `setForwarder`) | `0xB78dCAD9C827d95d07Dcae6C0498FBdd780B223d` |
| ClauseEscrow (built + deployed in Arc Studio) | `0xb95014696c71fb6d3269c5d09713075185191ea8`, forwarder = mock forwarder, owner = Studio's deployer wallet (cannot call `setForwarderAddress`). More in `shared/addresses.json` |

## Enums
```
ClauseKind  : 0 OneTime, 1 Ongoing, 2 Subjective
CheckType   : 0 POSTED_BY, 1 DESC_CONTAINS, 2 STAYS_PUBLIC, 3 QUALITY,
              4 URL_LIVE, 5 URL_CONTAINS (param = text), 6 GITHUB_MERGED (evidence = PR URL),
              7 AI_CHECK (param = criteria; 3 LLMs judge in WF1 at submit time)
OnFail      : 0 Refund, 1 RefundRemainder
ClauseStatus: 0 Pending, 1 Submitted, 2 Verified, 3 Failed, 4 Disputed, 5 Released, 6 Refunded, 7 Broken
```
V1a used only `OneTime` with `POSTED_BY` and `DESC_CONTAINS`. **V2 adds check types 4–7.** Evidence is any string
passed to `submitEvidence`: a YouTube id, any URL, or an IPFS id of a screenshot (no contract change needed).
Band (court verdicts): **0 / 50 / 80 / 100** = the freelancer's % of the clause; the rest is refunded to the client.

## Structs (Solidity)
```solidity
struct Clause {
    uint8   kind;        // ClauseKind
    uint8   checkType;   // CheckType
    string  param;       // e.g. "#TravelCoPartner" (empty for POSTED_BY)
    uint64  deadline;    // unix seconds
    uint256 amount;      // USDC units (6 decimals)
    uint8   dependsOn;   // clause index, 255 = none
    uint8   onFail;      // OnFail
    uint32  vestDays;    // 0 in v1
    uint32  daysVested;  // 0 in v1
    uint8   status;      // ClauseStatus
    uint64  verifiedAt;  // set on Verified
}

struct Deal {
    address brand;
    address creator;
    address token;       // USDC in v1
    uint256 total;       // must equal the sum of clause amounts
    bytes32 specHash;    // keccak256(abi.encode(clauseTerms)), computed on-chain
    bool    accepted;
    bool    funded;
}
```
`specHash` is computed **by the contract** from the clause terms (`kind, checkType, param, deadline, amount, dependsOn, onFail, vestDays`), not from status fields.

## Limits (v1)
- Max **5** clauses per deal
- Dispute window: **120 seconds** (demo)

## Events
```solidity
event DealProposed(uint256 indexed dealId, address indexed brand, address indexed creator, bytes32 specHash);
event DealAccepted(uint256 indexed dealId);
event DealCertified(uint256 indexed dealId);   // DEPLOYED version has no specHash arg
event DealFunded(uint256 indexed dealId, uint256 total);
event ClauseSubmitted(uint256 indexed dealId, uint8 clauseId, string videoId);
event ClauseVerified(uint256 indexed dealId, uint8 clauseId);
event ClauseFailed(uint256 indexed dealId, uint8 clauseId);
event ClauseDisputed(uint256 indexed dealId, uint8 clauseId);   // V2: (dealId, clauseId, caseId, reason), see V2 section
event ClauseSettled(uint256 indexed dealId, uint8 clauseId, uint8 outcome, uint256 amount); // outcome: 5 Released, 6 Refunded
```

## ClauseEscrow functions (contracts/src/ClauseEscrow.sol)
Constructor `ClauseEscrow(forwarder, usdc)`. **Deployed (Studio) differences:** token getter is `usdc()`; forwarder functions use Chainlink names `getForwarderAddress` / `setForwarderAddress`; `dependsOn` must point to a strictly earlier clause; `DealCertified` has no `specHash`. Deal ids start at 1. ABI: `shared/abi/ClauseEscrow.json`. Details: `contracts/README.md`.
```solidity
struct ClauseTerms { uint8 kind; uint8 checkType; string param; uint64 deadline; uint256 amount; uint8 dependsOn; uint8 onFail; uint32 vestDays; }

proposeDeal(address creator, uint256 total, ClauseTerms[] terms) returns (uint256 dealId) // brand; specHash computed on-chain
acceptDeal(uint256 dealId)                       // creator
fundDeal(uint256 dealId)                         // brand; needs accepted AND certified; approve USDC first
submitEvidence(uint256 dealId, uint8 clauseId, string videoId) // creator; emits ClauseSubmitted
onReport(bytes metadata, bytes report)           // forwarder only; kinds 0 Certify, 1 Verified, 2 Failed
release(uint256 dealId, uint8 clauseId)          // anyone; Verified + 120 s window + dependency Released -> creator
refund(uint256 dealId, uint8 clauseId)           // anyone; Failed, or dependency Refunded (cascade) -> brand
expire(uint256 dealId, uint8 clauseId)           // anyone; Pending past deadline, or Submitted with no report for 1 day -> Failed

getDeal(uint256) returns (Deal)   getClause(uint256, uint8) returns (Clause)
getClauses(uint256) returns (Clause[])   clauseCount(uint256)   certified(uint256) returns (bool)   dealCount()
```
- A Verified/Failed report is only accepted for a **funded** deal and a clause in **Submitted**; a Certify report only for an unfunded deal, with `data == specHash`.
- `dispute`, vesting and report kinds 3-5 are not in V1a.

## CRE report format
ABI-encoded, in this exact order:
```
(uint8 kind, uint256 dealId, uint8 clauseId, uint8 value, bytes32 data, uint64 sourceSelector, uint64 timestamp)
```
| kind | Meaning | clauseId | value | data |
|---|---|---|---|---|
| 0 | Certify | unused (0) | unused (0) | `specHash` |
| 1 | Verified | clause | unused (0) | `0x0` |
| 2 | Failed | clause | reason code (0 generic) | `0x0` |
| 3 | Vest (v2) | clause | days to vest | `0x0` |
| 4 | Broken (v2) | clause | 0 | `0x0` |
| 5 | Opinion (v3) | clause | band 0/50/80/100 | hash of cited evidence IDs |

- TypeScript encoding (viem): `encodeAbiParameters(parseAbiParameters("uint8, uint256, uint8, uint8, bytes32, uint64, uint64"), [...])`
- Solidity decoding: `abi.decode(report, (uint8, uint256, uint8, uint8, bytes32, uint64, uint64))`
- Expected bytes for each kind live in `shared/fixtures/reports.json` (P1 generates them in S1). **All three test against these.**

## World ID (IDKit 4.x)
- Action: `settld-member` (one action for every role). Environment: `staging` (World ID Simulator) for the demo.
- IDKit 4 needs a backend-signed **RP context** per request (`POST /api/worldid/rp-context`). Signal = the signed-in wallet.
- Proof checked by the backend with World's v4 verify API (World ID's on-chain verifier is on Arc **mainnet** only, not testnet).
- Attestation signed by the backend: EIP-191 `personal_sign` over `keccak256(abi.encodePacked(uint256 nullifier, address wallet))`,
  from `ATTESTER` (address stored immutably in `JurorRegistry`). The wallet always comes from the server session.

---

# V2: disputes, AI court, human arbitrators (FROZEN, agreed by Mehak + Samagra)

**Dispute flow:** a party disputes a Verified/Failed clause inside the 120 s window → `ClauseEscrow` opens a case in
`AICourt` → WF3 runs the 3-LLM deliberation round by round → `closeCase` sets the AI band → if nobody appeals inside
the appeal window, the AI band is final → otherwise the appellant pays 10% and `JurorRegistry` seats 3 World ID humans →
their band is final → `resolveDispute` pays band % to the freelancer and refunds the rest.

**Deploy:** owner of all three = Mehak's wallet `0xF808771A6F3d9094319eE344B0fF07009e84Ddc4` (passed in the constructor;
Studio's shared wallet can't transfer ownership). Attester = `0xDC930A8Fa2A3AE6820A30f2FF57863AaF772a861`.
Wiring after deploy (owner, one-time): `escrow.setCourt(court)`, `court.setJury(registry)`, `registry.setCourt(court)`.

**`shared/addresses.json` keys** (the watcher, keeper and `scripts/use-addresses.ts` read exactly these):
`clauseEscrow.address`, `aiCourt.address`, `jurorRegistry.address`, each with the same extra fields as today's
`clauseEscrow` (deployTx, builtIn, forwarder, owner). After a deploy: `bun run use-addresses` (from scripts/)
copies them into the WF0/WF1/WF3 configs, then restart the server.

**Automation (built, `server/src/automation.ts`):** with `AUTOMATION_ENABLED=true` the server watches Arc and runs
WF0 on `DealAccepted`, WF1 on `ClauseSubmitted`, WF3 on `CaseOpened` / `RoundCompleted`. Every 30 s a keeper makes every
permissionless move the contracts accept (each one dry-run first): release, refund (incl. cascade), expire,
resolveDispute, resolveStuckDispute, closeCase, finalize, rescueFee, closePanel. Status for the UI:
`GET /api/automation/status` → `{ enabled, contracts, running, queued, openCases, openPanels, recent: [{ at, kind, label, ok, detail }] }`.

## ClauseEscrow v2 (Samagra), changes only
```solidity
constructor(address forwarder, address usdc, address owner)
dispute(uint256 dealId, uint8 clauseId, string reason) // client OR freelancer; Verified or Failed; now <= disputeWindowEnd → Disputed (4); opens the court case
disputeWindowEnd(uint256 dealId, uint8 clauseId) view returns (uint64)
caseOf(uint256 dealId, uint8 clauseId) view returns (uint256 caseId)
evidenceOf(uint256 dealId, uint8 clauseId) view returns (string) // ADDED: the string passed to submitEvidence (WF3 reads it for round 0)
resolveDispute(uint256 dealId, uint8 clauseId)         // anyone (keeper); needs court.finalVerdict final
                                                       //   share = amount * band / 100 → freelancer, rest → client
                                                       //   status Released if share > 0, Refunded if share == 0
setCourt(address court)                                // owner-only, one-time
release / refund                                       // both wait for the 120 s window; a Disputed clause can only leave via resolveDispute
event ClauseDisputed(uint256 indexed dealId, uint8 clauseId, uint256 caseId, string reason)
event ClauseSplit(uint256 indexed dealId, uint8 clauseId, uint256 toFreelancer, uint256 toClient)
```
Dependencies: a clause settled with share > 0 counts as Released for its dependents; share == 0 counts as Refunded (cascade).

## AICourt (Samagra), a CRE report receiver (`ReceiverTemplate`)
```solidity
constructor(address forwarder, address usdc, address escrow, address owner)
setJury(address registry)                                       // owner-only, one-time
openCase(uint256 dealId, uint8 clauseId, address client, address freelancer, string reason)
        returns (uint256 caseId)                                // escrow only
closeCase(uint256 caseId)          // anyone; after deadline OR all 3 judges final → AI band; starts the appeal window
appealFee(uint256 caseId) view returns (uint256)               // APPEAL_BPS of the clause amount
appeal(uint256 caseId)             // client or freelancer; inside the appeal window; USDC approve first → registry.openPanel
finalize(uint256 caseId)           // anyone; no appeal + window over → AI band; appealed → registry.decision
finalVerdict(uint256 caseId) view returns (bool final, uint8 band)

event CaseOpened(uint256 indexed caseId, uint256 dealId, uint8 clauseId, string reason, uint64 deadline) // WF3 trigger
event JudgeUpdated(uint256 indexed caseId, uint8 round, uint8 judge, uint8 band, uint16 wordsUsed, bool wantsExtend, bool isFinal, uint8 citedMask)
event RoundCompleted(uint256 indexed caseId, uint8 round, bytes32 transcriptHash)              // WF3 trigger for the next round
event ExtensionGranted(uint256 indexed caseId, uint16 wordBudget, uint64 deadline)
event AIVerdict(uint256 indexed caseId, uint8 band, uint64 appealDeadline)
event Appealed(uint256 indexed caseId, address by, uint256 fee)
event Finalized(uint256 indexed caseId, uint8 band, bool byHumans)

WORD_BUDGET 200 · EXTEND_WORDS 100 · EXTEND_SECS 60 · BASE_SECS 180 · HARD_CAP_SECS 300
MAX_EXT 2 · MAX_ROUNDS 3 (+1 per extension) · APPEAL_BPS 1000 · APPEAL_WINDOW 120
```
Rules enforced on-chain:
- Rounds arrive in order (0, 1, 2…); a report after the deadline is rejected.
- `wordsUsed[i]` (running total) ≤ current word budget; `citedMask & ~0x07 == 0`; bands must be 0/50/80/100.
- 2 or more `wantsExtend` → budget += 100 and `deadline = min(deadline + 60, openedAt + HARD_CAP_SECS)`, at most MAX_EXT times.
- **AI band = majority of each judge's LATEST band** (2 or 3 equal), otherwise the middle band. Not first-to-majority.
- Appeal fee: paid to the court, then split among `decision().majority`. If nobody revealed (band 255), the AI band
  stands and the fee goes back to the appellant.

### Round report (WF3 → AICourt), report kind 6
```
abi.encode(uint8 kind /*6*/, uint256 caseId, uint8 round,
           uint8[3] bands, uint16[3] wordsUsed, bool[3] wantsExtend, bool[3] isFinal,
           uint8[3] citedMask, bytes32 transcriptHash)
```
- Judges: 0 = Groq (OpenAI gpt-oss-120b), 1 = Google Gemini 3.5 Flash-Lite, 2 = NVIDIA NIM (Nemotron 3.5 Bolt): three different model makers (OpenAI, Google, NVIDIA).
- Evidence bits for `citedMask`: **0 = clause terms, 1 = submitted evidence, 2 = dispute reason**.
- Round 0 = blind opinions; later rounds = discussion. WF3 counts and truncates words; the full transcript is stored
  off-chain and its hash is on-chain.
- **Built:** `cre/wf3-court/` (rules in `court.ts`, 10 tests; full 3-round debate passes in `cre workflow simulate`).
  Encoder: `encodeRoundReport` in `shared/report.ts`. WF3 sends one report per round only while the case is open
  (not all final, rounds left, more than 20 s before the deadline). On the last round every judge is forced final.
  A judge that is already final stays final and silent. A turn with no valid answer keeps the previous band
  (50 on round 0). The keeper then calls `closeCase`.

## JurorRegistry v2 (Mehak). Human arbitrators, appeal only, never moves money
```solidity
constructor(address attester, address owner)
setCourt(address court)                                          // owner-only, one-time
registerPerson(uint256 nullifier, bytes signature)               // unchanged: one World ID = one wallet, forever
openPanel(uint256 caseId, address client, address freelancer)    // court only, on appeal
commitVote(uint256 caseId, bytes32 commitment)                   // first 3 eligible people to commit = the panel
    // commitment = keccak256(abi.encode(caseId, band, salt, msg.sender))
revealVote(uint256 caseId, uint8 band, bytes32 salt)
closePanel(uint256 caseId)                                       // anyone (keeper): all 3 revealed OR reveal deadline passed
decision(uint256 caseId) view returns (bool decided, uint8 band, address[] majority)
profile(uint256 nullifier) view returns (uint32 cases, uint32 withMajority, uint8 strikes, bool suspended)
nullifierOf(address) / walletOf(uint256) / isRegistered(address)
// extra read helpers (built): getPanel(caseId), revealDeadline(caseId), commitmentHash(caseId, band, salt, voter), seated(caseId, nullifier)
// ABI: shared/abi/JurorRegistry.json. Old v1 vote()/MockEscrowView are gone.

PANEL_SIZE 3 · COMMIT_SECS 120 (from openPanel) · REVEAL_SECS 60 (from 3rd commit or commit deadline) · MAX_STRIKES 2
event PersonRegistered(uint256 indexed nullifier, address indexed wallet)
event PanelOpened(uint256 indexed caseId, uint64 commitDeadline)
event VoteCommitted(uint256 indexed caseId, address indexed arbitrator)
event VoteRevealed(uint256 indexed caseId, address indexed arbitrator, uint8 band)
event PanelClosed(uint256 indexed caseId, uint8 band, uint8 majoritySize)
event Struck(uint256 indexed nullifier, uint8 strikes, bool suspended)
```
Rules:
- Can't commit: unregistered, suspended, a party by wallet **or** World ID, or a seat already taken by the same World ID.
- **Majority** (2 or 3 revealed with the same band): band = that band, `majority` = those voters, everyone else who
  revealed gets a strike.
- **No majority** (3 different bands): band = the middle one, **no strikes**, `majority` = everyone who revealed.
- Committed but didn't reveal: always a strike, never in `majority`.
- Nobody revealed: `decided = true`, `band = 255` (no decision) → the court keeps the AI band.
- 2 strikes → suspended forever (the record is tied to the World ID, so a new wallet can't reset it).

## Backend API (server, port 3000; the client proxies `/api`)
| Route | Body | Returns | Step |
|---|---|---|---|
| `POST /api/deals` | `{ specHash, text, clauses }` | `{ ok }` | S4 |
| `GET /api/deals/:specHash` | — | `{ text, clauses }` | S4 |
| `POST /api/report/encode` | `{ kind, dealId, clauseId, value, data }` | `{ hex }` | S5 |
| `POST /api/certify` | `{ dealId }` | `{ ok, reason? }` | S8 |
| `GET /api/worldid/config` | — | `{ enabled, appId, action, environment, registry }` | V1c |
| `POST /api/worldid/rp-context` | — (signed in) | `{ rp_context, signal, action, environment }` | V1c |
| `POST /api/worldid/verify` | IDKit result (as-is) | `{ nullifier, signature, attester, wallet }` | V1c |
| `POST /api/jury/register` | `{ nullifier, signature }` | Circle `{ challengeId }` | V1c |
| `GET /api/arbitrator/panel/:caseId` | — | `{ opened, closed, decided, commitDeadline, revealDeadline, commits, reveals, seats, band, majority, mySeat }` | V2 (built) |
| `GET /api/court/:caseId` | — (party or arbitrator) | `{ caseId, transcriptHash, transcript: { reason, terms, evidence, judges[3], deadline0, rounds: [{ round, extensionGranted, wordBudget, deadline, judges: [{ band, statement, cited, wantsExtend, isFinal, wordsUsed, note? }] }] } }` — the AI debate | V2 (built) |
| `GET /api/court/:caseId/transcript` | — (WF3 token, party or arbitrator) | the exact stored transcript JSON (its keccak256 = on-chain transcriptHash) | V2 (built) |
| `POST /api/court/:caseId/transcript` | `{ transcript, hash }` + header `x-court-token` | `{ ok }` (WF3 only; hash checked) | V2 (built) |
| `GET /api/court/:caseId/status` | — (party or arbitrator) | `{ dealId, clauseId, deadline, rounds, wordBudget, aiVerdict, appealDeadline, canAppeal, appealFeeUnits, appealed, appellant, finalized, finalBand, byHumans }` | V2 (built) |
| `POST /api/court/:caseId/approve-fee` | — (party) | Circle `{ challengeId }`: USDC approve(court, appealFee) | V2 (built) |
| `POST /api/court/:caseId/appeal` | — (party, after approve-fee, inside the 120 s window) | Circle `{ challengeId }`: court.appeal(caseId) | V2 (built) |
| `POST /api/escrow/dispute` | `{ dealId, clauseId, reason }` (party, Verified/Failed, inside 120 s) | Circle `{ challengeId }` | V2 (built) |
| `POST /api/arbitrator/commit` | `{ caseId, band }` (arbitrator) | Circle `{ challengeId }`; the server derives the salt and remembers the band | V2 (built) |
| `POST /api/arbitrator/reveal` | `{ caseId, band? }` (arbitrator) | Circle `{ challengeId }` | V2 (built) |
| `GET /api/arbitrator/panel/:caseId` | — (arbitrator) | see above | V2 (built) |
| `GET /api/arbitrator/me` | — (signed in) | `{ wallet, verified, arbitrator, canAccessCourt }` → show/hide the court tab | V2 (built) |
| `GET /api/arbitrator/dashboard` | — (arbitrator) | `{ profile: { cases, withMajority, strikes, suspended }, totals: { casesTaken, casesDecided, rightCalls, wrongCalls, pending, feesEarnedUnits }, history: [{ caseId, dealId, clauseId, reason, myBand, aiBand, panelBand, finalBand, outcome, feeEarnedUnits, status }] }` | V2 (built) |
| `GET /api/arbitrator/cases` | — (arbitrator) | `{ cases: [{ caseId, dealId, clauseId, reason, aiBand, commitDeadline, revealDeadline, seatsTaken, mySeat, canJoin, blockedReason }] }` — appealed cases only | V2 (built) |
| `GET /api/arbitrator/cases/:caseId` | — (arbitrator, not a party) | case file: `{ clause, evidence, reason, aiVerdict, aiTranscript, appeal, panel: { …, band & votes only after close }, final }` | V2 (built) |
| `GET /api/arbitrator/profile` | — (signed in) | `{ registered, cases, withMajority, strikes, suspended }` | V2 (built) |
| `GET /api/arbitrators/stats` | — (public) | `{ verifiedHumans, arbitrators, openPanels, casesDecided, decidedByHumans }` | V2 (built) |
| `GET /api/worldid/status/:wallet` | — (public) | `{ wallet, verified, arbitrator, verifiedAt }` for the ✓ badge (no nullifier) | V2 (built) |
| `POST /api/clauses/extract` | `{ text, startDate? }` (signed in) | `{ sentences: [{ id, text, clause, note }], clauses: [{ title, sentences, checkType, checkName, param, deadline, deadlineText, dependsOn, vague, vagueReason, agreement }], unaccounted, models, note }` — plain English → clauses, never amounts | V2 (built) |
| `GET /api/automation/status` | — | watcher/keeper state + recent activity ("Chainlink is checking…") | V2 (built) |

**Access rules:** the court section (`/api/arbitrator/*` except `me`/`profile`) is only for wallets registered on JurorRegistry
(World ID-verified, checked on-chain). Parties see only their own case (`/api/court/:caseId*`). Votes stay hidden until the panel closes.

**Database:** `server/data/settld.db` (SQLite built into Node, git-ignored). The watcher archives every contract event and keeps
tables for deals, cases, panel votes, strikes, World ID-verified wallets, and each deal's story. The chain stays the source of truth.

**Developer monitor (not part of the app):** `http://localhost:3000/monitor` — each deal's whole story in plain English, plus
live workflow/keeper activity and contract events. Story data: `GET /api/monitor/story/:dealId`.

## Hand-offs
- P2 → after each deploy: addresses in this file + ABI JSON in `shared/abi/`
- P1 → `shared/fixtures/reports.json`, `shared/report.ts`, workflow IDs
- P3 → API routes live on `dev`
