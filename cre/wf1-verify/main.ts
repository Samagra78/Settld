// WF1 — Verify a submitted video, automatically.
//
// Trigger: ClauseEscrow emits ClauseSubmitted(uint256 indexed dealId, uint8 clauseId, string videoId)
//          when the creator submits a YouTube video ID for a clause.
// Steps (every CRE node runs them and must agree on the verdict):
//   1. Read the clause from ClauseEscrow (what has to be checked, and the deadline).
//   2. Fetch the video's public data from YouTube.
//   3. Decide PASS / FAIL for that clause's check type.
//   4. Send a Verified (kind 1) or Failed (kind 2) report to ClauseEscrow.
//
// YouTube source:
//   - With a YOUTUBE_API_KEY secret: YouTube Data API v3 (status, publish date, title, description).
//   - Without it: YouTube's public oEmbed endpoint (exists + public + title only).
//     Description checks then fall back to the title — fine for demos, set the key for real use.

import {
  bytesToHex,
  consensusIdenticalAggregation,
  encodeCallMsg,
  EVMClient,
  getNetwork,
  handler,
  hexToBase64,
  HTTPClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  Runner,
  TxStatus,
  type EVMLog,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { encodeReport, ReportKind, ARC_TESTNET_SELECTOR, ZERO32 } from "../../shared/report";

export type Config = {
  chainSelectorName: string;
  escrowAddress: string;
  gasLimit: string;
};

// ClauseEscrow check types / statuses (docs/INTERFACES.md)
const CHECK_POSTED_BY = 0;
const CHECK_DESC_CONTAINS = 1;
const STATUS_SUBMITTED = 1;

const ESCROW_ABI = parseAbi([
  "event ClauseSubmitted(uint256 indexed dealId, uint8 clauseId, string videoId)",
  "function getClauses(uint256 dealId) view returns ((uint8 kind, uint8 checkType, string param, uint64 deadline, uint256 amount, uint8 dependsOn, uint8 onFail, uint32 vestDays, uint32 daysVested, uint8 status, uint64 verifiedAt)[])",
]);
const CLAUSE_SUBMITTED_TOPIC = keccak256(toBytes("ClauseSubmitted(uint256,uint8,string)"));

// Reason codes sent in the report's `value` field (0 = generic)
const Reason = { OK: 0, NOT_FOUND: 1, NOT_PUBLIC: 2, LATE: 3, TEXT_MISSING: 4, UNSUPPORTED: 5 } as const;

type Verdict = { pass: boolean; reason: number; detail: string };

// ---------- YouTube fetch (runs on every node; nodes must return identical verdicts) ----------
const checkVideo = (
  sendRequester: HTTPSendRequester,
  videoId: string,
  checkType: number,
  param: string,
  deadline: bigint,
  apiKey: string
): string => {
  const enc = encodeURIComponent;
  const decode = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body));
  const verdict = (v: Verdict) => JSON.stringify(v);

  let isPublic = false;
  let publishedAt = 0n; // 0 = unknown (oEmbed)
  let text = "";

  if (apiKey) {
    // Data API: ask only for the fields we need (keeps the response small)
    const url =
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${enc(videoId)}` +
      `&fields=items(snippet(publishedAt,title,description),status(privacyStatus))&key=${enc(apiKey)}`;
    const res = sendRequester.sendRequest({ url, method: "GET" }).result();
    if (res.statusCode !== 200) return verdict({ pass: false, reason: Reason.NOT_FOUND, detail: `YouTube API ${res.statusCode}` });
    const item = decode(res.body).items?.[0];
    if (!item) return verdict({ pass: false, reason: Reason.NOT_FOUND, detail: "video not found" });
    isPublic = item.status?.privacyStatus === "public";
    publishedAt = BigInt(Math.floor(Date.parse(item.snippet?.publishedAt ?? "") / 1000) || 0);
    text = `${item.snippet?.title ?? ""}\n${item.snippet?.description ?? ""}`;
  } else {
    // oEmbed: no key needed; 200 = public video, 401/403 = private/unembeddable, 404 = missing
    const watch = `https://www.youtube.com/watch?v=${enc(videoId)}`;
    const res = sendRequester
      .sendRequest({ url: `https://www.youtube.com/oembed?url=${enc(watch)}&format=json`, method: "GET" })
      .result();
    if (res.statusCode === 404 || res.statusCode === 400) {
      return verdict({ pass: false, reason: Reason.NOT_FOUND, detail: "video not found" });
    }
    if (res.statusCode !== 200) {
      return verdict({ pass: false, reason: Reason.NOT_PUBLIC, detail: `video not public (oEmbed ${res.statusCode})` });
    }
    isPublic = true;
    text = decode(res.body).title ?? "";
  }

  if (!isPublic) return verdict({ pass: false, reason: Reason.NOT_PUBLIC, detail: "video is not public" });

  if (checkType === CHECK_POSTED_BY) {
    if (publishedAt !== 0n && publishedAt > deadline) {
      return verdict({ pass: false, reason: Reason.LATE, detail: "posted after the deadline" });
    }
    return verdict({ pass: true, reason: Reason.OK, detail: apiKey ? "public, posted in time" : "public (publish date not checked without API key)" });
  }

  if (checkType === CHECK_DESC_CONTAINS) {
    const found = text.toLowerCase().includes(param.toLowerCase());
    return verdict(
      found
        ? { pass: true, reason: Reason.OK, detail: `contains "${param}"` }
        : { pass: false, reason: Reason.TEXT_MISSING, detail: `"${param}" not found${apiKey ? "" : " in title (no API key: description not checked)"}` }
    );
  }

  return verdict({ pass: false, reason: Reason.UNSUPPORTED, detail: `check type ${checkType} not supported by WF1` });
};

// ---------- handler ----------
export const onClauseSubmitted = (runtime: Runtime<Config>, log: EVMLog): string => {
  const { config } = runtime;

  // 0. decode the event
  const ev = decodeEventLog({
    abi: ESCROW_ABI,
    eventName: "ClauseSubmitted",
    topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
    data: bytesToHex(log.data) as Hex,
  });
  const { dealId, clauseId, videoId } = ev.args;
  runtime.log(`WF1: deal ${dealId} clause ${clauseId} submitted video "${videoId}"`);

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const escrow = config.escrowAddress as Address;

  // 1. read the clause from the chain
  const data = encodeFunctionData({ abi: ESCROW_ABI, functionName: "getClauses", args: [dealId] });
  const reply = evm
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: escrow, data }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  const clauses = decodeFunctionResult({ abi: ESCROW_ABI, functionName: "getClauses", data: bytesToHex(reply.data) as Hex });
  const clause = clauses[clauseId];
  if (!clause) throw new Error(`Clause ${clauseId} not found on deal ${dealId}`);
  if (clause.status !== STATUS_SUBMITTED) {
    runtime.log(`WF1: clause is no longer Submitted (status ${clause.status}) — nothing to do`);
    return JSON.stringify({ dealId: dealId.toString(), clauseId, skipped: true });
  }

  // 2+3. YouTube check — every node fetches, they must agree on the identical verdict
  let apiKey = "";
  try {
    apiKey = runtime.getSecret({ id: "YOUTUBE_API_KEY" }).result().value ?? "";
  } catch {
    apiKey = ""; // no key configured → oEmbed fallback
  }
  const http = new HTTPClient();
  const verdictJson = http
    .sendRequest(runtime, checkVideo, consensusIdenticalAggregation<string>())(
      videoId, clause.checkType, clause.param, clause.deadline, apiKey
    )
    .result();
  const verdict = JSON.parse(verdictJson) as Verdict;
  runtime.log(`WF1: verdict ${verdict.pass ? "PASS" : "FAIL"} — ${verdict.detail}`);

  // 4. report to ClauseEscrow
  const reportHex = encodeReport({
    kind: verdict.pass ? ReportKind.Verified : ReportKind.Failed,
    dealId,
    clauseId,
    value: verdict.reason,
    data: ZERO32,
    sourceSelector: ARC_TESTNET_SELECTOR,
    timestamp: BigInt(Math.floor(runtime.now().getTime() / 1000)),
  });
  const report = runtime
    .report({ encodedPayload: hexToBase64(reportHex), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" })
    .result();
  const write = evm
    .writeReport(runtime, { receiver: escrow, report, gasConfig: { gasLimit: config.gasLimit } })
    .result();
  if (write.txStatus !== TxStatus.SUCCESS) throw new Error(`Report write failed, status ${write.txStatus}`);

  const txHash = bytesToHex(write.txHash || new Uint8Array(32));
  return JSON.stringify({
    dealId: dealId.toString(),
    clauseId,
    verified: verdict.pass,
    detail: verdict.detail,
    txHash,
  });
};

export const initWorkflow = (config: Config) => {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  return [
    handler(
      evm.logTrigger({
        addresses: [hexToBase64(config.escrowAddress)],
        topics: [{ values: [hexToBase64(CLAUSE_SUBMITTED_TOPIC)] }],
      }),
      onClauseSubmitted
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
