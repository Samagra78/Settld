// S3 smoke test — checks the escrow end to end, without the website.
// Uses plain TEST wallets (scripts/.env) because the app's Circle user-controlled
// wallets need a human PIN. Run:  bun run smoke   (from scripts/)
//
// Flow: brand approves 1 USDC → brand funds the escrow (creator = tester wallet)
//       → tester tries to release (must FAIL) → brand releases → creator balance goes up.

import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ---------- config ----------
const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
});

const addrFile = new URL("../shared/addresses.json", import.meta.url);
const shared = existsSync(addrFile) ? JSON.parse(readFileSync(addrFile, "utf8")) : {};
const ESCROW = (shared.escrow ?? "0x500dbfb5073d696a9a9c3d7f8c251c68e01f73fa") as Address;
const USDC = (shared.usdc ?? "0x3600000000000000000000000000000000000000") as Address;
const AMOUNT = parseUnits("1", 6); // 1 USDC (ERC-20 interface uses 6 decimals)

const brandKey = process.env.BRAND_PRIVATE_KEY as Hex | undefined;
const testerKey = process.env.TESTER_PRIVATE_KEY as Hex | undefined;
if (!brandKey || !testerKey) {
  console.error("Missing BRAND_PRIVATE_KEY / TESTER_PRIVATE_KEY in scripts/.env");
  process.exit(1);
}
const brand = privateKeyToAccount(brandKey);
const tester = privateKeyToAccount(testerKey);

const usdcAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);
const escrowAbi = parseAbi([
  "function fund(address creator, uint256 amount) returns (uint256 id)",
  "function release(uint256 id)",
]);

const pub = createPublicClient({ chain: arc, transport: http() });
const brandWallet = createWalletClient({ account: brand, chain: arc, transport: http() });

// ---------- tiny test runner ----------
let failures = 0;
async function stage(name: string, fn: () => Promise<string | void>) {
  // each stage depends on the previous one — stop at the first failure
  if (failures > 0) {
    console.log(`⏭️  ${name} — skipped (earlier stage failed)`);
    return;
  }
  try {
    const note = await fn();
    console.log(`✅ ${name}${note ? ` — ${note}` : ""}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${name} — ${(e as Error).message.split("\n")[0]}`);
  }
}
const usdc = (a: Address) =>
  pub.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [a] });
const explorer = (tx: Hex) => `https://explorer.testnet.arc.io/tx/${tx}`;

// ---------- run ----------
console.log(`Escrow ${ESCROW}\nBrand  ${brand.address}\nTester ${tester.address} (acts as creator)\n`);

let dealId = 0n;
let creatorBefore = 0n;

await stage("brand has at least 1 USDC", async () => {
  const bal = await usdc(brand.address);
  if (bal < AMOUNT) throw new Error(`brand has ${formatUnits(bal, 6)} USDC — fund it at faucet.circle.com`);
  return `${formatUnits(bal, 6)} USDC`;
});

await stage("brand approves escrow to take 1 USDC", async () => {
  const hash = await brandWallet.writeContract({
    address: USDC, abi: usdcAbi, functionName: "approve", args: [ESCROW, AMOUNT],
  });
  await pub.waitForTransactionReceipt({ hash });
  const allowance = await pub.readContract({
    address: USDC, abi: usdcAbi, functionName: "allowance", args: [brand.address, ESCROW],
  });
  if (allowance < AMOUNT) throw new Error("allowance not set");
  return explorer(hash);
});

await stage("brand funds 1 USDC for the creator", async () => {
  creatorBefore = await usdc(tester.address);
  const { result, request } = await pub.simulateContract({
    account: brand, address: ESCROW, abi: escrowAbi, functionName: "fund",
    args: [tester.address, AMOUNT],
  });
  dealId = result;
  const hash = await brandWallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("fund reverted");
  return `escrow id ${dealId} — ${explorer(hash)}`;
});

await stage("release by NON-brand (tester) is refused", async () => {
  try {
    await pub.simulateContract({
      account: tester, address: ESCROW, abi: escrowAbi, functionName: "release", args: [dealId],
    });
  } catch {
    return "reverted as expected";
  }
  throw new Error("tester was able to release — access control is broken");
});

await stage("brand releases", async () => {
  const hash = await brandWallet.writeContract({
    address: ESCROW, abi: escrowAbi, functionName: "release", args: [dealId],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("release reverted");
  return explorer(hash);
});

await stage("creator balance went up by 1 USDC", async () => {
  const after = await usdc(tester.address);
  if (after - creatorBefore !== AMOUNT) {
    throw new Error(`expected +1 USDC, got +${formatUnits(after - creatorBefore, 6)}`);
  }
  return `${formatUnits(creatorBefore, 6)} → ${formatUnits(after, 6)} USDC`;
});

await stage("second release is refused (pays once only)", async () => {
  try {
    await pub.simulateContract({
      account: brand, address: ESCROW, abi: escrowAbi, functionName: "release", args: [dealId],
    });
  } catch {
    return "reverted as expected";
  }
  throw new Error("released twice — double payment possible");
});

console.log(failures === 0 ? "\nALL ✅" : `\n${failures} stage(s) ❌`);
process.exit(failures === 0 ? 0 : 1);
