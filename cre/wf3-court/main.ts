// WF3 — Settld's AI court: 3 free LLMs deliberate on a disputed clause, one round per run.
//
// Triggers:
//   0. AICourt CaseOpened(caseId, dealId, clauseId, reason, deadline) → round 0 (blind opinions)
//   1. AICourt RoundCompleted(caseId, round, transcriptHash)          → next round (discussion), if any
//   2. HTTP dry run {"transcript"?: ..., "case"?: {...}}              → runs one round off-chain, returns the
//      new transcript. No chain reads or writes. Use it to try the prompts / API keys before deploy.
//
// Each round (every node runs it; they must agree):
//   - Load the transcript: built from the chain on round 0; later fetched from the Settld server and checked
//     against the transcriptHash recorded on-chain, so the server can't change what the judges said.
//   - Ask each non-final judge (Groq Llama, Gemini, OpenRouter free model) with guardrails; enforce the
//     word budget, the evidence-citation rule and the extension rule (court.ts).
//   - Store the new transcript on the server, then send a Round report (kind 6) to AICourt with the
//     bands, word counts, extend votes, final flags, cited evidence and the transcript hash.
// AICourt enforces the same limits on-chain and computes the verdict from the final votes.

import {
  bytesToHex,
  consensusIdenticalAggregation,
  decodeJson,
  encodeCallMsg,
  EVMClient,
  getNetwork,
  handler,
  hexToBase64,
  HTTPCapability,
  HTTPClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  Runner,
  TxStatus,
  type EVMLog,
  type HTTPPayload,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  keccak256,
  parseAbi,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { CHECK_NAME } from "../../shared/checker";
import { encodeRoundReport } from "../../shared/report";
import { askJudge, decodeText, DEFAULT_JUDGES, jsonBody, stripHtml, type Provider } from "../lib/llm";
import replayFile from "./replay.json";
import { reportFields, runRound, shouldRunRound, stateOf, type Transcript } from "./court";

export type Config = {
  chainSelectorName: string;
  courtAddress: string;
  escrowAddress: string;
  gasLimit: string;
  serverUrl: string; // where transcripts are stored, e.g. http://localhost:3000
  replay?: boolean;  // scripted demo answers instead of live model calls
};

const COURT_ABI = parseAbi([
  "event CaseOpened(uint256 indexed caseId, uint256 dealId, uint8 clauseId, string reason, uint64 deadline)",
  "event RoundCompleted(uint256 indexed caseId, uint8 round, bytes32 transcriptHash)",
]);
const ESCROW_ABI = parseAbi([
  "function getClauses(uint256 dealId) view returns ((uint8 kind, uint8 checkType, string param, uint64 deadline, uint256 amount, uint8 dependsOn, uint8 onFail, uint32 vestDays, uint32 daysVested, uint8 status, uint64 verifiedAt)[])",
  "function evidenceOf(uint256 dealId, uint8 clauseId) view returns (string)",
]);
const CASE_OPENED_TOPIC = keccak256(toBytes("CaseOpened(uint256,uint256,uint8,string,uint64)"));
const ROUND_COMPLETED_TOPIC = keccak256(toBytes("RoundCompleted(uint256,uint8,bytes32)"));

type Keys = Record<Provider, string>;
type RoundOutcome =
  | { skip: true; why: string }
  | { skip: false; hash: Hex; fields: ReturnType<typeof reportFields>; transcript?: string };

const replayRounds = replayFile.rounds as unknown[][];

// ---------- one round, in node mode (HTTP allowed) ----------
const deliberate = (
  sr: HTTPSendRequester,
  start: string,          // round 0: the new transcript JSON (evidenceText empty); later: "" (fetched)
  caseId: string,
  expectedHash: string,   // later rounds: hash from RoundCompleted
  nowSec: number,
  keys: Keys,
  replay: boolean,
  serverUrl: string,
  token: string,
  returnTranscript: boolean
): string => {
  const out = (o: RoundOutcome) => JSON.stringify(o);
  let t: Transcript;

  if (start) {
    t = JSON.parse(start) as Transcript;
    // read the submitted work once, on round 0 (links are fetched; anything else is shown as-is)
    if (!t.evidenceText) {
      const url = /^https?:\/\//i.test(t.evidence) ? t.evidence
        : t.evidence.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${t.evidence.slice(7)}` : "";
      if (url && !replay) {
        const res = sr.sendRequest({ url, method: "GET", headers: { "User-Agent": "Settld-CRE/1.0" } }).result();
        t.evidenceText = res.statusCode >= 200 && res.statusCode < 400
          ? stripHtml(decodeText(res.body), 4000)
          : `(the link returned HTTP ${res.statusCode})`;
      } else {
        t.evidenceText = t.evidence;
      }
    }
  } else {
    const res = sr.sendRequest({ url: `${serverUrl}/api/court/${caseId}/transcript`, method: "GET" }).result();
    if (res.statusCode !== 200) return out({ skip: true, why: `transcript not found (HTTP ${res.statusCode})` });
    const raw = decodeText(res.body);
    if (keccak256(toBytes(raw)) !== expectedHash) return out({ skip: true, why: "stored transcript does not match the on-chain hash" });
    t = JSON.parse(raw) as Transcript;
  }

  if (!shouldRunRound(t, nowSec)) return out({ skip: true, why: "case is done (all final, last round, or too close to the deadline)" });

  const round = stateOf(t).nextRound;
  const after = runRound(t, (judge, system, user) => {
    if (replay) return JSON.stringify(replayRounds[round]?.[judge] ?? "");
    const j = DEFAULT_JUDGES[judge];
    return askJudge(sr, j, keys[j.provider], system, user, 500);
  });
  const json = JSON.stringify(after);
  const hash = keccak256(toBytes(json));

  if (serverUrl && token) {
    sr.sendRequest({
      url: `${serverUrl}/api/court/${caseId}/transcript`,
      method: "POST",
      headers: { "Content-Type": "application/json", "x-court-token": token },
      body: jsonBody({ transcript: json, hash }),
    }).result();
  }
  return out({ skip: false, hash, fields: reportFields(after), ...(returnTranscript ? { transcript: json } : {}) });
};

// ---------- helpers (DON mode) ----------
const secret = (runtime: Runtime<Config>, id: string) => {
  try {
    return runtime.getSecret({ id }).result().value ?? "";
  } catch {
    return "";
  }
};

const keysOf = (runtime: Runtime<Config>): Keys =>
  runtime.config.replay
    ? { groq: "", gemini: "", openrouter: "" }
    : { groq: secret(runtime, "GROQ_API_KEY"), gemini: secret(runtime, "GEMINI_API_KEY"), openrouter: secret(runtime, "OPENROUTER_API_KEY") };

const nowSec = (runtime: Runtime<Config>) => Math.floor(runtime.now().getTime() / 1000);

function runDeliberation(runtime: Runtime<Config>, start: string, caseId: string, expectedHash: string, returnTranscript: boolean) {
  const http = new HTTPClient();
  const token = returnTranscript ? "" : secret(runtime, "COURT_WRITE_TOKEN");
  const json = http
    .sendRequest(runtime, deliberate, consensusIdenticalAggregation<string>())(
      start, caseId, expectedHash, nowSec(runtime), keysOf(runtime), !!runtime.config.replay,
      returnTranscript ? "" : runtime.config.serverUrl, token, returnTranscript
    )
    .result();
  return JSON.parse(json) as RoundOutcome;
}

function writeRound(runtime: Runtime<Config>, caseId: bigint, o: Extract<RoundOutcome, { skip: false }>) {
  const { config } = runtime;
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const reportHex = encodeRoundReport({ caseId, ...o.fields, transcriptHash: o.hash });
  const report = runtime
    .report({ encodedPayload: hexToBase64(reportHex), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" })
    .result();
  const write = evm
    .writeReport(runtime, { receiver: config.courtAddress as Address, report, gasConfig: { gasLimit: config.gasLimit } })
    .result();
  if (write.txStatus !== TxStatus.SUCCESS) throw new Error(`Round report write failed, status ${write.txStatus}`);
  return bytesToHex(write.txHash || new Uint8Array(32));
}

function clauseTerms(runtime: Runtime<Config>, dealId: bigint, clauseId: number): { terms: string; evidence: string } {
  const { config } = runtime;
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const call = (functionName: "getClauses" | "evidenceOf", args: readonly unknown[]) => {
    const data = encodeFunctionData({ abi: ESCROW_ABI, functionName, args } as never);
    const reply = evm
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: config.escrowAddress as Address, data }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();
    return decodeFunctionResult({ abi: ESCROW_ABI, functionName, data: bytesToHex(reply.data) as Hex } as never) as unknown;
  };
  const clauses = call("getClauses", [dealId]) as Array<{ checkType: number; param: string; deadline: bigint; amount: bigint }>;
  const c = clauses[clauseId];
  if (!c) throw new Error(`Clause ${clauseId} not found on deal ${dealId}`);
  let evidence = "";
  try {
    evidence = call("evidenceOf", [dealId, clauseId]) as string;
  } catch {
    evidence = "(evidence not readable from the escrow)";
  }
  const terms =
    `Clause ${clauseId}: ${formatUnits(c.amount, 6)} USDC. Checked by: ${CHECK_NAME[c.checkType] ?? `type ${c.checkType}`}` +
    `${c.param ? `. Requirement: "${c.param}"` : ""}. Deadline: ${new Date(Number(c.deadline) * 1000).toISOString()}.`;
  return { terms, evidence };
}

// ---------- handlers ----------
export const onCaseOpened = (runtime: Runtime<Config>, log: EVMLog): string => {
  const ev = decodeEventLog({
    abi: COURT_ABI, eventName: "CaseOpened",
    topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]], data: bytesToHex(log.data) as Hex,
  });
  const { caseId, dealId, clauseId, reason, deadline } = ev.args;
  runtime.log(`WF3: case ${caseId} opened on deal ${dealId} clause ${clauseId}: "${reason}"`);

  const { terms, evidence } = clauseTerms(runtime, dealId, clauseId);
  const start: Transcript = {
    v: 1, caseId: caseId.toString(), dealId: dealId.toString(), clauseId, reason, terms, evidence,
    evidenceText: "", deadline0: Number(deadline), judges: DEFAULT_JUDGES.map((j) => j.name), rounds: [],
  };
  const o = runDeliberation(runtime, JSON.stringify(start), caseId.toString(), "", false);
  if (o.skip) return JSON.stringify({ caseId: caseId.toString(), skipped: o.why });
  const txHash = writeRound(runtime, caseId, o);
  runtime.log(`WF3: round 0 bands ${o.fields.bands.join("/")} → tx ${txHash}`);
  return JSON.stringify({ caseId: caseId.toString(), round: 0, bands: o.fields.bands, txHash });
};

export const onRoundCompleted = (runtime: Runtime<Config>, log: EVMLog): string => {
  const ev = decodeEventLog({
    abi: COURT_ABI, eventName: "RoundCompleted",
    topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]], data: bytesToHex(log.data) as Hex,
  });
  const { caseId, round, transcriptHash } = ev.args;
  const o = runDeliberation(runtime, "", caseId.toString(), transcriptHash, false);
  if (o.skip) {
    runtime.log(`WF3: case ${caseId} after round ${round}: no more rounds (${o.why})`);
    return JSON.stringify({ caseId: caseId.toString(), skipped: o.why });
  }
  const txHash = writeRound(runtime, caseId, o);
  runtime.log(`WF3: round ${o.fields.round} bands ${o.fields.bands.join("/")} final ${o.fields.isFinal.join("/")} → tx ${txHash}`);
  return JSON.stringify({ caseId: caseId.toString(), round: o.fields.round, bands: o.fields.bands, txHash });
};

type DryRun = {
  transcript?: Transcript;
  case?: { terms: string; evidence: string; evidenceText?: string; reason: string };
};

/** Off-chain dry run: one round, returns the new transcript. Nothing is written anywhere. */
export const onDryRun = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const input = decodeJson(payload.input) as DryRun;
  const now = nowSec(runtime);
  const t: Transcript = input.transcript ?? {
    v: 1, caseId: "dry-run", dealId: "0", clauseId: 0,
    reason: input.case?.reason ?? "", terms: input.case?.terms ?? "", evidence: input.case?.evidence ?? "",
    evidenceText: input.case?.evidenceText ?? "", deadline0: now + 180,
    judges: DEFAULT_JUDGES.map((j) => j.name), rounds: [],
  };
  const o = runDeliberation(runtime, JSON.stringify(t), t.caseId, "", true);
  if (o.skip) return JSON.stringify({ skipped: o.why });
  return o.transcript ?? "";
};

export const initWorkflow = (config: Config) => {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const court = hexToBase64(config.courtAddress);
  return [
    handler(evm.logTrigger({ addresses: [court], topics: [{ values: [hexToBase64(CASE_OPENED_TOPIC)] }] }), onCaseOpened),
    handler(evm.logTrigger({ addresses: [court], topics: [{ values: [hexToBase64(ROUND_COMPLETED_TOPIC)] }] }), onRoundCompleted),
    handler(new HTTPCapability().trigger({}), onDryRun),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
