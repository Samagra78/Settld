import { describe, expect, test } from "bun:test";
import deal from "./fixtures/deal1.json";
import { checkDeal, NO_DEPENDENCY } from "./checker";
import type { ClauseTerms } from "./spec";

const fromFixture = (): ClauseTerms[] =>
  deal.clauses.map((c) => ({
    kind: c.kind,
    checkType: c.checkType,
    param: c.param,
    deadline: BigInt(c.deadline),
    amount: BigInt(c.amount),
    dependsOn: c.dependsOn,
    onFail: c.onFail,
    vestDays: c.vestDays,
  }));

const clause = (amount: bigint, dependsOn = NO_DEPENDENCY): ClauseTerms => ({
  kind: 0, checkType: 0, param: "", deadline: 1794000000n,
  amount, dependsOn, onFail: 0, vestDays: 0,
});

describe("checker", () => {
  test("fixture deal (C1 depends on C0) is valid with cascade refunds", () => {
    const r = checkDeal(fromFixture(), BigInt(deal.total));
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.statesExplored).toBeGreaterThan(1);
  });

  test("same deal without cascade refunds: money gets stuck", () => {
    const r = checkDeal(fromFixture(), BigInt(deal.total), {
      cascadeRefundOnDependencyFailure: false,
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("Money can get stuck");
    expect(r.errors[0]).toContain("C1");
  });

  test("amounts must add up to the total", () => {
    const r = checkDeal([clause(60n), clause(30n)], 100n);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("add up to 90");
  });

  test("a clause cannot depend on itself", () => {
    const r = checkDeal([clause(100n, 0)], 100n);
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("depends on itself");
  });

  test("circular dependencies are rejected", () => {
    const r = checkDeal([clause(50n, 1), clause(50n, 0)], 100n);
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("circular");
  });

  test("a clause can only depend on an earlier clause (matches deployed contract)", () => {
    const r = checkDeal([clause(50n, 1), clause(50n)], 100n);
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("later clause");
  });

  test("dependency on a missing clause is rejected", () => {
    const r = checkDeal([clause(100n, 3)], 100n);
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("does not exist");
  });

  test("independent clauses are always valid", () => {
    const r = checkDeal([clause(40n), clause(30n), clause(30n)], 100n);
    expect(r.valid).toBe(true);
  });

  test("a clause with zero money is rejected", () => {
    const r = checkDeal([clause(100n), clause(0n)], 100n);
    expect(r.valid).toBe(false);
  });

  test("more than 5 clauses is rejected", () => {
    const six = Array.from({ length: 6 }, () => clause(10n));
    const r = checkDeal(six, 60n);
    expect(r.valid).toBe(false);
  });

  // ---------- V2: disputes on Verified AND Failed, split verdicts, any-link checks ----------

  const typed = (checkType: number, param: string, amount: bigint, dependsOn = NO_DEPENDENCY): ClauseTerms =>
    ({ ...clause(amount, dependsOn), checkType, param });

  test("V2 deal with every supported check type and a dependency is deadlock-free", () => {
    const r = checkDeal(
      [
        typed(0, "", 20n),                          // YouTube posted
        typed(4, "", 20n, 0),                       // link live, after C0
        typed(5, "#ClientTag", 20n),                // page contains text
        typed(6, "", 20n),                          // GitHub PR merged
        typed(7, "Logo uses the brand colours", 20n, 3), // AI check, after C3
      ],
      100n
    );
    expect(r.valid).toBe(true);
    expect(r.summary).toContain("No deadlock");
    expect(r.statesExplored).toBeGreaterThan(100);
  });

  test("a dispute on a Failed clause is modelled and still always ends", () => {
    // with cascade, a disputed Failed dependency can end Released or Refunded and C1 still settles
    const r = checkDeal([clause(50n), clause(50n, 0)], 100n);
    expect(r.valid).toBe(true);
  });

  test("outcomes: every clause can be paid and can be refunded (for the certificate diagram)", () => {
    const r = checkDeal([clause(50n), typed(7, "matches the brief", 50n, 0)], 100n);
    expect(r.outcomes).toEqual([
      { clause: 0, dependsOn: null, check: "YouTube: posted by the freelancer", canBePaid: true, canBeRefunded: true },
      { clause: 1, dependsOn: 0, check: "AI check against the brief (3 models)", canBePaid: true, canBeRefunded: true },
    ]);
  });

  test("unsupported check types are rejected in plain English", () => {
    const r = checkDeal([typed(3, "", 100n)], 100n);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("can't verify yet");
    expect(r.summary).toStartWith("Not safe to sign");
  });

  test("text / criteria checks need their parameter", () => {
    for (const t of [1, 5, 7]) {
      const r = checkDeal([typed(t, "  ", 100n)], 100n);
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toContain("needs the text or criteria");
    }
  });

  test("the stuck-money explanation still names the trapped clause without cascade", () => {
    const r = checkDeal([clause(50n), clause(50n, 0)], 100n, { cascadeRefundOnDependencyFailure: false });
    expect(r.valid).toBe(false);
    expect(r.summary).toContain("Money can get stuck");
  });

  test("result is deterministic (same input, same output)", () => {
    const a = checkDeal(fromFixture(), BigInt(deal.total));
    const b = checkDeal(fromFixture(), BigInt(deal.total));
    expect(a).toEqual(b);
  });
});
