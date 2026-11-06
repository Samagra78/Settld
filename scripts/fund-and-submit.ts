// Funds a certified deal (brand) and submits a YouTube video for a clause (creator),
// so WF1 has a ClauseSubmitted event to verify.
// Usage (from scripts/):  bun run fund-and-submit <dealId> <clauseId> <youtubeVideoId>
//   Funds the deal first if it isn't funded yet, then submits the video.

import { readFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, defineChain, http, parseAbi, type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const [dealArg, clauseArg, videoId] = process.argv.slice(2);
if (!dealArg || clauseArg === undefined || !videoId) {
  console.error("Usage: bun run fund-and-submit <dealId> <clauseId> <youtubeVideoId>");
  process.exit(1);
}
const dealId = BigInt(dealArg);
const clauseId = Number(clauseArg);

const shared = JSON.parse(readFileSync(new URL("../shared/addresses.json", import.meta.url), "utf8"));
const abiFile = JSON.parse(readFileSync(new URL("../shared/abi/ClauseEscrow.json", import.meta.url), "utf8"));
const abi = (Array.isArray(abiFile) ? abiFile : abiFile.abi) as Abi;
const ESCROW = shared.clauseEscrow.address as Address;
const USDC = shared.usdc as Address;

const arc = defineChain({
  id: shared.chainId, name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || shared.rpc] } },
});
const brand = privateKeyToAccount(process.env.BRAND_PRIVATE_KEY as Hex);
const creator = privateKeyToAccount(process.env.TESTER_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain: arc, transport: http() });
const brandW = createWalletClient({ account: brand, chain: arc, transport: http() });
const creatorW = createWalletClient({ account: creator, chain: arc, transport: http() });
const usdcAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

const deal = (await pub.readContract({ address: ESCROW, abi, functionName: "getDeal", args: [dealId] })) as any;
const certified = (await pub.readContract({ address: ESCROW, abi, functionName: "certified", args: [dealId] })) as boolean;
console.log(`Deal ${dealId}: accepted=${deal.accepted} certified=${certified} funded=${deal.funded} total=${deal.total}`);

if (!deal.funded) {
  if (!certified) { console.log("❌ not certified yet — run WF0 first"); process.exit(1); }
  const a = await brandW.writeContract({ address: USDC, abi: usdcAbi, functionName: "approve", args: [ESCROW, deal.total] });
  await pub.waitForTransactionReceipt({ hash: a });
  const f = await brandW.writeContract({ address: ESCROW, abi, functionName: "fundDeal", args: [dealId] });
  await pub.waitForTransactionReceipt({ hash: f });
  console.log(`✅ brand funded deal ${dealId} — ${shared.explorer}/tx/${f}`);
}

const s = await creatorW.writeContract({
  address: ESCROW, abi, functionName: "submitEvidence", args: [dealId, clauseId, videoId],
});
const r = await pub.waitForTransactionReceipt({ hash: s });
if (r.status !== "success") { console.log("❌ submitEvidence reverted"); process.exit(1); }
console.log(`✅ creator submitted video "${videoId}" for clause ${clauseId} — tx ${s}`);
console.log(`\nWF1 verifies automatically on ClauseSubmitted. Simulate that trigger (from cre/):`);
console.log(`  cre workflow simulate wf1-verify --target staging-settings --non-interactive --trigger-index 0 --evm-tx-hash ${s} --evm-event-index 0 --broadcast`);
