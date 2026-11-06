// Full dispute flow on Arc testnet. This script only does what PEOPLE do:
//   client proposes + funds, freelancer accepts + submits, client disputes.
// Everything else must happen by itself (server watcher + keeper, Chainlink CRE workflows):
//   WF0 certifies → WF1 verifies the link → WF3 AI court debates round by round → keeper closes the case,
//   finalizes after the appeal window, and pays the split.
// Usage (from scripts/, with the server running and AUTOMATION_ENABLED=true):
//   bun run e2e-dispute            → no appeal: the AI verdict stands and is paid out
//   bun run e2e-dispute --appeal   → the freelancer appeals; 3 test arbitrators vote (100, 100, 0) → human verdict

import { readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodePacked, formatUnits, http, keccak256,
  parseAbi, parseAbiParameters, parseEventLogs, parseUnits, toHex,
  type Abi, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { checkDeal } from "../shared/checker";

const shared = JSON.parse(readFileSync(new URL("../shared/addresses.json", import.meta.url), "utf8"));
const load = (n: string) => {
  const f = JSON.parse(readFileSync(new URL(`../shared/abi/${n}.json`, import.meta.url), "utf8"));
  return (Array.isArray(f) ? f : f.abi) as Abi;
};
const escrowAbi = load("ClauseEscrow"), courtAbi = load("AICourt"), registryAbi = load("JurorRegistry");
const REGISTRY = shared.jurorRegistry.address as Address;
const APPEAL = process.argv.includes("--appeal") || process.env.E2E_APPEAL === "1";
const ESCROW = shared.clauseEscrow.address as Address, COURT = shared.aiCourt.address as Address;
const USDC = shared.usdc as Address;
// Arc public RPC rate-limits bursts: every call retries with back-off (retryCount 8, 1.5 s base)
const chain = defineChain({ id: shared.chainId, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [shared.rpc] } } });
const pub = createPublicClient({ chain, transport: http(undefined, { retryCount: 8, retryDelay: 1500 }) });
const client = createWalletClient({ account: privateKeyToAccount(process.env.BRAND_PRIVATE_KEY as Hex), chain, transport: http(undefined, { retryCount: 8, retryDelay: 1500 }) });
const freelancer = createWalletClient({ account: privateKeyToAccount(process.env.TESTER_PRIVATE_KEY as Hex), chain, transport: http(undefined, { retryCount: 8, retryDelay: 1500 }) });
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const EXPLORER = shared.explorer;

const AMOUNT = parseUnits(process.env.E2E_AMOUNT ?? "0.5", 6);
const EVIDENCE = process.env.E2E_EVIDENCE ?? "https://example.com";
const REASON = process.env.E2E_REASON ?? "The page is just a placeholder: it has no logo and no signup form.";
const STATUS = ["Pending", "Submitted", "Verified", "Failed", "Disputed", "Released", "Refunded"];

const t0 = Date.now();
const log = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${m}`);
const send = async (w: typeof client, address: Address, abi: Abi, functionName: string, args: unknown[], label: string) => {
  const hash = await w.writeContract({ address, abi, functionName, args } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  log(`👤 ${label} — ${EXPLORER}/tx/${hash}`);
  return r;
};
const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
const waitFor = async <T>(what: string, check: () => Promise<T | undefined>, timeoutS: number): Promise<T> => {
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    const v = await check().catch(() => undefined);
    if (v !== undefined && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error(`timed out waiting for: ${what}`);
};
const clause = async (dealId: bigint) => (await read<any[]>(ESCROW, escrowAbi, "getClauses", [dealId]))[0];

// 0. --appeal: three test arbitrators, each registered on JurorRegistry with an attestation from our test
//    attester (standing in for three World ID scans; the real IDKit flow is tested on /worldid-test)
const arbitrators: (typeof client)[] = [];
if (APPEAL) {
  const envFile = new URL("./.env", import.meta.url);
  let envText = readFileSync(envFile, "utf8");
  const attesterKey = readFileSync(new URL("../server/.env", import.meta.url), "utf8").match(/^ATTESTER_PRIVATE_KEY=(.+)$/m)?.[1].trim() as Hex;
  const attester = privateKeyToAccount(attesterKey);
  for (let i = 1; i <= 3; i++) {
    let key = (envText.match(new RegExp(`^ARB${i}_PRIVATE_KEY=(.+)$`, "m"))?.[1].trim() ?? "") as Hex;
    if (!key) {
      key = generatePrivateKey();
      envText += `${envText.endsWith("\n") ? "" : "\n"}ARB${i}_PRIVATE_KEY=${key}\n`;
      writeFileSync(envFile, envText); // test-only key, scripts/.env is git-ignored
    }
    const w = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(undefined, { retryCount: 8, retryDelay: 1500 }) });
    arbitrators.push(w);
    if ((await read<bigint>(USDC, erc20, "balanceOf", [w.account.address])) < parseUnits("0.1", 6)) {
      await send(client, USDC, erc20, "transfer", [w.account.address, parseUnits("0.2", 6)], `gas money for test arbitrator ${i}`);
    }
    if ((await read<bigint>(REGISTRY, registryAbi, "nullifierOf", [w.account.address])) === 0n) {
      const nullifier = BigInt(keccak256(toHex(`settld-test-human-${w.account.address}`)));
      const sig = await attester.signMessage({ message: { raw: keccak256(encodePacked(["uint256", "address"], [nullifier, w.account.address])) } });
      await send(w, REGISTRY, registryAbi, "registerPerson", [nullifier, sig], `test arbitrator ${i} registers (one human = one seat)`);
    }
  }
}

// 1. client proposes a 1-clause deal: "landing page with logo + signup form", checked by URL_LIVE (4)
const now = Math.floor(Date.now() / 1000);
// 1a. the contract starts as plain English → AI turns it into smart clauses → the deadlock checker runs
const SERVER = process.env.SETTLD_SERVER ?? "http://localhost:3000";
const CONTRACT_TEXT = process.env.E2E_CONTRACT ??
  "Hi Riya, thanks for taking this on. You will build Acme's launch landing page and publish it at a public link within 3 days. Payment is released when the page is live.";
const fallback = { title: "Landing page is live", checkType: 4, checkName: "Link is live", param: "", deadline: now + 3 * 86400, deadlineText: null as string | null };
const extracted = await fetch(`${SERVER}/api/monitor/extract`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: CONTRACT_TEXT, startDate: new Date().toISOString().slice(0, 10) }),
}).then((r) => (r.ok ? r.json() : null)).catch(() => null) as any;
const picked = (extracted?.clauses ?? []).find((c: any) => c.checkType === 4) ?? fallback;
log(`📝 AI turned the contract into ${extracted?.clauses?.length ?? 0} clause(s); using "${picked.title}" (${picked.checkName})`);
const deadline = BigInt(Math.max(picked.deadline ?? 0, now + 3600) || now + 3 * 86400);
const terms = [{ kind: 0, checkType: picked.checkType, param: picked.param ?? "", deadline, amount: AMOUNT, dependsOn: 255, onFail: 0, vestDays: 0 }];
const check = checkDeal(terms.map((t) => ({ ...t })), AMOUNT);
log(`🧮 ${check.summary}`);

log(`escrow ${ESCROW} · court ${COURT}`);
const proposed = await send(client, ESCROW, escrowAbi, "proposeDeal", [freelancer.account.address, AMOUNT, terms], "client proposes deal");
const dealId = (parseEventLogs({ abi: escrowAbi, logs: proposed.logs, eventName: "DealProposed" })[0] as any).args.dealId as bigint;
log(`deal ${dealId}`);
const story = (icon: string, title: string, detail: string) => fetch(`${SERVER}/api/monitor/story`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealId: Number(dealId), icon, title, detail }),
}).catch(() => {});
await story("📝", "The client wrote the contract in plain English", CONTRACT_TEXT);
await story("🤖", "AI turned it into smart clauses",
  [
    ...(extracted?.clauses ?? []).map((c: any, i: number) =>
      `Clause ${i}: ${c.title} — checked by "${c.checkName}"${c.deadlineText ? `, due ${c.deadlineText}` : ""}${c.vague ? ` (flagged as vague: ${c.vagueReason})` : ""}`),
    ...(extracted?.sentences ?? []).filter((s: any) => s.clause === null && s.note).map((s: any) => `Not a deliverable: "${s.text}" (${s.note})`),
    `Models: ${extracted?.models?.primary ?? "none"}${extracted?.models?.crossCheck ? ` + cross-check ${extracted.models.crossCheck}` : ""}.`,
    `The amount (${formatUnits(AMOUNT, 6)} USDC) is set by the people — the AI never sets money.`,
  ].join("\n"));
await story("🧮", check.valid ? "Deadlock check passed before anyone signed" : "Deadlock check FAILED", check.summary);

// 2. freelancer accepts → WF0 must certify by itself
await send(freelancer, ESCROW, escrowAbi, "acceptDeal", [dealId], "freelancer accepts");
await waitFor("Chainlink WF0 certification", async () => (await read<boolean>(ESCROW, escrowAbi, "certified", [dealId])) || undefined, 240);
log("🤖 Chainlink certified the deal (no deadlock)");

// 3. client funds
await send(client, USDC, erc20, "approve", [ESCROW, AMOUNT], "client approves USDC");
await send(client, ESCROW, escrowAbi, "fundDeal", [dealId], `client funds ${formatUnits(AMOUNT, 6)} USDC`);

// 4. freelancer submits a link → WF1 must verify by itself
await send(freelancer, ESCROW, escrowAbi, "submitEvidence", [dealId, 0, EVIDENCE], `freelancer submits ${EVIDENCE}`);
const verdict = await waitFor("Chainlink WF1 verdict", async () => {
  const s = Number((await clause(dealId)).status);
  return s === 2 || s === 3 ? s : undefined;
}, 240);
log(`🤖 Chainlink WF1: ${STATUS[verdict]}`);

// 5. client disputes inside the window → AICourt case → WF3 must run the debate by itself
const disputed = await send(client, ESCROW, escrowAbi, "dispute", [dealId, 0, REASON], `client disputes: "${REASON}"`);
const caseId = await read<bigint>(ESCROW, escrowAbi, "caseOf", [dealId, 0]);
log(`⚖️  AI court case ${caseId} opened (tx ${disputed.transactionHash})`);

let lastRound = -1;
const final = await waitFor("AI court verdict", async () => {
  const c = await read<any>(COURT, courtAbi, "getCase", [caseId]);
  const rounds = Number(c.nextRound);
  if (rounds - 1 > lastRound) {
    lastRound = rounds - 1;
    const judges = await Promise.all([0, 1, 2].map((j) => read<any>(COURT, courtAbi, "judgeLatest", [caseId, j])));
    log(`🤖 WF3 round ${lastRound}: bands ${judges.map((j) => j.band).join("/")} · words ${judges.map((j) => j.wordsUsed).join("/")} · final ${judges.map((j) => j.isFinal).join("/")} · budget ${c.wordBudget}${c.extensions > 0 ? ` · extensions ${c.extensions}` : ""}`);
  }
  return c.aiSet ? c : undefined;
}, 600);
log(`⚖️  AI verdict: band ${final.aiBand} (closed by the keeper) — appeal window open until ${new Date(Number(final.appealDeadline) * 1000).toLocaleTimeString()}`);

// 6a. --appeal: the freelancer rejects the AI verdict, pays 10% and the human arbitrators decide
const arbBefore = await Promise.all(arbitrators.map((a) => read<bigint>(USDC, erc20, "balanceOf", [a.account.address])));
if (APPEAL) {
  const fee = await read<bigint>(COURT, courtAbi, "appealFee", [caseId]);
  await send(freelancer, USDC, erc20, "approve", [COURT, fee], `freelancer approves the ${formatUnits(fee, 6)} USDC appeal fee`);
  await send(freelancer, COURT, courtAbi, "appeal", [caseId], "freelancer appeals to human arbitrators");
  await waitFor("panel opened", async () => (await read<any[]>(REGISTRY, registryAbi, "getPanel", [caseId]))[6] || undefined, 120);
  const bands = [100, 100, 0]; // the third arbitrator votes against the majority
  const salts = bands.map((_, i) => keccak256(toHex(`settld-e2e-${caseId}-${i}-${Date.now()}`)));
  for (const [i, a] of arbitrators.entries()) {
    const c = keccak256(encodeAbiParameters(parseAbiParameters("uint256, uint8, bytes32, address"), [caseId, bands[i], salts[i], a.account.address]));
    await send(a, REGISTRY, registryAbi, "commitVote", [caseId, c], `arbitrator ${i + 1} commits a hidden vote`);
  }
  for (const [i, a] of arbitrators.entries()) {
    await send(a, REGISTRY, registryAbi, "revealVote", [caseId, bands[i], salts[i]], `arbitrator ${i + 1} reveals: ${bands[i]}%`);
  }
  log("⚖️  all votes revealed — the keeper closes the panel, finalizes and pays out by itself");
}

// 6b. keeper finalizes (after the appeal window, or once the panel decided) and pays the split
const before = { f: await read<bigint>(USDC, erc20, "balanceOf", [freelancer.account.address]), c: await read<bigint>(USDC, erc20, "balanceOf", [client.account.address]) };
const settled = await waitFor("keeper settles the split", async () => {
  const s = Number((await clause(dealId)).status);
  return s === 5 || s === 6 ? s : undefined;
}, 420);
const after = { f: await read<bigint>(USDC, erc20, "balanceOf", [freelancer.account.address]), c: await read<bigint>(USDC, erc20, "balanceOf", [client.account.address]) };
log(`💸 settled (${STATUS[settled]}): freelancer +${formatUnits(after.f - before.f, 6)} USDC, client +${formatUnits(after.c - before.c, 6)} USDC`);
const fin = await read<any>(COURT, courtAbi, "getCase", [caseId]);
log(`⚖️  final band ${fin.finalBand}% ${fin.byHumans ? "(decided by human arbitrators)" : "(AI verdict stood)"}`);
if (APPEAL) {
  for (const [i, a] of arbitrators.entries()) {
    const gained = (await read<bigint>(USDC, erc20, "balanceOf", [a.account.address])) - arbBefore[i];
    const n = await read<bigint>(REGISTRY, registryAbi, "nullifierOf", [a.account.address]);
    const [cases, withMajority, strikes, suspended] = await read<any[]>(REGISTRY, registryAbi, "profile", [n]);
    log(`👩‍⚖️ arbitrator ${i + 1}: fee share ${formatUnits(gained > 0n ? gained : 0n, 6)} USDC · record ${withMajority}/${cases} with majority · strikes ${strikes}${suspended ? " · SUSPENDED" : ""}`);
  }
}
log(`📜 transcript: http://localhost:3000/api/court/${caseId}`);
log("✅ full flow done — only people's actions were scripted");
