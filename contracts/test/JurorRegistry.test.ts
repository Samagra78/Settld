import { expect } from "chai";
import hre from "hardhat";
import { encodeAbiParameters, encodePacked, keccak256, parseAbiParameters, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Test-only attester key (the Settld backend signs with ATTESTER_PRIVATE_KEY in production)
const ATTESTER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const attester = privateKeyToAccount(ATTESTER_KEY);
const CASE = 7n;
const NO_DECISION = 255;

async function attest(nullifier: bigint, wallet: Address): Promise<Hex> {
  const hash = keccak256(encodePacked(["uint256", "address"], [nullifier, wallet]));
  return attester.signMessage({ message: { raw: hash } });
}

const commitment = (caseId: bigint, band: number, salt: Hex, voter: Address) =>
  keccak256(encodeAbiParameters(parseAbiParameters("uint256, uint8, bytes32, address"), [caseId, band, salt, voter]));

const saltOf = (i: number) => `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex;

async function expectRevert(p: Promise<unknown>, name: string) {
  try { await p; } catch (e) {
    expect((e as Error).message, `expected revert ${name}`).to.include(name);
    return;
  }
  expect.fail(`expected revert ${name}, but the call succeeded`);
}

async function increaseTime(secs: number) {
  await hre.network.provider.send("evm_increaseTime", [secs]);
  await hre.network.provider.send("evm_mine", []);
}

async function setup() {
  const [owner, court, client, freelancer, a1, a2, a3, a4, a5] = await hre.viem.getWalletClients();
  const registry = await hre.viem.deployContract("JurorRegistry", [attester.address, owner.account.address]);
  type W = typeof owner;
  const as = (w: W) => ({ account: w.account });
  const register = async (w: W, nullifier: bigint) =>
    registry.write.registerPerson([nullifier, await attest(nullifier, w.account.address)], as(w));
  const wire = () => registry.write.setCourt([court.account.address], as(owner));
  const open = (caseId = CASE) =>
    registry.write.openPanel([caseId, client.account.address, freelancer.account.address], as(court));
  const commit = (w: W, band: number, i: number, caseId = CASE) =>
    registry.write.commitVote([caseId, commitment(caseId, band, saltOf(i), w.account.address)], as(w));
  const reveal = (w: W, band: number, i: number, caseId = CASE) =>
    registry.write.revealVote([caseId, band, saltOf(i)], as(w));
  const close = (caseId = CASE) => registry.write.closePanel([caseId]);
  const lower = (a: string) => a.toLowerCase();

  /// registered arbitrators a1..a5 with nullifiers 101..105, court wired, panel CASE open
  const ready = async () => {
    await wire();
    for (const [i, w] of [a1, a2, a3, a4, a5].entries()) await register(w, BigInt(101 + i));
    await open();
  };

  /// 3 arbitrators commit + reveal the given bands, then the panel is closed
  const decide = async (bands: [number, number, number], caseId = CASE) => {
    const seats = [a1, a2, a3];
    for (const [i, w] of seats.entries()) await commit(w, bands[i], i, caseId);
    for (const [i, w] of seats.entries()) await reveal(w, bands[i], i, caseId);
    await close(caseId);
    return registry.read.decision([caseId]);
  };

  return { owner, court, client, freelancer, a1, a2, a3, a4, a5, registry, as, register, wire, open, commit, reveal, close, ready, decide, lower };
}

describe("JurorRegistry v2", () => {
  describe("registration (one human = one wallet)", () => {
    it("registers a wallet with a valid attestation", async () => {
      const { a1, registry, register } = await setup();
      await register(a1, 111n);
      expect(await registry.read.nullifierOf([a1.account.address])).to.equal(111n);
      expect((await registry.read.walletOf([111n])).toLowerCase()).to.equal(a1.account.address.toLowerCase());
      expect(await registry.read.isRegistered([a1.account.address])).to.equal(true);
    });

    it("rejects an attestation not signed by the attester", async () => {
      const { a1, registry, as } = await setup();
      const fake = privateKeyToAccount(`0x${"11".repeat(32)}`);
      const hash = keccak256(encodePacked(["uint256", "address"], [111n, a1.account.address]));
      const sig = await fake.signMessage({ message: { raw: hash } });
      await expectRevert(registry.write.registerPerson([111n, sig], as(a1)), "InvalidAttestation");
    });

    it("rejects an attestation issued for a different wallet", async () => {
      const { a1, a2, registry, as } = await setup();
      const sigForA1 = await attest(111n, a1.account.address);
      await expectRevert(registry.write.registerPerson([111n, sigForA1], as(a2)), "InvalidAttestation");
    });

    it("the same human cannot register a second wallet", async () => {
      const { a1, a2, register } = await setup();
      await register(a1, 111n);
      await expectRevert(register(a2, 111n), "NullifierAlreadyRegistered");
    });

    it("a wallet cannot register twice, and nullifier 0 is rejected", async () => {
      const { a1, a2, register } = await setup();
      await register(a1, 111n);
      await expectRevert(register(a1, 222n), "WalletAlreadyRegistered");
      await expectRevert(register(a2, 0n), "InvalidNullifier");
    });
  });

  describe("wiring and panels", () => {
    it("only the owner sets the court, once", async () => {
      const { a1, court, registry, as, wire } = await setup();
      await expectRevert(registry.write.setCourt([court.account.address], as(a1)), "NotOwner");
      await wire();
      await expectRevert(wire(), "CourtAlreadySet");
    });

    it("only the court opens a panel, once per case", async () => {
      const { a1, client, freelancer, registry, as, wire, open } = await setup();
      await wire();
      await expectRevert(
        registry.write.openPanel([CASE, client.account.address, freelancer.account.address], as(a1)), "NotCourt");
      await open();
      await expectRevert(open(), "PanelExists");
    });

    it("cannot commit on a panel that was never opened", async () => {
      const { a1, wire, register, commit } = await setup();
      await wire();
      await register(a1, 101n);
      await expectRevert(commit(a1, 100, 0), "NoPanel");
    });
  });

  describe("who can sit (proof of humanity + no conflict of interest)", () => {
    it("unregistered wallets cannot take a seat", async () => {
      const { a1, wire, open, commit } = await setup();
      await wire();
      await open();
      await expectRevert(commit(a1, 100, 0), "NotRegistered");
    });

    it("the client and the freelancer cannot judge their own case", async () => {
      const { client, freelancer, register, ready, commit } = await setup();
      await ready();
      await register(client, 900n);
      await register(freelancer, 901n);
      await expectRevert(commit(client, 0, 0), "PartyCannotJudge");
      await expectRevert(commit(freelancer, 100, 1), "PartyCannotJudge");
    });

    it("a party cannot sneak in with a fresh wallet: their World ID is already taken", async () => {
      const { client, a4, register, ready } = await setup();
      await ready();
      await register(client, 900n);
      // the client's World ID (900) can never be attached to another wallet
      await expectRevert(register(a4, 900n), "NullifierAlreadyRegistered");
    });

    it("the same person cannot take two seats, and a 4th seat is refused", async () => {
      const { a1, a2, a3, a4, ready, commit } = await setup();
      await ready();
      await commit(a1, 100, 0);
      await expectRevert(commit(a1, 100, 0), "AlreadySeated");
      await commit(a2, 100, 1);
      await commit(a3, 100, 2);
      await expectRevert(commit(a4, 100, 3), "PanelFull");
    });

    it("seats close after the commit window", async () => {
      const { a1, ready, commit } = await setup();
      await ready();
      await increaseTime(121);
      await expectRevert(commit(a1, 100, 0), "CommitClosed");
    });
  });

  describe("hidden vote", () => {
    it("cannot reveal before all seats committed (or the commit window ended)", async () => {
      const { a1, a2, ready, commit, reveal } = await setup();
      await ready();
      await commit(a1, 100, 0);
      await commit(a2, 100, 1);
      await expectRevert(reveal(a1, 100, 0), "NotRevealPhase");
    });

    it("a reveal must match the commitment and be a valid band", async () => {
      const { a1, a2, a3, registry, as, ready, commit, reveal } = await setup();
      await ready();
      await commit(a1, 100, 0);
      await commit(a2, 100, 1);
      await commit(a3, 50, 2);
      await expectRevert(reveal(a1, 50, 0), "CommitmentMismatch");             // changed their mind
      await expectRevert(registry.write.revealVote([CASE, 100, saltOf(9)], as(a1)), "CommitmentMismatch"); // wrong salt
      await expectRevert(reveal(a1, 70, 0), "InvalidBand");
      await reveal(a1, 100, 0);
      await expectRevert(reveal(a1, 100, 0), "AlreadyRevealed");
    });

    it("cannot close early", async () => {
      const { a1, a2, a3, ready, commit, reveal, close } = await setup();
      await ready();
      await commit(a1, 100, 0);
      await commit(a2, 100, 1);
      await commit(a3, 100, 2);
      await reveal(a1, 100, 0);
      await expectRevert(close(), "TooEarly");
    });
  });

  describe("decision + track record", () => {
    it("2 vs 1: majority band wins, the minority voter gets a strike", async () => {
      const s = await setup();
      await s.ready();
      const [decided, band, majority] = await s.decide([80, 80, 0]);
      expect(decided).to.equal(true);
      expect(band).to.equal(80);
      expect(majority.map(s.lower)).to.deep.equal([s.a1, s.a2].map((w) => s.lower(w.account.address)));
      expect(await s.registry.read.profile([101n])).to.deep.equal([1, 1, 0, false]);
      expect(await s.registry.read.profile([103n])).to.deep.equal([1, 0, 1, false]);
    });

    it("unanimous: everyone is in the majority, no strikes", async () => {
      const s = await setup();
      await s.ready();
      const [, band, majority] = await s.decide([100, 100, 100]);
      expect(band).to.equal(100);
      expect(majority.length).to.equal(3);
      expect((await s.registry.read.profile([103n]))[2]).to.equal(0);
    });

    it("no majority (0 / 50 / 100): middle band, no strikes, fee shared by all", async () => {
      const s = await setup();
      await s.ready();
      const [, band, majority] = await s.decide([100, 0, 50]);
      expect(band).to.equal(50);
      expect(majority.length).to.equal(3);
      for (const n of [101n, 102n, 103n]) expect((await s.registry.read.profile([n]))[2]).to.equal(0);
    });

    it("committing but not revealing is a strike; the rest still decide", async () => {
      const s = await setup();
      await s.ready();
      await s.commit(s.a1, 0, 0);
      await s.commit(s.a2, 0, 1);
      await s.commit(s.a3, 100, 2);
      await s.reveal(s.a1, 0, 0);
      await s.reveal(s.a2, 0, 1);
      await increaseTime(61);
      await s.close();
      const [, band, majority] = await s.registry.read.decision([CASE]);
      expect(band).to.equal(0);
      expect(majority.length).to.equal(2);
      expect(await s.registry.read.profile([103n])).to.deep.equal([1, 0, 1, false]);
    });

    it("nobody revealed: NO_DECISION, so the court keeps the AI band", async () => {
      const s = await setup();
      await s.ready();
      await increaseTime(121 + 61);
      await s.close();
      const [decided, band, majority] = await s.registry.read.decision([CASE]);
      expect(decided).to.equal(true);
      expect(band).to.equal(NO_DECISION);
      expect(majority.length).to.equal(0);
    });

    it("2 strikes = suspended; a new wallet cannot bring them back", async () => {
      const s = await setup();
      await s.ready();
      // case 7: a3 votes against the majority → strike 1
      await s.decide([100, 100, 0]);
      // case 8: a3 against the majority again → strike 2 → suspended
      await s.open(8n);
      await s.decide([50, 50, 100], 8n);
      expect(await s.registry.read.profile([103n])).to.deep.equal([2, 0, 2, true]);
      // case 9: suspended can't sit
      await s.open(9n);
      await expectRevert(s.commit(s.a3, 100, 0, 9n), "Suspended");
      // a3's human (103) can't come back with a fresh wallet either
      const [, , , , , , , , , fresh] = await hre.viem.getWalletClients();
      await expectRevert(s.register(fresh, 103n), "NullifierAlreadyRegistered");
    });

    it("the panel can't be touched after it closes", async () => {
      const s = await setup();
      await s.ready();
      await s.decide([100, 100, 100]);
      await expectRevert(s.close(), "PanelIsClosed");
      await expectRevert(s.commit(s.a4, 100, 3), "PanelIsClosed");
    });
  });
});
