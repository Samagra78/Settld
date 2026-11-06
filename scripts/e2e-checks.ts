// WF1 checks, live on Arc: one deal, three clauses, each verified a different way by Chainlink WF1:
//   C0  page contains text   (5)  https://example.com must contain "documentation examples"
//   C1  GitHub PR merged     (6)  https://github.com/vitejs/vite/pull/100 merged into vitejs/vite
//   C2  AI check (3 models)  (7)  https://example.com judged against written criteria
// Only people's actions are scripted (propose, accept, fund, submit). Certify, verify and payout are automatic.
// Usage (from scripts/, server running with AUTOMATION_ENABLED=true):  bun run e2e-checks

import { readFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, defineChain, formatUnits, http, parseAbi, parseEventLogs, parseUnits,
  type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const shared = JSON.parse(readFileSync(new URL("../shared/addresses.json", import.meta.url), "utf8"));
const abiFile = JSON.parse(readFileSync(new URL("../shared/abi/ClauseEscrow.json", import.meta.url), "utf8"));
const abi = (Array.isArray(abiFile) ? abiFile : abiFile.abi) as Abi;
const ESCROW = shared.clauseEscrow.address as Address, USDC = shared.usdc as Address;
const chain = defineChain({ id: shared.chainId, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [process.env.ARC_RPC_URL || shared.rpc] } } });
const t = http(undefined, { retryCount: 8, retryDelay: 1500 });
const pub = createPublicClient({ chain, transport: t });
const client = createWalletClient({ account: privateKeyToAccount(process.env.BRAND_PRIVATE_KEY as Hex), chain, transport: t });
const freelancer = createWalletClient({ account: privateKeyToAccount(process.env.TESTER_PRIVATE_KEY as Hex), chain, transport: t });
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const STATUS = ["Pending", "Submitted", "Verified", "Failed", "Disputed", "Released", "Refunded"];

const t0 = Date.now();
const log = (m: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${m}`);
const send = async (w: typeof client, address: Address, a: Abi, functionName: string, args: unknown[], label: string) => {
  const hash = await w.writeContract({ address, abi: a, functionName, args } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  log(`👤 ${label} — ${shared.explorer}/tx/${hash}`);
  return r;
};
const clauses = (dealId: bigint) => pub.readContract({ address: ESCROW, abi, functionName: "getClauses", args: [dealId] }) as Promise<any[]>;
const waitFor = async <T>(what: string, check: () => Promise<T | undefined>, s: number): Promise<T> => {
  const end = Date.now() + s * 1000;
  while (Date.now() < end) {
    const v = await check().catch(() => undefined);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`timed out waiting for: ${what}`);
};

const EACH = parseUnits("0.1", 6);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3 * 86400);
const cases = [
  { checkType: 5, param: "documentation examples", evidence: "https://example.com", label: "page contains text" },
  { checkType: 6, param: "vitejs/vite", evidence: "https://github.com/vitejs/vite/pull/100", label: "GitHub PR merged" },
  { checkType: 7, param: "A simple placeholder web page that says the domain is meant for use in documentation examples", evidence: "https://example.com", label: "AI check (3 models)" },
];
const terms = cases.map((c) => ({ kind: 0, checkType: c.checkType, param: c.param, deadline, amount: EACH, dependsOn: 255, onFail: 0, vestDays: 0 }));
const total = EACH * BigInt(cases.length);

const proposed = await send(client, ESCROW, abi, "proposeDeal", [freelancer.account.address, total, terms], "client proposes a 3-clause deal");
const dealId = (parseEventLogs({ abi, logs: proposed.logs, eventName: "DealProposed" })[0] as any).args.dealId as bigint;
log(`deal ${dealId}`);
await send(freelancer, ESCROW, abi, "acceptDeal", [dealId], "freelancer accepts");
await waitFor("WF0 certification", async () => ((await pub.readContract({ address: ESCROW, abi, functionName: "certified", args: [dealId] })) ? true : undefined), 300);
log("🤖 Chainlink certified the deal");
await send(client, USDC, erc20, "approve", [ESCROW, total], "client approves USDC");
await send(client, ESCROW, abi, "fundDeal", [dealId], `client funds ${formatUnits(total, 6)} USDC`);
for (const [i, c] of cases.entries()) await send(freelancer, ESCROW, abi, "submitEvidence", [dealId, i, c.evidence], `freelancer submits clause ${i} (${c.label}): ${c.evidence}`);

const verdicts = await waitFor("all three WF1 verdicts", async () => {
  const cl = await clauses(dealId);
  return cl.every((c) => Number(c.status) >= 2) ? cl.map((c) => Number(c.status)) : undefined;
}, 600);
verdicts.forEach((s, i) => log(`🤖 WF1 clause ${i} — ${cases[i].label}: ${STATUS[s]}`));

const before = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [freelancer.account.address] });
const done = await waitFor("keeper payouts", async () => {
  const cl = await clauses(dealId);
  return cl.every((c) => Number(c.status) >= 5) ? cl.map((c) => Number(c.status)) : undefined;
}, 420);
const after = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [freelancer.account.address] });
done.forEach((s, i) => log(`💸 clause ${i}: ${STATUS[s]}`));
log(`freelancer received ${formatUnits(after - before, 6)} USDC · story: http://localhost:3000/monitor (deal #${dealId})`);
log(verdicts.every((s) => s === 2) ? "✅ all three WF1 checks passed live" : "⚠️ not every check passed — see the monitor for Chainlink's reason");
