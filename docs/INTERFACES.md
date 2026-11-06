# Settld: Shared Interfaces (v1)

> **Frozen once agreed.** Changes only through a PR approved by all three of us.
> Contracts (P2), CRE (P1) and the app (P3) must all match this file exactly.

## Chain
| Item | Value |
|---|---|
| Network | Arc testnet |
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| CRE chain name | `arc-testnet` |
| USDC (ERC-20) | `0x3600000000000000000000000000000000000000`, **6 decimals**. Never use `msg.value`. |
| CRE forwarder (simulation / mock) | `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` |
| CRE forwarder (production) | `0x76c9cf548b4179F8901cda1f8623568b58215E62` |
| Tester wallet (manual oracle; swap in with `setForwarder`) | `0xB78dCAD9C827d95d07Dcae6C0498FBdd780B223d` |
| Contract addresses | _filled in by P2 after each deploy_ |

## Enums
```
ClauseKind  : 0 OneTime, 1 Ongoing, 2 Subjective
CheckType   : 0 POSTED_BY, 1 DESC_CONTAINS, 2 STAYS_PUBLIC, 3 QUALITY
OnFail      : 0 Refund, 1 RefundRemainder
ClauseStatus: 0 Pending, 1 Submitted, 2 Verified, 3 Failed, 4 Disputed, 5 Released, 6 Refunded, 7 Broken
```
V1 uses only `OneTime` with `POSTED_BY` and `DESC_CONTAINS`.

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
event DealCertified(uint256 indexed dealId, bytes32 specHash);
event DealFunded(uint256 indexed dealId, uint256 total);
event ClauseSubmitted(uint256 indexed dealId, uint8 clauseId, string videoId);
event ClauseVerified(uint256 indexed dealId, uint8 clauseId);
event ClauseFailed(uint256 indexed dealId, uint8 clauseId);
event ClauseDisputed(uint256 indexed dealId, uint8 clauseId);
event ClauseSettled(uint256 indexed dealId, uint8 clauseId, uint8 outcome, uint256 amount); // outcome: 5 Released, 6 Refunded
```

## ClauseEscrow functions (contracts/src/ClauseEscrow.sol)
Constructor `ClauseEscrow(forwarder, usdc)`. Deal ids start at 1. ABI: `shared/abi/ClauseEscrow.json`. Details: `contracts/README.md`.
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

## World ID
- Action: `settld-member` (one action for every role)
- Signal: the user's wallet address
- Attestation signed by the backend: `keccak256(abi.encodePacked(nullifier, wallet))`, as an EIP-191 signed message from `ATTESTER` (the address is stored in `JurorRegistry`)

## Backend API (server, port 3000; the client proxies `/api`)
| Route | Body | Returns | Step |
|---|---|---|---|
| `POST /api/deals` | `{ specHash, text, clauses }` | `{ ok }` | S4 |
| `GET /api/deals/:specHash` | — | `{ text, clauses }` | S4 |
| `POST /api/report/encode` | `{ kind, dealId, clauseId, value, data }` | `{ hex }` | S5 |
| `POST /api/certify` | `{ dealId }` | `{ ok, reason? }` | S8 |
| `POST /api/worldid` | IDKit proof + `wallet` | `{ nullifier, signature }` | S10 |

## Hand-offs
- P2 → after each deploy: addresses in this file + ABI JSON in `shared/abi/`
- P1 → `shared/fixtures/reports.json`, `shared/report.ts`, workflow IDs
- P3 → API routes live on `dev`
