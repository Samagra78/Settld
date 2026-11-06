// Full dispute flow on Arc testnet. This script only does what PEOPLE do:
//   client proposes + funds, freelancer accepts + submits, client disputes.
// Everything else must happen by itself (server watcher + keeper, Chainlink CRE workflows):
//   WF0 certifies → WF1 verifies the link → WF3 AI court debates round by round → keeper closes the case,
//   finalizes after the appeal window, and pays the split.
// Usage (from scripts/, with the server running and AUTOMATION_ENABLED=true):  bun run e2e-dispute

import { readFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, defineChain, formatUnits, http, parseAbi, parseEventLogs, parseUnits,
  type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const shared = JSON.parse(readFileSync(new URL("../shared/addresses.json", import.meta.url), "utf8"));
const load = (n: string) => {
  const f = JSON.parse(readFileSync(new URL(`../shared/abi/${n}.json`, import.meta.url), "utf8"));
  return (Array.isArray(f) ? f : f.abi) as Abi;
};
const escrowAbi = load("ClauseEscrow"), courtAbi = load("AICourt");
const ESCROW = shared.clauseEscrow.address as Address, COURT = shared.aiCourt.address as Address;
const USDC = shared.usdc as Address;
const chain = defineChain({ id: shared.chainId, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [shared.rpc] } } });
const pub = createPublicClient({ chain, transport: http() });
const client = createWalletClient({ account: privateKeyToAccount(process.env.BRAND_PRIVATE_KEY as Hex), chain, transport: http() });
const freelancer = createWalletClient({ account: privateKeyToAccount(process.env.TESTER_PRIVATE_KEY as Hex), chain, transport: http() });
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
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
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`timed out waiting for: ${what}`);
};
const clause = async (dealId: bigint) => (await read<any[]>(ESCROW, escrowAbi, "getClauses", [dealId]))[0];

// 1. client proposes a 1-clause deal: "landing page with logo + signup form", checked by URL_LIVE (4)
const now = Math.floor(Date.now() / 1000);
const terms = [{ kind: 0, checkType: 4, param: "", deadline: BigInt(now + 3 * 86400), amount: AMOUNT, dependsOn: 255, onFail: 0, vestDays: 0 }];
log(`escrow ${ESCROW} · court ${COURT}`);
const proposed = await send(client, ESCROW, escrowAbi, "proposeDeal", [freelancer.account.address, AMOUNT, terms], "client proposes deal");
const dealId = (parseEventLogs({ abi: escrowAbi, logs: proposed.logs, eventName: "DealProposed" })[0] as any).args.dealId as bigint;
log(`deal ${dealId}`);

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

// 6. nobody appeals → keeper finalizes after the window and pays the split
const before = { f: await read<bigint>(USDC, erc20, "balanceOf", [freelancer.account.address]), c: await read<bigint>(USDC, erc20, "balanceOf", [client.account.address]) };
const settled = await waitFor("keeper settles the split", async () => {
  const s = Number((await clause(dealId)).status);
  return s === 5 || s === 6 ? s : undefined;
}, 420);
const after = { f: await read<bigint>(USDC, erc20, "balanceOf", [freelancer.account.address]), c: await read<bigint>(USDC, erc20, "balanceOf", [client.account.address]) };
log(`💸 settled (${STATUS[settled]}): freelancer +${formatUnits(after.f - before.f, 6)} USDC, client +${formatUnits(after.c - before.c, 6)} USDC`);
log(`📜 transcript: http://localhost:3000/api/court/${caseId}`);
log("✅ full flow done — only people's actions were scripted");
