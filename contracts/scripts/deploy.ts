// Deploys the Settld V2 contracts to Arc testnet and links them:
//   ClauseEscrow(forwarder, usdc, owner) → AICourt(forwarder, usdc, escrow, owner) → JurorRegistry(attester, owner)
//   then escrow.setCourt(court), court.setJury(registry), registry.setCourt(court)  (owner, one-time)
// Writes the result to ../shared/deployments/arc-testnet-v2.json (addresses + deploy txs).
//
//   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.ts --network arcTestnet
// The deployer pays gas in USDC and must be the OWNER (it sends the wiring calls).
import fs from "node:fs";
import path from "node:path";
import hre from "hardhat";
import { getAddress, isAddress, type Address } from "viem";

const USDC = "0x3600000000000000000000000000000000000000";
const MOCK_FORWARDER = "0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1";
const ATTESTER = process.env.ATTESTER_ADDRESS ?? "0xDC930A8Fa2A3AE6820A30f2FF57863AaF772a861";

async function main() {
  const forwarder = process.env.FORWARDER ?? MOCK_FORWARDER;
  for (const [n, a] of [["FORWARDER", forwarder], ["ATTESTER_ADDRESS", ATTESTER]]) {
    if (!isAddress(a)) throw new Error(`${n} is not an address: ${a}`);
  }
  const [deployer] = await hre.viem.getWalletClients();
  if (!deployer) throw new Error("Set DEPLOYER_PRIVATE_KEY");
  const pub = await hre.viem.getPublicClient();
  const owner = deployer.account.address;
  console.log(`deployer/owner ${owner} · forwarder ${forwarder} · attester ${ATTESTER}`);

  const deploy = async (name: string, args: unknown[]) => {
    const { contract, deploymentTransaction } = await hre.viem.sendDeploymentTransaction(name, args as never);
    await pub.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
    console.log(`✅ ${name.padEnd(13)} ${contract.address}  tx ${deploymentTransaction.hash}`);
    return { contract, tx: deploymentTransaction.hash };
  };

  const escrow = await deploy("ClauseEscrow", [forwarder, USDC, owner]);
  const court = await deploy("AICourt", [forwarder, USDC, escrow.contract.address, owner]);
  const registry = await deploy("JurorRegistry", [ATTESTER, owner]);

  const wire = async (label: string, send: () => Promise<`0x${string}`>) => {
    const hash = await send();
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} failed: ${hash}`);
    console.log(`🔗 ${label}  tx ${hash}`);
  };
  await wire("escrow.setCourt(court)", () => (escrow.contract as any).write.setCourt([court.contract.address]));
  await wire("court.setJury(registry)", () => (court.contract as any).write.setJury([registry.contract.address]));
  await wire("registry.setCourt(court)", () => (registry.contract as any).write.setCourt([court.contract.address]));

  const entry = (address: Address, deployTx: string) => ({
    address: getAddress(address), deployTx, builtIn: "Arc Studio (source); deployed with Hardhat", forwarder, owner,
  });
  const out = {
    chainId: 5042002,
    deployedAt: new Date().toISOString(),
    clauseEscrow: entry(escrow.contract.address, escrow.tx),
    aiCourt: entry(court.contract.address, court.tx),
    jurorRegistry: { ...entry(registry.contract.address, registry.tx), attester: ATTESTER },
  };
  const file = path.join(__dirname, "..", "..", "shared", "deployments", "arc-testnet-v2.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nwrote ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
