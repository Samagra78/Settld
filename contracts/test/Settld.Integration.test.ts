// End-to-end: ClauseEscrow v2 + AICourt (Arc Studio) + JurorRegistry v2 (ours), wired like production,
// driven with the SAME report encoders the Chainlink workflows use (shared/report.ts).
import { expect } from "chai";
import hre from "hardhat";
import { encodeAbiParameters, encodePacked, keccak256, parseAbiParameters, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Same layouts as shared/report.ts (encodeReport / encodeRoundReport) — that file is an ES module,
// which Hardhat's CommonJS test runner can't load, so the two layout strings are repeated here verbatim.
const ARC_TESTNET_SELECTOR = 3034092155422581607n;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const REPORT = parseAbiParameters("uint8 kind, uint256 dealId, uint8 clauseId, uint8 value, bytes32 data, uint64 sourceSelector, uint64 timestamp");
const ROUND = parseAbiParameters("uint8 kind, uint256 caseId, uint8 round, uint8[3] bands, uint16[3] wordsUsed, bool[3] wantsExtend, bool[3] isFinal, uint8[3] citedMask, bytes32 transcriptHash");
type Three<T> = [T, T, T];
const encodeReport = (r: { kind: number; dealId: bigint; clauseId: number; value: number; data: Hex; sourceSelector: bigint; timestamp: bigint }) =>
  encodeAbiParameters(REPORT, [r.kind, r.dealId, r.clauseId, r.value, r.data, r.sourceSelector, r.timestamp]);
type RoundReport = { caseId: bigint; round: number; bands: Three<number>; wordsUsed: Three<number>; wantsExtend: Three<boolean>; isFinal: Three<boolean>; citedMask: Three<number>; transcriptHash: Hex };
const encodeRoundReport = (r: RoundReport) =>
  encodeAbiParameters(ROUND, [6, r.caseId, r.round, r.bands, r.wordsUsed, r.wantsExtend, r.isFinal, r.citedMask, r.transcriptHash]);

const ATTESTER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));
const NO_DEP = 255;

async function increaseTime(s: number) {
  await hre.network.provider.send("evm_increaseTime", [s]);
  await hre.network.provider.send("evm_mine", []);
}
async function expectRevert(p: Promise<unknown>, name: string) {
  try { await p; } catch (e) { expect((e as Error).message).to.include(name); return; }
  expect.fail(`expected revert ${name}`);
}
const attest = (n: bigint, w: Address) =>
  ATTESTER.signMessage({ message: { raw: keccak256(encodePacked(["uint256", "address"], [n, w])) } });
// JurorRegistry commitment = keccak256(abi.encode(caseId, band, salt, voter))
const commitment = (caseId: bigint, band: number, salt: Hex, voter: Address) =>
  keccak256(encodeAbiParameters(parseAbiParameters("uint256, uint8, bytes32, address"), [caseId, band, salt, voter]));

async function setup() {
  const [owner, forwarder, client, freelancer, a1, a2, a3] = await hre.viem.getWalletClients();
  const pub = await hre.viem.getPublicClient();
  const as = (w: typeof owner) => ({ account: w.account });

  const usdc = await hre.viem.deployContract("MockUSDC");
  const escrow = await hre.viem.deployContract("ClauseEscrow", [forwarder.account.address, usdc.address, owner.account.address]);
  const court = await hre.viem.deployContract("AICourt", [forwarder.account.address, usdc.address, escrow.address, owner.account.address]);
  const registry = await hre.viem.deployContract("JurorRegistry", [ATTESTER.address, owner.account.address]);

  // one-time wiring from the owner (what Mehak runs after deploy)
  await escrow.write.setCourt([court.address], as(owner));
  await court.write.setJury([registry.address], as(owner));
  await registry.write.setCourt([court.address], as(owner));

  await usdc.write.mint([client.account.address, USDC(1000)]);
  await usdc.write.mint([freelancer.account.address, USDC(100)]);
  const bal = (a: Address) => usdc.read.balanceOf([a]);

  const now = Number((await pub.getBlock()).timestamp);
  const terms = [{
    kind: 0, checkType: 7, param: "Landing page with logo and a working signup form",
    deadline: BigInt(now + 3 * 86400), amount: USDC(100), dependsOn: NO_DEP, onFail: 0, vestDays: 0,
  }];
  const report = (kind: number, dealId: bigint, clauseId: number, data: Hex = ZERO32) =>
    encodeReport({ kind, dealId, clauseId, value: 0, data, sourceSelector: ARC_TESTNET_SELECTOR, timestamp: BigInt(now) });

  // deal 1: propose → accept → Chainlink certify (WF0) → fund → submit → Chainlink verify (WF1) → client disputes
  await escrow.write.proposeDeal([freelancer.account.address, USDC(100), terms], as(client));
  await escrow.write.acceptDeal([1n], as(freelancer));
  const deal = await escrow.read.getDeal([1n]);
  await escrow.write.onReport(["0x", report(0, 1n, 0, deal.specHash)], as(forwarder));
  await usdc.write.approve([escrow.address, USDC(100)], as(client));
  await escrow.write.fundDeal([1n], as(client));
  await escrow.write.submitEvidence([1n, 0, "https://example.com/landing"], as(freelancer));
  await escrow.write.onReport(["0x", report(1, 1n, 0)], as(forwarder));
  await escrow.write.dispute([1n, 0, "The signup form is broken"], as(client));

  // WF3: the live 3-judge debate we ran (50 / 100 / 80, extension in round 0, all final in round 1)
  const round = (r: number, words: [number, number, number], ext: [boolean, boolean, boolean], fin: [boolean, boolean, boolean]) =>
    court.write.onReport(["0x", encodeRoundReport({
      caseId: 1n, round: r, bands: [50, 100, 80], wordsUsed: words, wantsExtend: ext, isFinal: fin,
      citedMask: [7, 7, 7], transcriptHash: keccak256(toHex(`transcript round ${r}`)),
    })], as(forwarder));

  return { owner, forwarder, client, freelancer, a1, a2, a3, usdc, escrow, court, registry, bal, as, round, pub };
}

describe("Settld integration: escrow v2 + AI court + World ID arbitrators", () => {
  it("AI verdict with no appeal: 3 judges debate → middle band 80 → 80/20 split paid on settle", async () => {
    const s = await setup();
    expect((await s.escrow.read.getClauses([1n]))[0].status).to.equal(4); // Disputed
    expect(await s.escrow.read.caseOf([1n, 0])).to.equal(1n);

    await s.round(0, [52, 35, 42], [true, false, true], [false, false, false]); // 2 of 3 → extension
    const afterExt = await s.court.read.getCase([1n]);
    expect(afterExt.wordBudget).to.equal(300);
    await s.round(1, [117, 81, 105], [false, false, false], [true, true, true]);
    await s.court.write.closeCase([1n]); // all final → can close now
    expect((await s.court.read.getCase([1n])).aiBand).to.equal(80);

    await expectRevert(s.court.write.finalize([1n]), "AppealWindowOpen");
    await increaseTime(121);
    await s.court.write.finalize([1n]);
    expect(await s.court.read.finalVerdict([1n])).to.deep.equal([true, 80]);

    const f0 = await s.bal(s.freelancer.account.address), c0 = await s.bal(s.client.account.address);
    await s.escrow.write.resolveDispute([1n, 0]);
    expect((await s.bal(s.freelancer.account.address)) - f0).to.equal(USDC(80));
    expect((await s.bal(s.client.account.address)) - c0).to.equal(USDC(20));
    expect((await s.escrow.read.getClauses([1n]))[0].status).to.equal(5); // Released (share > 0)
  });

  it("appeal: World ID arbitrators overrule the AI; fee goes to the majority; biased arbitrator struck", async () => {
    const s = await setup();
    await s.round(0, [52, 35, 42], [true, false, true], [false, false, false]);
    await s.round(1, [117, 81, 105], [false, false, false], [true, true, true]);
    await s.court.write.closeCase([1n]);

    // the freelancer rejects 80 and appeals with 10% of the clause
    const fee = await s.court.read.appealFee([1n]);
    expect(fee).to.equal(USDC(10));
    await s.usdc.write.approve([s.court.address, fee], s.as(s.freelancer));
    await s.court.write.appeal([1n], s.as(s.freelancer));

    // verified humans register (one World ID each); the client is verified too
    const people = [[s.a1, 101n], [s.a2, 102n], [s.a3, 103n], [s.client, 900n]] as const;
    for (const [w, n] of people) await s.registry.write.registerPerson([n, await attest(n, w.account.address)], s.as(w));

    // a party can't judge their own case
    await expectRevert(
      s.registry.write.commitVote([1n, commitment(1n, 0, ZERO32, s.client.account.address)], s.as(s.client)), "PartyCannotJudge");

    // hidden votes: two say pay in full, one (biased) says refund everything
    const votes = [[s.a1, 100], [s.a2, 100], [s.a3, 0]] as const;
    const salt = (i: number) => keccak256(toHex(`salt ${i}`));
    for (const [i, [w, b]] of votes.entries()) await s.registry.write.commitVote([1n, commitment(1n, b, salt(i), w.account.address)], s.as(w));
    for (const [i, [w, b]] of votes.entries()) await s.registry.write.revealVote([1n, b, salt(i)], s.as(w));
    await s.registry.write.closePanel([1n]);

    const a1b = await s.bal(s.a1.account.address), a2b = await s.bal(s.a2.account.address);
    await s.court.write.finalize([1n]);
    expect(await s.court.read.finalVerdict([1n])).to.deep.equal([true, 100]);
    expect((await s.court.read.getCase([1n])).byHumans).to.equal(true);
    expect((await s.bal(s.a1.account.address)) - a1b).to.equal(USDC(5));   // fee split between the majority
    expect((await s.bal(s.a2.account.address)) - a2b).to.equal(USDC(5));
    expect((await s.registry.read.profile([103n]))[2]).to.equal(1);         // biased arbitrator: strike 1

    const f0 = await s.bal(s.freelancer.account.address);
    await s.escrow.write.resolveDispute([1n, 0]);
    expect((await s.bal(s.freelancer.account.address)) - f0).to.equal(USDC(100));
    // nothing can settle twice
    await expectRevert(s.escrow.write.resolveDispute([1n, 0]), "InvalidClauseStatus");
    await expectRevert(s.court.write.finalize([1n]), "AlreadyFinalized");
  });

  it("the court rejects rounds that break the rules (late, over budget, bad band, out of order, wrong forwarder)", async () => {
    const s = await setup();
    const bad = (o: Partial<RoundReport>, who = s.forwarder) =>
      s.court.write.onReport(["0x", encodeRoundReport({
        caseId: 1n, round: 0, bands: [50, 50, 50], wordsUsed: [10, 10, 10], wantsExtend: [false, false, false],
        isFinal: [false, false, false], citedMask: [1, 1, 1], transcriptHash: ZERO32, ...o,
      })], s.as(who));
    await expectRevert(bad({ wordsUsed: [201, 10, 10] }), "WordsOverBudget");
    await expectRevert(bad({ bands: [70, 50, 50] }), "InvalidBand");
    await expectRevert(bad({ citedMask: [8, 1, 1] }), "InvalidCitedMask");
    await expectRevert(bad({ round: 1 }), "WrongRound");
    // not the Chainlink forwarder → ReceiverTemplate.InvalidSender (viem may not decode the inherited error name)
    let rejected = false;
    try { await bad({}, s.client); } catch { rejected = true; }
    expect(rejected, "a report from a non-forwarder must revert").to.equal(true);
    await increaseTime(181);
    await expectRevert(bad({}), "DeadlinePassed");
  });
});
