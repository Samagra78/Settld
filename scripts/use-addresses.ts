// After a deploy: copy the contract addresses from shared/addresses.json into every CRE workflow config.
// Usage (from scripts/):  bun run use-addresses
//
// Reads:  clauseEscrow.address, aiCourt.address (optional, until AICourt is deployed)
// Writes: cre/wf0-certify, cre/wf1-verify → escrowAddress
//         cre/wf3-court                    → escrowAddress + courtAddress

import { readFileSync, writeFileSync } from "node:fs";
import { isAddress } from "viem";

const root = new URL("../", import.meta.url);
const shared = JSON.parse(readFileSync(new URL("shared/addresses.json", root), "utf8"));
const escrow: string | undefined = shared.clauseEscrow?.address;
const court: string | undefined = shared.aiCourt?.address;
if (!escrow || !isAddress(escrow)) throw new Error("shared/addresses.json has no valid clauseEscrow.address");

const files = ["wf0-certify", "wf1-verify", "wf3-court"].flatMap((wf) =>
  ["staging", "production"].map((t) => `cre/${wf}/config.${t}.json`)
);

for (const f of files) {
  const url = new URL(f, root);
  const cfg = JSON.parse(readFileSync(url, "utf8"));
  const before = JSON.stringify(cfg);
  cfg.escrowAddress = escrow;
  if (f.includes("wf3-court")) {
    if (court && isAddress(court)) cfg.courtAddress = court;
    else console.log(`⚠️  ${f}: aiCourt.address not in shared/addresses.json yet — courtAddress left as ${cfg.courtAddress}`);
  }
  if (JSON.stringify(cfg) !== before) {
    writeFileSync(url, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`✅ ${f}`);
  } else console.log(`·  ${f} (already up to date)`);
}
console.log(`escrow ${escrow}${court ? `, court ${court}` : ""}. Restart the server so the watcher uses them too.`);
