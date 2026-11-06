# cre/ — Settld's Chainlink CRE workflows

Settld uses Chainlink CRE as the neutral referee between a client and a freelancer. Three workflows, all
TypeScript, all writing signed reports to contracts on **Arc testnet** (USDC escrow built in Arc Studio):

| Workflow | Trigger | What it does | Report → contract |
|---|---|---|---|
| **WF0 certify** (`wf0-certify/`) | `DealAccepted` log (or HTTP `{dealId}`) | Reads the deal **from the chain**, recomputes its fingerprint (specHash), runs the **deadlock checker** (`shared/checker.ts`: explores every reachable state and proves every clause always ends paid or refunded). Funding is impossible without this certificate. | kind 0 Certify → ClauseEscrow |
| **WF1 verify** (`wf1-verify/`) | `ClauseSubmitted` log | Checks the freelancer's evidence with the clause's verifier: YouTube posted / description contains text, link is live, page contains text, GitHub PR merged — deterministic code. Only subjective clauses use AI: **3 models vote** (majority). | kind 1 Verified / 2 Failed → ClauseEscrow |
| **WF3 AI court** (`wf3-court/`) | `CaseOpened` / `RoundCompleted` logs (+ HTTP dry run) | Three judges from three companies — **OpenAI gpt-oss-120b (Groq), Google Gemini 3.5 Flash-Lite, NVIDIA Nemotron 3.5 Bolt** — deliberate one round per run: blind opinions, then debate. 200 words each (+100 and +60 s if 2 of 3 ask, max 2), 3–5 min hard cap, band changes only with cited evidence, evidence treated as data (prompt-injection guard). Transcript stored off-chain, its hash on-chain. | kind 6 Round → AICourt |

The contracts enforce the same rules again (word budget, deadline, round limit, bands, citations), and the AI verdict
is the middle of the three final bands (= the majority when there is one). A party can appeal to World ID-verified
human arbitrators. Rules: `wf3-court/court.ts` (11 tests: `bun test` in `wf3-court/`).

**Cost: $0 inference** (free tiers), temperature 0, ~1–2 s per model call (fits CRE's 10 s HTTP limit).
**Replay mode** (`"replay": true` in the staging config) plays a scripted debate for a deterministic demo.

## Running
Our CRE account has simulation access, so the server's **watcher** runs each workflow with
`cre workflow simulate … --broadcast` when its trigger event appears on Arc (`server/src/automation.ts`), and
the **keeper** settles everything permissionless (release, refund, closeCase, finalize, resolveDispute, …).
Live view: `http://localhost:3000/monitor`. Full flow: `bun run e2e-dispute [--appeal]` in `scripts/`.

Secrets (`.env`, git-ignored; names in `secrets.yaml`): `CRE_ETH_PRIVATE_KEY`, `GROQ_API_KEY_ALL`, `GEMINI_API_KEY_ALL`,
`NVIDIA_API_KEY_ALL`, `COURT_WRITE_TOKEN_ALL`, optional `YOUTUBE_API_KEY_ALL`.

```bash
# WF0 automatic: replay an acceptDeal transaction
cre workflow simulate wf0-certify --target staging-settings --non-interactive --trigger-index 1 --evm-tx-hash <tx> --evm-event-index <i> --broadcast
# WF1 automatic: replay a submitEvidence transaction
cre workflow simulate wf1-verify --target staging-settings --non-interactive --trigger-index 0 --evm-tx-hash <tx> --evm-event-index <i> --broadcast
# WF3 dry run with live models (no chain): one round per call
cre workflow simulate wf3-court --target production-settings --non-interactive --trigger-index 2 --http-payload '{"case":{"terms":"…","evidence":"…","reason":"…"}}'
```
Contract addresses come from `shared/addresses.json`; after a deploy run `bun run use-addresses` in `scripts/`.
