// Settle a deal: release every Verified clause whose dispute window has passed (and whose
// dependency is released), refund every Failed clause (and cascade refunds).
// V2 escrow (detected from the ABI): Failed refunds also wait for the window, and Disputed
// clauses are settled with resolveDispute once the court's verdict is final.
// release()/refund() can be called by anyone — this is the basis of the automatic keeper.
// Usage (from scripts/):  bun run settle <dealId>

import { readFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, defineChain, formatUnits, http, type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const dealId = BigInt(process.argv[2] ?? NaN);
const shared = JSON.parse(readFileSync(new URL("../shared/addresses.json", import.meta.url), "utf8"));
const abiFile = JSON.parse(readFileSync(new URL("../shared/abi/ClauseEscrow.json", import.meta.url), "utf8"));
const abi = (Array.isArray(abiFile) ? abiFile : abiFile.abi) as Abi;
const ESCROW = shared.clauseEscrow.address as Address;
const chain = defineChain({
  id: shared.chainId, name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || shared.rpc] } },
});
const pub = createPublicClient({ chain, transport: http() });
// any funded wallet can settle; the money still only goes to the creator or the brand
const keeper = createWalletClient({ account: privateKeyToAccount(process.env.BRAND_PRIVATE_KEY as Hex), chain, transport: http() });

const NAMES = ["Pending", "Submitted", "Verified", "Failed", "Disputed", "Released", "Refunded"];
const VERIFIED = 2, FAILED = 3, DISPUTED = 4, RELEASED = 5, REFUNDED = 6, NO_DEP = 255;
const read = (fn: string, args: unknown[]) => pub.readContract({ address: ESCROW, abi, functionName: fn, args }) as Promise<any>;
const window = BigInt(await read("RELEASE_WINDOW", []));
// V2 escrow: refunds also wait for the dispute window, and disputed clauses settle via the court
const hasFn = (name: string) => abi.some((e: any) => e.type === "function" && e.name === name);
const V2 = hasFn("disputeWindowEnd");
const windowEnd = async (i: number, c: any): Promise<bigint> =>
  V2 ? BigInt(await read("disputeWindowEnd", [dealId, i])) : BigInt(c.verifiedAt) + window;

for (let round = 0; round < 10; round++) {
  const clauses = (await read("getClauses", [dealId])) as any[];
  const now = (await pub.getBlock()).timestamp;
  let acted = false, waitFor = 0n;

  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    const dep = c.dependsOn === NO_DEP ? undefined : clauses[c.dependsOn];
    let fn: "release" | "refund" | "resolveDispute" | undefined;
    const cascade = dep?.status === REFUNDED && c.status !== RELEASED && c.status !== REFUNDED;

    if (c.status === VERIFIED || (c.status === FAILED && V2 && !cascade)) {
      const at = await windowEnd(i, c);
      if (now <= at) { waitFor = waitFor > at - now ? waitFor : at - now; continue; }
      if (c.status === VERIFIED) {
        if (dep && dep.status !== RELEASED) continue;
        fn = "release";
      } else fn = "refund";
    } else if (c.status === DISPUTED && V2 && !cascade) {
      // only once the court's verdict is final; a revert here just means "not yet"
      try {
        await pub.simulateContract({ address: ESCROW, abi, functionName: "resolveDispute", args: [dealId, i], account: keeper.account });
        fn = "resolveDispute";
      } catch { continue; }
    } else if (c.status === FAILED || cascade) {
      fn = "refund";
    }
    if (!fn) continue;

    const hash = await keeper.writeContract({ address: ESCROW, abi, functionName: fn, args: [dealId, i] });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`✅ ${fn} clause ${i} (${formatUnits(c.amount, 6)} USDC) — ${shared.explorer}/tx/${hash}`);
    acted = true;
  }

  if (!acted && waitFor === 0n) break;
  if (!acted) {
    console.log(`⏳ dispute window still open — waiting ${waitFor}s`);
    await new Promise((r) => setTimeout(r, Number(waitFor + 2n) * 1000));
  }
}

const final = (await read("getClauses", [dealId])) as any[];
final.forEach((c, i) => console.log(`clause ${i}: ${NAMES[c.status]}`));
