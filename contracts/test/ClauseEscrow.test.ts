import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { encodeAbiParameters, parseAbiParameters, keccak256, type Hex } from "viem";
import deal1 from "../../shared/fixtures/deal1.json";
import reports from "../../shared/fixtures/reports.json";

// Status / kind constants (docs/INTERFACES.md)
const S = { Pending: 0, Submitted: 1, Verified: 2, Failed: 3, Released: 5, Refunded: 6 };
const NONE = 255;
const WINDOW = 120;
const SELECTOR = 3034092155422581607n;

type Terms = {
  kind: number; checkType: number; param: string; deadline: bigint;
  amount: bigint; dependsOn: number; onFail: number; vestDays: number;
};

const fixtureTerms: Terms[] = deal1.clauses.map((c) => ({
  ...c, deadline: BigInt(c.deadline), amount: BigInt(c.amount),
}));
const FIXTURE_TOTAL = BigInt(deal1.total);

function report(kind: number, dealId: bigint, clauseId: number, data: Hex = `0x${"00".repeat(32)}`, value = 0): Hex {
  return encodeAbiParameters(
    parseAbiParameters("uint8, uint256, uint8, uint8, bytes32, uint64, uint64"),
    [kind, dealId, clauseId, value, data, SELECTOR, 1794000000n],
  );
}

async function expectRevert(p: Promise<unknown>, name: string) {
  try { await p; } catch (e) {
    expect((e as Error).message, `expected revert ${name}`).to.include(name);
    return;
  }
  expect.fail(`expected revert ${name}, but the call succeeded`);
}

async function setup() {
  const [brand, creator, forwarder, stranger] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  const escrow = await hre.viem.deployContract("ClauseEscrow", [forwarder.account.address, usdc.address]);
  await usdc.write.mint([brand.account.address, 1_000_000_000n]);
  await usdc.write.approve([escrow.address, 2n ** 255n], { account: brand.account });
  const as = (w: typeof brand) => ({ account: w.account });
  return { brand, creator, forwarder, stranger, usdc, escrow, as };
}

/** propose + accept + certify (via the forwarder) -> ready to fund */
async function certifiedDeal(ctx: Awaited<ReturnType<typeof setup>>, terms: Terms[], total: bigint) {
  const { escrow, brand, creator, forwarder, as } = ctx;
  await escrow.write.proposeDeal([creator.account.address, total, terms], as(brand));
  const dealId = await escrow.read.dealCount();
  await escrow.write.acceptDeal([dealId], as(creator));
  const { specHash } = await escrow.read.getDeal([dealId]);
  await escrow.write.onReport(["0x", report(0, dealId, 0, specHash)], as(forwarder));
  return dealId;
}

const future = async (secs: number) => BigInt((await time.latest()) + secs);
const t = (over: Partial<Terms>): Terms => ({
  kind: 0, checkType: 0, param: "", deadline: 0n, amount: 0n, dependsOn: NONE, onFail: 0, vestDays: 0, ...over,
});

describe("ClauseEscrow", () => {
  describe("shared fixtures", () => {
    it("computes the same specHash as shared/spec.ts (0x18554418…e174)", async () => {
      const ctx = await setup();
      await ctx.escrow.write.proposeDeal([ctx.creator.account.address, FIXTURE_TOTAL, fixtureTerms], ctx.as(ctx.brand));
      const d = await ctx.escrow.read.getDeal([1n]);
      expect(d.specHash).to.equal(reports.specHash);
    });

    it("accepts the fixture Certify / Verified / Failed reports byte-for-byte", async () => {
      const ctx = await setup();
      const { escrow, brand, creator, forwarder, usdc, as } = ctx;
      await escrow.write.proposeDeal([creator.account.address, FIXTURE_TOTAL, fixtureTerms], as(brand));
      await escrow.write.acceptDeal([1n], as(creator));

      await escrow.write.onReport(["0x", reports.reports.certify.hex as Hex], as(forwarder));
      expect(await escrow.read.certified([1n])).to.equal(true);

      await escrow.write.fundDeal([1n], as(brand));
      await escrow.write.submitEvidence([1n, 0, "vid0"], as(creator));
      await escrow.write.submitEvidence([1n, 1, "vid1"], as(creator));

      await escrow.write.onReport(["0x", reports.reports.verified.hex as Hex], as(forwarder)); // clause 0
      await escrow.write.onReport(["0x", reports.reports.failed.hex as Hex], as(forwarder));   // clause 1
      expect((await escrow.read.getClause([1n, 0])).status).to.equal(S.Verified);
      expect((await escrow.read.getClause([1n, 1])).status).to.equal(S.Failed);

      // pay out: C0 -> creator after the window, C1 -> brand
      const before = await usdc.read.balanceOf([creator.account.address]);
      await time.increase(WINDOW);
      await escrow.write.release([1n, 0]);
      await escrow.write.refund([1n, 1]);
      expect((await usdc.read.balanceOf([creator.account.address])) - before).to.equal(60_000_000n);
      expect(await usdc.read.balanceOf([escrow.address])).to.equal(0n);
    });

    it("getClauses returns every clause (for CRE WF0)", async () => {
      const ctx = await setup();
      await ctx.escrow.write.proposeDeal([ctx.creator.account.address, FIXTURE_TOTAL, fixtureTerms], ctx.as(ctx.brand));
      const cs = await ctx.escrow.read.getClauses([1n]);
      expect(cs.length).to.equal(2);
      expect(cs[1].param).to.equal("#TravelCoPartner");
      expect(cs[1].dependsOn).to.equal(0);
      expect(keccak256(report(0, 1n, 0))).to.be.a("string");
    });
  });

  describe("proposeDeal", () => {
    it("rejects amounts that do not add up", async () => {
      const { escrow, brand, creator, as } = await setup();
      await expectRevert(
        escrow.write.proposeDeal([creator.account.address, 99n, [t({ amount: 100n })]], as(brand)),
        "AmountsDoNotAddUp");
    });
    it("rejects 0 and more than 5 clauses", async () => {
      const { escrow, brand, creator, as } = await setup();
      await expectRevert(escrow.write.proposeDeal([creator.account.address, 0n, []], as(brand)), "BadClauseCount");
      const six = Array.from({ length: 6 }, () => t({ amount: 1n }));
      await expectRevert(escrow.write.proposeDeal([creator.account.address, 6n, six], as(brand)), "BadClauseCount");
    });
    it("rejects a clause that depends on itself or on a missing clause", async () => {
      const { escrow, brand, creator, as } = await setup();
      await expectRevert(escrow.write.proposeDeal([creator.account.address, 1n, [t({ amount: 1n, dependsOn: 0 })]], as(brand)), "BadClause");
      await expectRevert(escrow.write.proposeDeal([creator.account.address, 1n, [t({ amount: 1n, dependsOn: 3 })]], as(brand)), "BadClause");
    });
    it("rejects a zero-amount clause and brand == creator", async () => {
      const { escrow, brand, creator, as } = await setup();
      await expectRevert(escrow.write.proposeDeal([creator.account.address, 0n, [t({ amount: 0n })]], as(brand)), "BadClause");
      await expectRevert(escrow.write.proposeDeal([brand.account.address, 1n, [t({ amount: 1n })]], as(brand)), "BadCreator");
    });
  });

  describe("certificate gate", () => {
    it("refuses funding before certified, and before accepted", async () => {
      const ctx = await setup();
      const { escrow, brand, creator, forwarder, as } = ctx;
      const terms = [t({ amount: 100n, deadline: await future(1000) })];
      await escrow.write.proposeDeal([creator.account.address, 100n, terms], as(brand));
      await escrow.write.acceptDeal([1n], as(creator));
      await expectRevert(escrow.write.fundDeal([1n], as(brand)), "NotCertified");

      await escrow.write.proposeDeal([creator.account.address, 100n, terms], as(brand)); // deal 2, not accepted
      const { specHash } = await escrow.read.getDeal([2n]);
      await escrow.write.onReport(["0x", report(0, 2n, 0, specHash)], as(forwarder));
      await expectRevert(escrow.write.fundDeal([2n], as(brand)), "NotAccepted");
    });
    it("refuses a certificate for the wrong specHash", async () => {
      const ctx = await setup();
      const { escrow, brand, creator, forwarder, as } = ctx;
      await escrow.write.proposeDeal([creator.account.address, 100n, [t({ amount: 100n })]], as(brand));
      await expectRevert(
        escrow.write.onReport(["0x", report(0, 1n, 0, `0x${"11".repeat(32)}`)], as(forwarder)),
        "SpecHashMismatch");
    });
    it("only the brand can fund; funding twice is refused", async () => {
      const ctx = await setup();
      const { escrow, brand, stranger, as } = ctx;
      const id = await certifiedDeal(ctx, [t({ amount: 100n, deadline: await future(1000) })], 100n);
      await expectRevert(escrow.write.fundDeal([id], as(stranger)), "NotBrand");
      await escrow.write.fundDeal([id], as(brand));
      await expectRevert(escrow.write.fundDeal([id], as(brand)), "AlreadyFunded");
    });
  });

  describe("only the forwarder can report", () => {
    it("rejects reports from anyone else, including brand and creator", async () => {
      const ctx = await setup();
      const { escrow, brand, creator, stranger, as } = ctx;
      await escrow.write.proposeDeal([creator.account.address, 100n, [t({ amount: 100n })]], as(brand));
      const { specHash } = await escrow.read.getDeal([1n]);
      for (const w of [stranger, brand, creator]) {
        await expectRevert(escrow.write.onReport(["0x", report(0, 1n, 0, specHash)], as(w)), "InvalidSender");
      }
    });
    it("rejects unsupported report kinds", async () => {
      const ctx = await setup();
      const { escrow, brand, creator, forwarder, as } = ctx;
      await escrow.write.proposeDeal([creator.account.address, 100n, [t({ amount: 100n })]], as(brand));
      await expectRevert(escrow.write.onReport(["0x", report(5, 1n, 0)], as(forwarder)), "UnsupportedReport");
    });
    it("cannot be deployed with a zero forwarder", async () => {
      const usdc = await hre.viem.deployContract("MockUSDC");
      await expectRevert(
        hre.viem.deployContract("ClauseEscrow", ["0x0000000000000000000000000000000000000000", usdc.address]),
        "InvalidForwarder");
    });
  });

  describe("delivery and settlement", () => {
    async function twoClauseDeal() {
      const ctx = await setup();
      const dl = await future(100_000);
      const terms = [
        t({ amount: 60n, deadline: dl }),
        t({ amount: 40n, deadline: dl, dependsOn: 0 }),
      ];
      const id = await certifiedDeal(ctx, terms, 100n);
      await ctx.escrow.write.fundDeal([id], ctx.as(ctx.brand));
      return { ...ctx, id, dl };
    }

    it("holds the total after funding", async () => {
      const { escrow, usdc, id } = await twoClauseDeal();
      expect(await usdc.read.balanceOf([escrow.address])).to.equal(100n);
      expect((await escrow.read.getDeal([id])).funded).to.equal(true);
    });

    it("only the creator can submit; only while Pending and before the deadline", async () => {
      const { escrow, creator, stranger, id, as } = await twoClauseDeal();
      await expectRevert(escrow.write.submitEvidence([id, 0, "v"], as(stranger)), "NotCreator");
      await escrow.write.submitEvidence([id, 0, "v"], as(creator));
      await expectRevert(escrow.write.submitEvidence([id, 0, "v"], as(creator)), "WrongStatus");
      await time.increase(200_000);
      await expectRevert(escrow.write.submitEvidence([id, 1, "v"], as(creator)), "DeadlinePassed");
    });

    it("emits ClauseSubmitted(dealId, clauseId, videoId) for WF1", async () => {
      const { escrow, creator, id, as } = await twoClauseDeal();
      const pc = await hre.viem.getPublicClient();
      const hash = await escrow.write.submitEvidence([id, 0, "abc123"], as(creator));
      await pc.waitForTransactionReceipt({ hash });
      const logs = await escrow.getEvents.ClauseSubmitted();
      expect(logs.length).to.equal(1);
      expect(logs[0].args.dealId).to.equal(id);
      expect(logs[0].args.clauseId).to.equal(0);
      expect(logs[0].args.videoId).to.equal("abc123");
    });

    it("release: waits for the window, then pays the creator exactly once", async () => {
      const { escrow, usdc, creator, forwarder, id, as } = await twoClauseDeal();
      await escrow.write.submitEvidence([id, 0, "v"], as(creator));
      await escrow.write.onReport(["0x", report(1, id, 0)], as(forwarder));
      await expectRevert(escrow.write.release([id, 0]), "WindowOpen");
      await time.increase(WINDOW);
      const before = await usdc.read.balanceOf([creator.account.address]);
      await escrow.write.release([id, 0]); // anyone can call
      expect((await usdc.read.balanceOf([creator.account.address])) - before).to.equal(60n);
      await expectRevert(escrow.write.release([id, 0]), "WrongStatus"); // no double payment
    });

    it("a dependent clause cannot be released before its dependency is Released", async () => {
      const { escrow, creator, forwarder, id, as } = await twoClauseDeal();
      for (const c of [0, 1]) {
        await escrow.write.submitEvidence([id, c, "v"], as(creator));
        await escrow.write.onReport(["0x", report(1, id, c)], as(forwarder));
      }
      await time.increase(WINDOW);
      await expectRevert(escrow.write.release([id, 1]), "DependencyNotReleased");
      await escrow.write.release([id, 0]);
      await escrow.write.release([id, 1]);
      expect((await escrow.read.getClause([id, 1])).status).to.equal(S.Released);
    });

    it("Failed clause is refunded to the brand exactly once", async () => {
      const { escrow, usdc, brand, creator, forwarder, id, as } = await twoClauseDeal();
      await escrow.write.submitEvidence([id, 0, "v"], as(creator));
      await escrow.write.onReport(["0x", report(2, id, 0)], as(forwarder));
      await expectRevert(escrow.write.release([id, 0]), "WrongStatus");
      const before = await usdc.read.balanceOf([brand.account.address]);
      await escrow.write.refund([id, 0]);
      expect((await usdc.read.balanceOf([brand.account.address])) - before).to.equal(60n);
      await expectRevert(escrow.write.refund([id, 0]), "NotRefundable");
    });

    it("cascade: refunding a clause lets the clause that depends on it be refunded (checker rule)", async () => {
      const { escrow, usdc, brand, creator, forwarder, id, as } = await twoClauseDeal();
      // C0 fails; C1 is still Pending
      await escrow.write.submitEvidence([id, 0, "v"], as(creator));
      await escrow.write.onReport(["0x", report(2, id, 0)], as(forwarder));
      await expectRevert(escrow.write.refund([id, 1]), "NotRefundable"); // dependency not refunded yet
      await escrow.write.refund([id, 0]);
      const before = await usdc.read.balanceOf([brand.account.address]);
      await escrow.write.refund([id, 1]);
      expect((await usdc.read.balanceOf([brand.account.address])) - before).to.equal(40n);
      expect(await usdc.read.balanceOf([escrow.address])).to.equal(0n); // nothing stuck
    });

    it("cascade also frees a Verified dependent whose dependency was refunded", async () => {
      const { escrow, creator, forwarder, id, as } = await twoClauseDeal();
      for (const c of [0, 1]) await escrow.write.submitEvidence([id, c, "v"], as(creator));
      await escrow.write.onReport(["0x", report(1, id, 1)], as(forwarder)); // C1 Verified
      await escrow.write.onReport(["0x", report(2, id, 0)], as(forwarder)); // C0 Failed
      await escrow.write.refund([id, 0]);
      await time.increase(WINDOW);
      await expectRevert(escrow.write.release([id, 1]), "DependencyNotReleased");
      await escrow.write.refund([id, 1]);
      expect((await escrow.read.getClause([id, 1])).status).to.equal(S.Refunded);
    });

    it("never refunds a clause that was already Released", async () => {
      const { escrow, creator, forwarder, id, as } = await twoClauseDeal();
      await escrow.write.submitEvidence([id, 0, "v"], as(creator));
      await escrow.write.onReport(["0x", report(1, id, 0)], as(forwarder));
      await time.increase(WINDOW);
      await escrow.write.release([id, 0]);
      await expectRevert(escrow.write.refund([id, 0]), "NotRefundable");
    });

    it("expire: a missed deadline or a missing report is a way out (safety rule 7)", async () => {
      const { escrow, creator, id, as } = await twoClauseDeal();
      await expectRevert(escrow.write.expire([id, 0]), "DeadlineNotPassed");
      await escrow.write.submitEvidence([id, 0, "v"], as(creator));
      await expectRevert(escrow.write.expire([id, 0]), "DeadlineNotPassed"); // Submitted, report timeout not reached
      await time.increase(100_001); // past the clause deadline (and past REPORT_TIMEOUT of 1 day)
      await escrow.write.expire([id, 1]); // Pending past deadline
      await escrow.write.expire([id, 0]); // Submitted, no report for REPORT_TIMEOUT
      await escrow.write.refund([id, 0]);
      await escrow.write.refund([id, 1]);
      expect((await escrow.read.getClause([id, 1])).status).to.equal(S.Refunded);
    });

    it("Verified/Failed reports are refused for unsubmitted or unfunded clauses", async () => {
      const ctx = await setup();
      const { escrow, forwarder, as } = ctx;
      const id = await certifiedDeal(ctx, [t({ amount: 100n, deadline: await future(1000) })], 100n);
      await expectRevert(escrow.write.onReport(["0x", report(1, id, 0)], as(forwarder)), "NotFunded");
      await escrow.write.fundDeal([id], as(ctx.brand));
      await expectRevert(escrow.write.onReport(["0x", report(1, id, 0)], as(forwarder)), "WrongStatus");
    });

    it("a clause's outcome never touches another clause's money", async () => {
      const { escrow, usdc, creator, forwarder, id, as } = await twoClauseDeal();
      await escrow.write.submitEvidence([id, 0, "v"], as(creator));
      await escrow.write.onReport(["0x", report(2, id, 0)], as(forwarder));
      await escrow.write.refund([id, 0]);
      expect(await usdc.read.balanceOf([escrow.address])).to.equal(40n); // C1's money untouched
    });
  });
});
