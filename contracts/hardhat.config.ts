import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: { initialDate: "2026-10-01T00:00:00Z" },
    // Deploy with: DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.ts --network arcTestnet
    arcTestnet: {
      url: process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network",
      chainId: 5042002,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  paths: { sources: "./src", tests: "./test" },
};

export default config;
