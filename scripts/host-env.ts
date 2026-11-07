// Writes every backend setting into .env.deploy (git-ignored) for one paste into the host's environment editor.
// Combines server/.env and cre/.env and adds the production switches. Values are never printed.
// Usage (from scripts/):  bun run host-env
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const read = (p: string) => (existsSync(new URL(p, import.meta.url)) ? readFileSync(new URL(p, import.meta.url), "utf8") : "");
const pairs = new Map<string, string>();
for (const text of [read("../server/.env"), read("../cre/.env")]) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2].trim() !== "") pairs.set(m[1], m[2].trim());
  }
}
// Hosted server = API + database only. The automation (Chainlink workflows via the cre CLI) runs on the laptop that
// is logged in to CRE, writing to the same MongoDB. Set HOST_AUTOMATION=true only if the host has CRE_API_KEY.
const hostAutomation = process.env.HOST_AUTOMATION === "true";
for (const [k, v] of Object.entries({ NODE_ENV: "production", AUTOMATION_ENABLED: hostAutomation ? "true" : "false", MONITOR_PUBLIC: "true", PORT: "3000" })) pairs.set(k, v);
for (const k of ["CRE_ETH_PRIVATE_KEY", "KEEPER_PRIVATE_KEY"]) if (!hostAutomation) pairs.delete(k); // not needed on the host
const missing = ["MONGODB_URI", ...(hostAutomation ? ["CRE_API_KEY"] : [])].filter((k) => !pairs.get(k)?.startsWith(k === "MONGODB_URI" ? "mongodb" : ""));
writeFileSync(new URL("../.env.deploy", import.meta.url), [...pairs].map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
console.log(`wrote .env.deploy with ${pairs.size} settings (values not shown)`);
if (missing.length) console.log(`still missing: ${missing.join(", ")} — add them to server/.env and run again`);
