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
