// Settle a deal: release every Verified clause whose dispute window has passed (and whose
// dependency is released), refund every Failed clause (and cascade refunds).
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
  rpcUrls: { default: { http: [shared.rpc] } },
});
const pub = createPublicClient({ chain, transport: http() });
// any funded wallet can settle; the money still only goes to the creator or the brand
const keeper = createWalletClient({ account: privateKeyToAccount(process.env.BRAND_PRIVATE_KEY as Hex), chain, transport: http() });

const NAMES = ["Pending", "Submitted", "Verified", "Failed", "Disputed", "Released", "Refunded"];
const VERIFIED = 2, FAILED = 3, RELEASED = 5, REFUNDED = 6, NO_DEP = 255;
const read = (fn: string, args: unknown[]) => pub.readContract({ address: ESCROW, abi, functionName: fn, args }) as Promise<any>;
const window = BigInt(await read("RELEASE_WINDOW", []));

for (let round = 0; round < 10; round++) {
  const clauses = (await read("getClauses", [dealId])) as any[];
  const now = (await pub.getBlock()).timestamp;
  let acted = false, waitFor = 0n;

  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    const dep = c.dependsOn === NO_DEP ? undefined : clauses[c.dependsOn];
    let fn: "release" | "refund" | undefined;

    if (c.status === VERIFIED) {
      const at = BigInt(c.verifiedAt) + window;
      if (now < at) { waitFor = waitFor > at - now ? waitFor : at - now; continue; }
      if (dep && dep.status !== RELEASED) continue;
      fn = "release";
    } else if (c.status === FAILED || (dep?.status === REFUNDED && c.status !== RELEASED && c.status !== REFUNDED)) {
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
