// Writes the ClauseEscrow ABI to ../shared/abi/ for CRE and the client.
const fs = require("fs");
const path = require("path");
const art = require("./artifacts/src/ClauseEscrow.sol/ClauseEscrow.json");
const out = path.join(__dirname, "..", "shared", "abi", "ClauseEscrow.reference.json");
fs.writeFileSync(out, JSON.stringify(art.abi, null, 2) + "\n");
console.log("wrote", out, `(${art.abi.length} entries)`);
