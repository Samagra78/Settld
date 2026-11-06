import { expect } from "chai";
import hre from "hardhat";
import { encodePacked, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Test-only attester key (the Settld backend signs with ATTESTER_PRIVATE_KEY in production)
const ATTESTER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const attester = privateKeyToAccount(ATTESTER_KEY);
const DISPUTED = 4, VERIFIED = 2;

async function attest(nullifier: bigint, wallet: Address): Promise<Hex> {
  const hash = keccak256(encodePacked(["uint256", "address"], [nullifier, wallet]));
  return attester.signMessage({ message: { raw: hash } });
}

async function expectRevert(p: Promise<unknown>, name: string) {
  try { await p; } catch (e) {
    expect((e as Error).message, `expected revert ${name}`).to.include(name);
    return;
  }
  expect.fail(`expected revert ${name}, but the call succeeded`);
}

async function setup() {
  const [brand, creator, j1, j2, j3, j4] = await hre.viem.getWalletClients();
  const escrow = await hre.viem.deployContract("MockEscrowView");
  const registry = await hre.viem.deployContract("JurorRegistry", [attester.address, escrow.address]);
  // deal 1: clause 0 disputed, clause 1 verified
  await escrow.write.setDeal([1n, brand.account.address, creator.account.address, [DISPUTED, VERIFIED]]);

  const as = (w: typeof brand) => ({ account: w.account });
  const register = async (w: typeof brand, nullifier: bigint) =>
    registry.write.registerPerson([nullifier, await attest(nullifier, w.account.address)], as(w));

  return { brand, creator, j1, j2, j3, j4, escrow, registry, as, register };
}

describe("JurorRegistry", () => {
  describe("registration (one human = one seat)", () => {
    it("registers a wallet with a valid attestation", async () => {
      const { j1, registry, register } = await setup();
      await register(j1, 111n);
      expect(await registry.read.nullifierOf([j1.account.address])).to.equal(111n);
      expect((await registry.read.walletOf([111n])).toLowerCase()).to.equal(j1.account.address.toLowerCase());
      expect(await registry.read.isRegistered([j1.account.address])).to.equal(true);
    });

    it("rejects an attestation not signed by the attester", async () => {
      const { j1, registry, as } = await setup();
      const fake = privateKeyToAccount(`0x${"11".repeat(32)}`);
      const hash = keccak256(encodePacked(["uint256", "address"], [111n, j1.account.address]));
      const sig = await fake.signMessage({ message: { raw: hash } });
      await expectRevert(registry.write.registerPerson([111n, sig], as(j1)), "InvalidAttestation");
    });

    it("rejects an attestation issued for a different wallet", async () => {
      const { j1, j2, registry, as } = await setup();
      const sigForJ1 = await attest(111n, j1.account.address);
      await expectRevert(registry.write.registerPerson([111n, sigForJ1], as(j2)), "InvalidAttestation");
    });

    it("the same human (nullifier) cannot register a second wallet", async () => {
      const { j1, j2, register } = await setup();
      await register(j1, 111n);
      await expectRevert(register(j2, 111n), "NullifierAlreadyRegistered");
    });

    it("a wallet cannot register twice", async () => {
      const { j1, register } = await setup();
      await register(j1, 111n);
      await expectRevert(register(j1, 222n), "WalletAlreadyRegistered");
    });

    it("rejects nullifier 0", async () => {
      const { j1, register } = await setup();
      await expectRevert(register(j1, 0n), "InvalidNullifier");
    });
  });

  describe("voting", () => {
    it("unregistered wallets cannot vote", async () => {
      const { j1, registry, as } = await setup();
      await expectRevert(registry.write.vote([1n, 0, true], as(j1)), "NotRegistered");
    });

    it("only disputed clauses can be voted on", async () => {
      const { j1, registry, as, register } = await setup();
      await register(j1, 111n);
      await expectRevert(registry.write.vote([1n, 1, true], as(j1)), "NotDisputed");
    });

    it("unknown clauses are rejected", async () => {
      const { j1, registry, as, register } = await setup();
      await register(j1, 111n);
      await expectRevert(registry.write.vote([1n, 7, true], as(j1)), "UnknownClause");
    });

    it("the brand and the creator cannot vote on their own deal", async () => {
      const { brand, creator, registry, as, register } = await setup();
      await register(brand, 900n);
      await register(creator, 901n);
      await expectRevert(registry.write.vote([1n, 0, false], as(brand)), "PartyCannotVote");
      await expectRevert(registry.write.vote([1n, 0, true], as(creator)), "PartyCannotVote");
    });

    it("a juror cannot vote twice on the same clause", async () => {
      const { j1, registry, as, register } = await setup();
      await register(j1, 111n);
      await registry.write.vote([1n, 0, true], as(j1));
      await expectRevert(registry.write.vote([1n, 0, true], as(j1)), "AlreadyVoted");
    });

    it("majority of 3 decides: 2 votes to pay the creator", async () => {
      const { j1, j2, registry, as, register } = await setup();
      await register(j1, 111n);
      await register(j2, 222n);
      await registry.write.vote([1n, 0, true], as(j1));
      let [decided] = await registry.read.decision([1n, 0]);
      expect(decided).to.equal(false);
      await registry.write.vote([1n, 0, true], as(j2));
      const [d, pay, yes, no] = await registry.read.decision([1n, 0]);
      expect(d).to.equal(true);
      expect(pay).to.equal(true);
      expect(yes).to.equal(2);
      expect(no).to.equal(0);
    });

    it("split vote: 1 pay, 2 refund → refund the brand", async () => {
      const { j1, j2, j3, registry, as, register } = await setup();
      await register(j1, 111n);
      await register(j2, 222n);
      await register(j3, 333n);
      await registry.write.vote([1n, 0, true], as(j1));
      await registry.write.vote([1n, 0, false], as(j2));
      await registry.write.vote([1n, 0, false], as(j3));
      const [d, pay, yes, no] = await registry.read.decision([1n, 0]);
      expect(d).to.equal(true);
      expect(pay).to.equal(false);
      expect(yes).to.equal(1);
      expect(no).to.equal(2);
    });

    it("no more votes once decided", async () => {
      const { j1, j2, j3, registry, as, register } = await setup();
      await register(j1, 111n);
      await register(j2, 222n);
      await register(j3, 333n);
      await registry.write.vote([1n, 0, true], as(j1));
      await registry.write.vote([1n, 0, true], as(j2));
      await expectRevert(registry.write.vote([1n, 0, false], as(j3)), "AlreadyDecided");
    });
  });
});
