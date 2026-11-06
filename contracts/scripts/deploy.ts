// Deploys ClauseEscrow to Arc testnet.
//   DEPLOYER_PRIVATE_KEY=0x... [FORWARDER=0x...] npx hardhat run scripts/deploy.ts --network arcTestnet
// The deployer pays gas in USDC (faucet.circle.com) and becomes the owner (can change the forwarder).
import hre from "hardhat";
import { isAddress } from "viem";

const USDC = "0x3600000000000000000000000000000000000000";
const MOCK_FORWARDER = "0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1";

async function main() {
  const forwarder = process.env.FORWARDER ?? MOCK_FORWARDER;
  if (!isAddress(forwarder)) throw new Error(`FORWARDER is not an address: ${forwarder}`);

  const [deployer] = await hre.viem.getWalletClients();
  if (!deployer) throw new Error("Set DEPLOYER_PRIVATE_KEY");
  console.log("deployer :", deployer.account.address);
  console.log("forwarder:", forwarder);
  console.log("usdc     :", USDC);

  const escrow = await hre.viem.deployContract("ClauseEscrow", [forwarder, USDC]);
  console.log("\nClauseEscrow deployed:", escrow.address);
  console.log("explorer: https://testnet.arcscan.app/address/" + escrow.address);
  console.log("\nNext: set ESCROW_ADDRESS in server/.env and tell Mehak + Purva.");
}

main().catch((e) => { console.error(e); process.exit(1); });
