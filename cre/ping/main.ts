// S2 — Ping workflow
// Proves the hardest connection in Settld: Chainlink CRE → Arc testnet → website.
// On each cron tick it sends ONE number to Samagra's Ping contract.
// Ping decodes the report as abi.encode(uint256) and stores it in lastNumber().

import {
  bytesToHex,
  CronCapability,
  EVMClient,
  getNetwork,
  handler,
  hexToBase64,
  Runner,
  TxStatus,
  type Runtime,
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, parseAbiParameters } from "viem";

export type Config = {
  schedule: string;
  chainSelectorName: string; // "arc-testnet"
  pingAddress: string;       // Ping contract on Arc
  number: string;            // the number to send (string so JSON can hold big values)
  gasLimit: string;
};

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const { config } = runtime;

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
  });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evmClient = new EVMClient(network.chainSelector.selector);

  // Ping expects exactly abi.encode(uint256)
  const payload = encodeAbiParameters(parseAbiParameters("uint256"), [BigInt(config.number)]);

  // The DON signs the payload...
  const report = runtime
    .report({
      encodedPayload: hexToBase64(payload),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  // ...and delivers it through the forwarder to Ping.onReport()
  const write = evmClient
    .writeReport(runtime, {
      receiver: config.pingAddress,
      report,
      gasConfig: { gasLimit: config.gasLimit },
    })
    .result();

  if (write.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Ping write failed, status ${write.txStatus}`);
  }
  const txHash = bytesToHex(write.txHash || new Uint8Array(32));
  runtime.log(`Sent ${config.number} to Ping ${config.pingAddress} — tx ${txHash}`);
  return txHash;
};

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
