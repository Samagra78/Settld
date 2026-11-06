// WF1 — Verify a submitted deliverable, automatically.
//
// Trigger: ClauseEscrow emits ClauseSubmitted(uint256 indexed dealId, uint8 clauseId, string evidence)
//          when the freelancer submits evidence for a clause: a YouTube id, any URL, a GitHub PR link,
//          or an IPFS id of a screenshot.
// Steps (every CRE node runs them and must agree on the verdict):
//   1. Read the clause from ClauseEscrow (what has to be checked, and the deadline).
//   2. Run that clause's verifier:
//        0 POSTED_BY / 1 DESC_CONTAINS → YouTube
//        4 URL_LIVE / 5 URL_CONTAINS   → fetch the link (and look for the text)
//        6 GITHUB_MERGED               → GitHub API: is the PR merged (into param repo, if set)?
//        7 AI_CHECK                    → 3 free LLMs judge the linked content against the criteria; majority
//   3. Decide PASS / FAIL.
//   4. Send a Verified (kind 1) or Failed (kind 2) report to ClauseEscrow (value = reason code).
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

import { askJudge, decodeText, DEFAULT_JUDGES, evidence, GUARDRAIL, parseJson, stripHtml } from "../lib/llm";

export type Config = {
  chainSelectorName: string;
  escrowAddress: string;
  gasLimit: string;
  // AI_CHECK demo safety: use canned votes instead of live model calls
  replay?: boolean;
  replayVerdicts?: Record<string, boolean[]>; // evidence string → 3 votes
};

// ClauseEscrow check types / statuses (docs/INTERFACES.md)
const CHECK_POSTED_BY = 0;
const CHECK_DESC_CONTAINS = 1;
const CHECK_URL_LIVE = 4;
const CHECK_URL_CONTAINS = 5;
const CHECK_GITHUB_MERGED = 6;
const CHECK_AI = 7;
const STATUS_SUBMITTED = 1;

const ESCROW_ABI = parseAbi([
  "event ClauseSubmitted(uint256 indexed dealId, uint8 clauseId, string videoId)",
  "function getClauses(uint256 dealId) view returns ((uint8 kind, uint8 checkType, string param, uint64 deadline, uint256 amount, uint8 dependsOn, uint8 onFail, uint32 vestDays, uint32 daysVested, uint8 status, uint64 verifiedAt)[])",
]);
const CLAUSE_SUBMITTED_TOPIC = keccak256(toBytes("ClauseSubmitted(uint256,uint8,string)"));

// Reason codes sent in the report's `value` field (0 = generic)
const Reason = {
  OK: 0, NOT_FOUND: 1, NOT_PUBLIC: 2, LATE: 3, TEXT_MISSING: 4, UNSUPPORTED: 5,
  LINK_DOWN: 6, NOT_MERGED: 7, AI_REJECTED: 8, NO_AI: 9, WRONG_CHANNEL: 10,
} as const;

type Verdict = { pass: boolean; reason: number; detail: string; retry?: boolean };
// Temporary failures (rate limits, server errors, too few AI answers) must NOT become a verdict:
// the workflow stops without a report and the watcher retries later.
const transient = (status: number) => status === 403 || status === 429 || status >= 500;

// ---------- any-link checks (runs on every node; nodes must return identical verdicts) ----------
type Keys = { youtube: string; groq: string; gemini: string; nvidia: string; github: string };

const verdictOf = (v: Verdict) => JSON.stringify(v);

/** Pick the right verifier for the clause's check type. */
export const checkEvidence = (
  sr: HTTPSendRequester,
  evidenceStr: string,
  checkType: number,
  param: string,
  deadline: bigint,
  keys: Keys,
  replay: boolean,
  replayVerdicts: Record<string, boolean[]>
): string => {
  const ev = evidenceStr.trim();
  if (checkType === CHECK_POSTED_BY || checkType === CHECK_DESC_CONTAINS) {
    return checkVideo(sr, youtubeId(ev), checkType, param, deadline, keys.youtube);
  }
  if (checkType === CHECK_URL_LIVE || checkType === CHECK_URL_CONTAINS) return checkUrl(sr, ev, checkType, param);
  if (checkType === CHECK_GITHUB_MERGED) return checkGithub(sr, ev, param, keys.github);
  if (checkType === CHECK_AI) return checkWithAI(sr, ev, param, keys, replay, replayVerdicts);
  return verdictOf({ pass: false, reason: Reason.UNSUPPORTED, detail: `check type ${checkType} not supported by WF1` });
};

/** Accept a bare id or any YouTube URL (watch, youtu.be, shorts). */
const youtubeId = (s: string) => {
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : s;
};

/** ipfs://CID or a bare CID → a public gateway URL; anything else must be http(s). */
const toUrl = (s: string) => {
  if (s.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${s.slice(7)}`;
  if (/^(Qm[1-9A-Za-z]{44}|bafy[0-9a-z]{50,})$/.test(s)) return `https://ipfs.io/ipfs/${s}`;
  return /^https?:\/\//i.test(s) ? s : "";
};

const checkUrl = (sr: HTTPSendRequester, ev: string, checkType: number, param: string): string => {
  const url = toUrl(ev);
  if (!url) return verdictOf({ pass: false, reason: Reason.NOT_FOUND, detail: "evidence is not a link" });
  const res = sr.sendRequest({ url, method: "GET", headers: { "User-Agent": "Settld-CRE/1.0" } }).result();
  if (res.statusCode < 200 || res.statusCode >= 400) {
    return verdictOf({ pass: false, reason: Reason.LINK_DOWN, detail: `link returned ${res.statusCode}`, retry: transient(res.statusCode) });
  }
  if (checkType === CHECK_URL_LIVE) return verdictOf({ pass: true, reason: Reason.OK, detail: "link is live" });
  const text = stripHtml(decodeText(res.body), 200_000).toLowerCase();
  const found = text.includes(param.toLowerCase());
  return verdictOf(
    found
      ? { pass: true, reason: Reason.OK, detail: `page contains "${param}"` }
      : { pass: false, reason: Reason.TEXT_MISSING, detail: `"${param}" not found on the page` }
  );
};

/** GITHUB_MERGED: evidence = PR URL; optional param = "owner/repo" the PR must target. */
const checkGithub = (sr: HTTPSendRequester, ev: string, param: string, token: string): string => {
  const m = ev.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i);
  if (!m) return verdictOf({ pass: false, reason: Reason.NOT_FOUND, detail: "not a GitHub pull request link" });
  const [, owner, repo, num] = m;
  if (param.trim() && `${owner}/${repo}`.toLowerCase() !== param.trim().toLowerCase()) {
    return verdictOf({ pass: false, reason: Reason.NOT_MERGED, detail: `PR is in ${owner}/${repo}, expected ${param}` });
  }
  const res = sr.sendRequest({
    url: `https://api.github.com/repos/${owner}/${repo}/pulls/${num}`,
    method: "GET",
    headers: { "User-Agent": "Settld-CRE/1.0", Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).result();
  if (res.statusCode !== 200) return verdictOf({ pass: false, reason: Reason.NOT_FOUND, detail: `GitHub ${res.statusCode}`, retry: transient(res.statusCode) });
  const pr = JSON.parse(decodeText(res.body));
  return verdictOf(
    pr.merged === true
      ? { pass: true, reason: Reason.OK, detail: `PR #${num} merged into ${owner}/${repo}` }
      : { pass: false, reason: Reason.NOT_MERGED, detail: `PR #${num} is not merged` }
  );
};

/** AI_CHECK: 3 free models each say pass/fail against the criteria; majority wins. */
const checkWithAI = (
  sr: HTTPSendRequester,
  ev: string,
  criteria: string,
  keys: Keys,
  replay: boolean,
  replayVerdicts: Record<string, boolean[]>
): string => {
  let votes: boolean[];
  if (replay) {
    votes = replayVerdicts[ev] ?? [true, true, true];
  } else {
    // what the judges read: the linked page's text (or the evidence string itself if it isn't a link)
    let content = ev;
    const url = toUrl(ev);
    if (url) {
      const res = sr.sendRequest({ url, method: "GET", headers: { "User-Agent": "Settld-CRE/1.0" } }).result();
      if (res.statusCode < 200 || res.statusCode >= 400) {
        return verdictOf({ pass: false, reason: Reason.LINK_DOWN, detail: `link returned ${res.statusCode}`, retry: transient(res.statusCode) });
      }
      content = stripHtml(decodeText(res.body), 4000);
    }
    const user = [
      `Criteria the freelancer's work must meet:\n"${criteria}"`,
      evidence(1, "submitted work", content),
      'Does the submitted work meet the criteria? Answer exactly {"pass": true} or {"pass": false}.',
    ].join("\n\n");
    const keyOf = { groq: keys.groq, gemini: keys.gemini, nvidia: keys.nvidia };
    votes = [];
    for (const judge of DEFAULT_JUDGES) {
      const answer = parseJson<{ pass?: boolean }>(askJudge(sr, judge, keyOf[judge.provider], GUARDRAIL, user, 50));
      if (answer && typeof answer.pass === "boolean") votes.push(answer.pass);
    }
  }
  if (votes.length < 2) return verdictOf({ pass: false, reason: Reason.NO_AI, detail: "fewer than 2 AI judges answered", retry: true });
  const yes = votes.filter(Boolean).length;
  const pass = yes * 2 > votes.length;
  return verdictOf({
    pass,
    reason: pass ? Reason.OK : Reason.AI_REJECTED,
    detail: `AI check: ${yes} of ${votes.length} judges say it meets "${criteria}"`,
  });
};

// ---------- YouTube ----------
/** The channel a POSTED_BY clause names: a channel link, @handle, channel id (UC…) or the exact channel name. */
export const expectedChannel = (param: string): { id: string; handle: string; name: string } => {
  const raw = param.trim().replace(/^https?:\/\//i, "").replace(/^(www\.|m\.)?youtube\.com\//i, "");
  const channel = /^channel\/(UC[\w-]{22})/i.exec(raw);
  if (channel) return { id: channel[1], handle: "", name: "" };
  const p = raw.replace(/[/?#].*$/, "");
  if (/^@[\w.-]+$/.test(p)) return { id: "", handle: p, name: "" };
  if (/^UC[\w-]{22}$/.test(p)) return { id: p, handle: "", name: "" };
  return { id: "", handle: "", name: param.trim() };
};

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
  // who posted it: channel id (Data API only), @handle and display name
  let channelId = "";
  let channelHandle = "";
  let channelName = "";

  if (apiKey) {
    // Data API: ask only for the fields we need (keeps the response small)
    const url =
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${enc(videoId)}` +
      `&fields=items(snippet(publishedAt,title,description,channelId,channelTitle),status(privacyStatus))&key=${enc(apiKey)}`;
    const res = sendRequester.sendRequest({ url, method: "GET" }).result();
    if (res.statusCode !== 200) return verdict({ pass: false, reason: Reason.NOT_FOUND, detail: `YouTube API ${res.statusCode}`, retry: transient(res.statusCode) });
    const item = decode(res.body).items?.[0];
    if (!item) return verdict({ pass: false, reason: Reason.NOT_FOUND, detail: "video not found" });
    isPublic = item.status?.privacyStatus === "public";
    publishedAt = BigInt(Math.floor(Date.parse(item.snippet?.publishedAt ?? "") / 1000) || 0);
    text = `${item.snippet?.title ?? ""}\n${item.snippet?.description ?? ""}`;
    channelId = item.snippet?.channelId ?? "";
    channelName = item.snippet?.channelTitle ?? "";
    // the @handle lives on the channel, not the video: one more call, only when the clause names a handle
    if (checkType === CHECK_POSTED_BY && expectedChannel(param).handle && channelId) {
      const ch = sendRequester.sendRequest({
        url: `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${enc(channelId)}&fields=items(snippet(customUrl))&key=${enc(apiKey)}`,
        method: "GET",
      }).result();
      if (ch.statusCode !== 200) return verdict({ pass: false, reason: Reason.NOT_FOUND, detail: `YouTube API ${ch.statusCode} (channel)`, retry: transient(ch.statusCode) });
      channelHandle = decode(ch.body).items?.[0]?.snippet?.customUrl ?? "";
    }
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
    const body = decode(res.body);
    text = body.title ?? "";
    channelName = body.author_name ?? "";
    // author_url is https://www.youtube.com/@handle
    channelHandle = /\/(@[^/?#]+)/.exec(body.author_url ?? "")?.[1] ?? "";
  }

  if (!isPublic) return verdict({ pass: false, reason: Reason.NOT_PUBLIC, detail: "video is not public" });

  if (checkType === CHECK_POSTED_BY) {
    // the clause must say whose video it is; otherwise anyone's public video would pass
    const want = expectedChannel(param);
    if (!want.id && !want.handle && !want.name) {
      return verdict({ pass: false, reason: Reason.WRONG_CHANNEL, detail: "the clause names no channel, so the poster can't be checked" });
    }
    const same = (a: string, b: string) => a !== "" && a.toLowerCase() === b.toLowerCase();
    const posted = channelHandle || channelName || channelId || "unknown channel";
    if (want.id && !channelId) {
      return verdict({ pass: false, reason: Reason.WRONG_CHANNEL, detail: "channel ids can only be checked with the YouTube API key" });
    }
    const match = want.id ? same(channelId, want.id) : want.handle ? same(channelHandle, want.handle) : same(channelName.trim(), want.name);
    if (!match) {
      return verdict({ pass: false, reason: Reason.WRONG_CHANNEL, detail: `posted by ${posted}, not ${want.id || want.handle || want.name}` });
    }
    if (publishedAt !== 0n && publishedAt > deadline) {
      return verdict({ pass: false, reason: Reason.LATE, detail: "posted after the deadline" });
    }
    return verdict({ pass: true, reason: Reason.OK, detail: apiKey ? `public, posted in time by ${posted}` : `public, posted by ${posted} (publish date not checked without API key)` });
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

  // 2+3. check the evidence — every node fetches, they must agree on the identical verdict
  const secret = (id: string) => {
    try {
      return runtime.getSecret({ id }).result().value ?? "";
    } catch {
      return ""; // not configured → that source is skipped / falls back
    }
  };
  const needsAI = clause.checkType === CHECK_AI && !config.replay;
  const keys: Keys = {
    youtube: clause.checkType <= CHECK_DESC_CONTAINS ? secret("YOUTUBE_API_KEY") : "",
    groq: needsAI ? secret("GROQ_API_KEY") : "",
    gemini: needsAI ? secret("GEMINI_API_KEY") : "",
    nvidia: needsAI ? secret("NVIDIA_API_KEY") : "",
    github: clause.checkType === CHECK_GITHUB_MERGED ? secret("GITHUB_TOKEN") : "",
  };
  const http = new HTTPClient();
  const verdictJson = http
    .sendRequest(runtime, checkEvidence, consensusIdenticalAggregation<string>())(
      videoId, clause.checkType, clause.param, clause.deadline, keys, !!config.replay, config.replayVerdicts ?? {}
    )
    .result();
  const verdict = JSON.parse(verdictJson) as Verdict;
  if (verdict.retry) throw new Error(`Temporary problem, no verdict sent (will retry): ${verdict.detail}`);
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
