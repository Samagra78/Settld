// WF0 — Certify a deal before it can be funded.
//
// Trigger: HTTP request with {"dealId": N}.
// Steps (every CRE node runs the same steps and must agree):
//   1. READ the deal and its clauses straight from ClauseEscrow on Arc
//      (never from our server — so we certify exactly what is stored on-chain).
//   2. Recompute the deal fingerprint (specHash) from the clause terms and check it
//      equals the one the contract stored.
//   3. Run the deadlock checker (shared/checker.ts): amounts add up, dependencies are
//      valid, and money can never get stuck.
//   4. If everything passes, send a Certify report (kind 0, data = specHash).
//      ClauseEscrow only accepts funding once it has this certificate.

import {
  bytesToHex,
  decodeJson,
  encodeCallMsg,
  EVMClient,
  getNetwork,
  handler,
  hexToBase64,
  HTTPCapability,
  LAST_FINALIZED_BLOCK_NUMBER,
  Runner,
  TxStatus,
  type EVMLog,
  type HTTPPayload,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeFunctionResult,
  encodeFunctionData,
  hexToBigInt,
  keccak256,
  parseAbi,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { checkDeal } from "../../shared/checker";
import { encodeReport, ReportKind, ARC_TESTNET_SELECTOR } from "../../shared/report";
import { computeSpecHash, type ClauseTerms } from "../../shared/spec";

export type Config = {
  chainSelectorName: string;
  escrowAddress: string;
  gasLimit: string;
};

// Only the read functions WF0 needs (shapes match shared/abi/ClauseEscrow.json)
const ESCROW_ABI = parseAbi([
  "function getDeal(uint256 dealId) view returns ((address brand, address creator, address token, uint256 total, bytes32 specHash, bool accepted, bool funded))",
  "function getClauses(uint256 dealId) view returns ((uint8 kind, uint8 checkType, string param, uint64 deadline, uint256 amount, uint8 dependsOn, uint8 onFail, uint32 vestDays, uint32 daysVested, uint8 status, uint64 verifiedAt)[])",
  "function certified(uint256 dealId) view returns (bool)",
]);

type Result = { dealId: string; certified: boolean; reasons: string[]; txHash?: string };

// Trigger 0 (manual / website button): HTTP {"dealId": N}
export const onCertifyRequest = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const body = decodeJson(payload.input) as { dealId?: number | string };
  if (body?.dealId === undefined) throw new Error('Request body must be {"dealId": <number>}');
  return certifyDeal(runtime, BigInt(body.dealId));
};

// Trigger 1 (automatic): ClauseEscrow emits DealAccepted(uint256 indexed dealId)
// when the creator accepts — no human needs to ask for certification.
export const onDealAccepted = (runtime: Runtime<Config>, log: EVMLog): string => {
  const dealId = hexToBigInt(bytesToHex(log.topics[1]) as Hex); // topics[1] = indexed dealId
  runtime.log(`WF0 triggered automatically by DealAccepted for deal ${dealId}`);
  return certifyDeal(runtime, dealId);
};

const certifyDeal = (runtime: Runtime<Config>, dealId: bigint): string => {
  const { config } = runtime;

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const escrow = config.escrowAddress as Address;

  // read helper: call a view function on the last finalized block
  const read = (functionName: "getDeal" | "getClauses" | "certified") => {
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName, args: [dealId] });
    const reply = evm
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: escrow, data }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();
    return decodeFunctionResult({ abi: ESCROW_ABI, functionName, data: bytesToHex(reply.data) as Hex });
  };

  const done = (r: Omit<Result, "dealId">): string => {
    const out: Result = { dealId: dealId.toString(), ...r };
    runtime.log(`WF0 deal ${out.dealId}: ${out.certified ? "CERTIFIED" : "REFUSED"} ${out.reasons.join(" | ")}`);
    return JSON.stringify(out);
  };

  // 1. read the deal from the chain
  const deal = read("getDeal") as {
    total: bigint; specHash: Hex; accepted: boolean; funded: boolean;
  };
  if (isTrue(read("certified"))) return done({ certified: false, reasons: ["Deal is already certified."] });
  if (!deal.accepted) return done({ certified: false, reasons: ["Creator has not accepted the deal yet."] });
  if (deal.funded) return done({ certified: false, reasons: ["Deal is already funded."] });

  const clauses = read("getClauses") as readonly {
    kind: number; checkType: number; param: string; deadline: bigint; amount: bigint;
    dependsOn: number; onFail: number; vestDays: number;
  }[];

  // keep only the agreed TERMS (no status fields) — same shape as shared/spec.ts
  const terms: ClauseTerms[] = clauses.map((c) => ({
    kind: c.kind, checkType: c.checkType, param: c.param, deadline: c.deadline,
    amount: c.amount, dependsOn: c.dependsOn, onFail: c.onFail, vestDays: c.vestDays,
  }));

  // 2. the fingerprint we compute must equal the one the contract stored
  const specHash = computeSpecHash(terms);
  if (specHash.toLowerCase() !== deal.specHash.toLowerCase()) {
    return done({
      certified: false,
      reasons: [`specHash mismatch: computed ${specHash}, contract has ${deal.specHash}.`],
    });
  }

  // 3. deadlock checker
  const check = checkDeal(terms, deal.total);
  if (!check.valid) return done({ certified: false, reasons: check.errors });

  // 4. send the certificate
  const reportHex = encodeReport({
    kind: ReportKind.Certify,
    dealId,
    clauseId: 0,
    value: 0,
    data: specHash,
    sourceSelector: ARC_TESTNET_SELECTOR,
    timestamp: BigInt(Math.floor(runtime.now().getTime() / 1000)),
  });

  const report = runtime
    .report({
      encodedPayload: hexToBase64(reportHex),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  const write = evm
    .writeReport(runtime, { receiver: escrow, report, gasConfig: { gasLimit: config.gasLimit } })
    .result();
  if (write.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Certify write failed, status ${write.txStatus}`);
  }
  const txHash = bytesToHex(write.txHash || new Uint8Array(32));
  return done({
    certified: true,
    reasons: [`Checker passed (${check.statesExplored} states explored).`],
    txHash,
  });
};

// read("certified") returns a plain boolean
const isTrue = (v: unknown): boolean => v === true;

export const initWorkflow = (config: Config) => {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const http = new HTTPCapability();

  return [
    // 0: manual certify (HTTP)
    handler(http.trigger({}), onCertifyRequest),
    // 1: automatic certify when the creator accepts
    handler(
      evm.logTrigger({
        addresses: [hexToBase64(config.escrowAddress)],
        topics: [{ values: [hexToBase64(DEAL_ACCEPTED_TOPIC)] }],
      }),
      onDealAccepted
    ),
  ];
};

const DEAL_ACCEPTED_TOPIC = keccak256(toBytes("DealAccepted(uint256)"));

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
