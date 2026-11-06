// Runs WF1's YouTube checks against live YouTube outside CRE (a sync curl stands in for the CRE HTTP client).
// Usage (from cre/): npx tsx wf1-verify/channel-check.test.ts   — reads YOUTUBE_API_KEY_ALL from cre/.env
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkEvidence, expectedChannel } from "./main";

const env = Object.fromEntries(readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)
  .filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const sr = { sendRequest: ({ url }: { url: string }) => ({ result: () => {
  const out = execFileSync("curl", ["-s", "-w", "\n%{http_code}", url], { encoding: "utf8" });
  const i = out.lastIndexOf("\n");
  return { statusCode: Number(out.slice(i + 1)), body: new TextEncoder().encode(out.slice(0, i)) };
} }) } as never;

const far = BigInt(Math.floor(Date.now() / 1000) + 86400);
const cases: [string, string, boolean][] = [
  ["@roti.sounds", "https://www.youtube.com/watch?v=g8WHzW4RCe4", true],                 // deal 14's video, right channel
  ["https://www.youtube.com/@roti.sounds", "g8WHzW4RCe4", true],                         // channel link form
  ["@RickAstleyYT", "https://www.youtube.com/watch?v=g8WHzW4RCe4", false],               // someone else's video
  ["", "https://www.youtube.com/watch?v=g8WHzW4RCe4", false],                            // no channel named
  ["@RickAstleyYT", "https://youtu.be/dQw4w9WgXcQ", true],
  ["UCuAXFkgsw1L7xaCfnd5JJOw", "dQw4w9WgXcQ", true],                                     // channel id
  ["https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw", "dQw4w9WgXcQ", true],
  ["Rick Astley", "dQw4w9WgXcQ", true],                                                  // exact channel name
  ["Rick", "dQw4w9WgXcQ", false],                                                        // partial name is not enough
];
let bad = 0;
for (const keyName of ["with API key", "oEmbed (no key)"]) {
  const key = keyName === "with API key" ? env.YOUTUBE_API_KEY_ALL ?? "" : "";
  if (keyName === "with API key" && !key) { console.log("skip: no YOUTUBE_API_KEY_ALL"); continue; }
  for (const [param, ev, want] of cases) {
    const v = JSON.parse(checkEvidence(sr, ev, 0, param, far, { youtube: key, groq: "", gemini: "", nvidia: "", github: "" }, false, {}));
    // without a key, channel ids can't be checked: a FAIL there is the expected, safe outcome
    const expect = !key && expectedChannel(param).id ? false : want;
    const ok = v.pass === expect;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} [${keyName}] ${JSON.stringify(param)} -> ${v.pass ? "PASS" : "fail"}: ${v.detail}`);
  }
}
const late = JSON.parse(checkEvidence(sr, "dQw4w9WgXcQ", 0, "@RickAstleyYT", 1000n, { youtube: env.YOUTUBE_API_KEY_ALL ?? "", groq: "", gemini: "", nvidia: "", github: "" }, false, {}));
console.log(`${late.pass ? "FAIL" : "ok  "} deadline in 1970 -> ${late.detail}`); if (late.pass) bad++;
console.log(bad ? `${bad} wrong` : "all as expected");
process.exit(bad ? 1 : 0);
