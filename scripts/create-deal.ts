// Creates a test deal on the deployed ClauseEscrow so WF0 has something to certify.
// Brand (smoke brand wallet) proposes, creator (smoke tester wallet) accepts.
// Usage (from scripts/):  bun run create-deal          → 2-clause deal, C1 depends on C0
//                         bun run create-deal broken   → C1 depends on a LATER clause
//                                                         (contract rejects it, shown as a check)

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const shared = JSON.parse(readFileSync(new URL("../shared/addresses.json", import.meta.url), "utf8"));
const abiFile = JSON.parse(readFileSync(new URL("../shared/abi/ClauseEscrow.json", import.meta.url), "utf8"));
const abi = (Array.isArray(abiFile) ? abiFile : abiFile.abi) as Abi;
const ESCROW = shared.clauseEscrow.address as Address;

const arc = defineChain({
  id: shared.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [shared.rpc] } },
});

const brand = privateKeyToAccount(process.env.BRAND_PRIVATE_KEY as Hex);
const creator = privateKeyToAccount(process.env.TESTER_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain: arc, transport: http() });
const brandW = createWalletClient({ account: brand, chain: arc, transport: http() });
const creatorW = createWalletClient({ account: creator, chain: arc, transport: http() });

const deadline = BigInt(Math.floor(Date.now() / 1000) + 3 * 24 * 3600); // 3 days from now
const usdc = (n: string) => parseUnits(n, 6);

const broken = process.argv[2] === "broken";
const terms = [
  { kind: 0, checkType: 0, param: "", deadline, amount: usdc("0.6"), dependsOn: broken ? 1 : 255, onFail: 0, vestDays: 0 },
  { kind: 0, checkType: 1, param: "#TravelCoPartner", deadline, amount: usdc("0.4"), dependsOn: broken ? 255 : 0, onFail: 0, vestDays: 0 },
];
const total = usdc("1");

console.log(`ClauseEscrow ${ESCROW}\nBrand   ${brand.address}\nCreator ${creator.address}\n`);

try {
  const { request } = await pub.simulateContract({
    account: brand, address: ESCROW, abi, functionName: "proposeDeal",
    args: [creator.address, total, terms],
  });
  const proposeTx = await brandW.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash: proposeTx });
  const [ev] = parseEventLogs({ abi, logs: receipt.logs, eventName: "DealProposed" }) as any[];
  const dealId = ev.args.dealId as bigint;
  console.log(`✅ proposed deal ${dealId} — specHash ${ev.args.specHash}`);
  console.log(`   ${shared.explorer}/tx/${proposeTx}`);

  const acceptTx = await creatorW.writeContract({
    address: ESCROW, abi, functionName: "acceptDeal", args: [dealId],
  });
  await pub.waitForTransactionReceipt({ hash: acceptTx });
  console.log(`✅ creator accepted deal ${dealId} — tx ${acceptTx}`);
  console.log(`\nWF0 certifies automatically on DealAccepted. Simulate that trigger (from cre/):`);
  console.log(`  cre workflow simulate wf0-certify --target staging-settings --non-interactive --trigger-index 1 --evm-tx-hash ${acceptTx} --evm-event-index 0 --broadcast`);
} catch (e) {
  console.log(`❌ ${(e as Error).message.split("\n").slice(0, 2).join(" ")}`);
  if (broken) console.log("   (expected: the contract only allows depending on an EARLIER clause)");
  process.exit(broken ? 0 : 1);
}
