import { writeFileSync } from "node:fs";
import deal from "./fixtures/deal1.json";
import { computeSpecHash, type ClauseTerms } from "./spec";
import { encodeReport, ReportKind, ZERO32, ARC_TESTNET_SELECTOR, type Report } from "./report";

// Turn the JSON deal into typed clause terms
const terms: ClauseTerms[] = deal.clauses.map((c) => ({
  kind: c.kind,
  checkType: c.checkType,
  param: c.param,
  deadline: BigInt(c.deadline),
  amount: BigInt(c.amount),
  dependsOn: c.dependsOn,
  onFail: c.onFail,
  vestDays: c.vestDays,
}));

const specHash = computeSpecHash(terms);
const TIMESTAMP = 1794000000n; // fixed, so the bytes never change
const DEAL_ID = 1n;

const examples: Record<string, Report> = {
  certify:  { kind: ReportKind.Certify,  dealId: DEAL_ID, clauseId: 0, value: 0, data: specHash, sourceSelector: ARC_TESTNET_SELECTOR, timestamp: TIMESTAMP },
  verified: { kind: ReportKind.Verified, dealId: DEAL_ID, clauseId: 0, value: 0, data: ZERO32,   sourceSelector: ARC_TESTNET_SELECTOR, timestamp: TIMESTAMP },
  failed:   { kind: ReportKind.Failed,   dealId: DEAL_ID, clauseId: 1, value: 0, data: ZERO32,   sourceSelector: ARC_TESTNET_SELECTOR, timestamp: TIMESTAMP },
};

// bigint can't go into JSON directly, so store numbers as strings
const out = {
  deal: "deal1.json",
  specHash,
  reports: Object.fromEntries(
    Object.entries(examples).map(([name, r]) => [
      name,
      {
        fields: { ...r, dealId: r.dealId.toString(), sourceSelector: r.sourceSelector.toString(), timestamp: r.timestamp.toString() },
        hex: encodeReport(r),
      },
    ])
  ),
};

writeFileSync("./fixtures/reports.json", JSON.stringify(out, null, 2) + "\n");
console.log("specHash:", specHash);
console.log("wrote fixtures/reports.json");