import {
    encodeAbiParameters,
    decodeAbiParameters,
    parseAbiParameters,
    type Hex,
} from "viem";

// Arc's testnet's chain selector (from cre workflow supported-chains)
export const ARC_TESTNET_SELECTOR = 3034092155422581607n;

export const ZERO32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

// What each report means (must match docs/INTERFACES.md)
export const ReportKind = {
  Certify: 0,
  Verified: 1,
  Failed: 2,
  Vest: 3,
  Broken: 4,
  Opinion: 5,
  Round: 6, // AI court round (encodeRoundReport, separate layout)
} as const;

export type Report = {
  kind: number;           // which ReportKind
  dealId: bigint;
  clauseId: number;
  value: number;          // days to vest, or court band; 0 otherwise
  data: Hex;              // specHash for Certify; ZERO32 otherwise
  sourceSelector: bigint; // which chain this report is for (replay protection)
  timestamp: bigint;      // when it was made (replay protection)
};

// The exact field order the contract decodes. Never change without all 3 agreeing.
const REPORT_ABI = parseAbiParameters(
  "uint8 kind, uint256 dealId, uint8 clauseId, uint8 value, bytes32 data, uint64 sourceSelector, uint64 timestamp"
);

export function encodeReport(r: Report): Hex {
  return encodeAbiParameters(REPORT_ABI, [
    r.kind, r.dealId, r.clauseId, r.value, r.data, r.sourceSelector, r.timestamp,
  ]);
}

export function decodeReport(hex: Hex): Report {
  const [kind, dealId, clauseId, value, data, sourceSelector, timestamp] =
    decodeAbiParameters(REPORT_ABI, hex);
  return { kind, dealId, clauseId, value, data, sourceSelector, timestamp };
}

// ---------- V2: AI court round report (WF3 → AICourt), kind 6 ----------
// Separate layout from the 7-field report above: AICourt decodes it itself (docs/INTERFACES.md).
export const ROUND_REPORT_KIND = 6;

export type RoundReport = {
  caseId: bigint;
  round: number;
  bands: [number, number, number];        // each judge's latest band: 0 / 50 / 80 / 100
  wordsUsed: [number, number, number];    // running total per judge
  wantsExtend: [boolean, boolean, boolean];
  isFinal: [boolean, boolean, boolean];
  citedMask: [number, number, number];    // bit 0 = clause terms, 1 = submitted evidence, 2 = dispute reason
  transcriptHash: Hex;                    // keccak256 of the stored transcript JSON
};

const ROUND_ABI = parseAbiParameters(
  "uint8 kind, uint256 caseId, uint8 round, uint8[3] bands, uint16[3] wordsUsed, bool[3] wantsExtend, bool[3] isFinal, uint8[3] citedMask, bytes32 transcriptHash"
);

export function encodeRoundReport(r: RoundReport): Hex {
  return encodeAbiParameters(ROUND_ABI, [
    ROUND_REPORT_KIND, r.caseId, r.round, r.bands, r.wordsUsed, r.wantsExtend, r.isFinal, r.citedMask, r.transcriptHash,
  ]);
}

export function decodeRoundReport(hex: Hex): RoundReport {
  const [, caseId, round, bands, wordsUsed, wantsExtend, isFinal, citedMask, transcriptHash] =
    decodeAbiParameters(ROUND_ABI, hex);
  return {
    caseId, round,
    bands: [...bands] as RoundReport["bands"],
    wordsUsed: [...wordsUsed] as RoundReport["wordsUsed"],
    wantsExtend: [...wantsExtend] as RoundReport["wantsExtend"],
    isFinal: [...isFinal] as RoundReport["isFinal"],
    citedMask: [...citedMask] as RoundReport["citedMask"],
    transcriptHash,
  };
}
