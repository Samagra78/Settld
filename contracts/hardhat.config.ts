import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: { hardhat: { initialDate: "2026-10-01T00:00:00Z" } },
  paths: { sources: "./src", tests: "./test" },
};

export default config;
