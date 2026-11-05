import { encodeAbiParameters, keccak256, type Hex } from "viem";

// One clause's terms — same fields, same order as Samagra's Solidity struct
export type ClauseTerms = {
  kind: number;
  checkType: number;
  param: string;
  deadline: bigint;
  amount: bigint;
  dependsOn: number;
  onFail: number;
  vestDays: number;
};

const CLAUSE_TERMS_TUPLE = {
  type: "tuple[]",
  components: [
    { name: "kind", type: "uint8" },
    { name: "checkType", type: "uint8" },
    { name: "param", type: "string" },
    { name: "deadline", type: "uint64" },
    { name: "amount", type: "uint256" },
    { name: "dependsOn", type: "uint8" },
    { name: "onFail", type: "uint8" },
    { name: "vestDays", type: "uint32" },
  ],
} as const;

// Must equal keccak256(abi.encode(terms)) in Solidity
export function computeSpecHash(terms: ClauseTerms[]): Hex {
  return keccak256(encodeAbiParameters([CLAUSE_TERMS_TUPLE], [terms]));
}