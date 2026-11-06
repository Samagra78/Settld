// Settld deadlock checker (v0)
//
// Proves a deal can never trap money, BEFORE anyone funds it.
// Pure and deterministic (no network, no randomness, no clock) so every
// Chainlink CRE node can run it inside WF0 and get the same answer.
//
// Two kinds of checks:
//   1. Static rules  — amounts add up, dependencies point at real clauses, no cycles.
//   2. Reachability  — explore every state the deal can reach and prove that from
//                      EVERY reachable state, all money can still end up paid or refunded.

import type { ClauseTerms } from "./spec";

// Clause lifecycle (must match the contract's state machine — see docs/INTERFACES.md)
export const Status = {
  Pending: 0,   // waiting for the creator to submit
  Submitted: 1, // submitted, waiting for Chainlink to verify
  Verified: 2,  // verified, dispute window running
  Failed: 3,    // check failed or deadline missed
  Disputed: 4,  // frozen, waiting for the jury
  Released: 5,  // paid to the creator (final)
  Refunded: 6,  // returned to the brand (final)
  // Not a stored contract status: "Verified and the dispute window has closed".
  // The checker needs it because a dispute is only possible inside the window.
  WindowClosed: 7,
} as const;
type StatusValue = (typeof Status)[keyof typeof Status];

const STATUS_NAME: Record<number, string> = {
  0: "Pending", 1: "Submitted", 2: "Verified", 3: "Failed",
  4: "Disputed", 5: "Released", 6: "Refunded", 7: "Verified (window closed)",
};

export const NO_DEPENDENCY = 255;
export const MAX_CLAUSES = 5;

export type CheckerOptions = {
  // Contract rule: if a clause's dependency ends up Refunded, the dependent clause
  // can be refunded too. Without this rule a failed dependency traps the dependent
  // clause's money forever — the checker will report it.
  cascadeRefundOnDependencyFailure: boolean;
};

export const DEFAULT_OPTIONS: CheckerOptions = {
  cascadeRefundOnDependencyFailure: true,
};

export type CheckResult = {
  valid: boolean;
  errors: string[];        // plain-English reasons (empty when valid)
  statesExplored: number;
};

const isFinal = (s: number) => s === Status.Released || s === Status.Refunded;

// Every move one clause can make from a given deal state.
// This is the transition table — it must mirror the contract exactly.
function nextStates(
  state: StatusValue[],
  terms: ClauseTerms[],
  opts: CheckerOptions
): StatusValue[][] {
  const out: StatusValue[][] = [];
  const move = (i: number, to: StatusValue) => {
    const next = state.slice();
    next[i] = to;
    out.push(next);
  };

  for (let i = 0; i < state.length; i++) {
    const s = state[i];
    const dep = terms[i].dependsOn;
    const depStatus = dep === NO_DEPENDENCY ? undefined : state[dep];

    switch (s) {
      case Status.Pending:
        move(i, Status.Submitted);      // creator submits evidence
        move(i, Status.Failed);         // deadline passes with no submission
        break;
      case Status.Submitted:
        move(i, Status.Verified);       // Chainlink: check passed
        move(i, Status.Failed);         // Chainlink: check failed (or report timeout)
        break;
      case Status.Verified:
        move(i, Status.Disputed);       // brand disputes inside the window
        move(i, Status.WindowClosed);   // window passes with no dispute
        break;
      case Status.WindowClosed:
        // release only once the dependency has been released (or there is none)
        if (depStatus === undefined || depStatus === Status.Released) {
          move(i, Status.Released);
        }
        break;
      case Status.Disputed:
        // jury decides; release still needs the dependency released
        if (depStatus === undefined || depStatus === Status.Released) {
          move(i, Status.Released);
        }
        move(i, Status.Refunded);
        break;
      case Status.Failed:
        move(i, Status.Refunded);       // onFail = Refund
        break;
    }

    // cascade: a non-final clause whose dependency was refunded may be refunded
    if (
      opts.cascadeRefundOnDependencyFailure &&
      !isFinal(s) &&
      depStatus === Status.Refunded
    ) {
      move(i, Status.Refunded);
    }
  }
  return out;
}

function describe(state: number[]): string {
  return state.map((s, i) => `C${i}=${STATUS_NAME[s]}`).join(", ");
}

// ---------- static rules ----------
function staticErrors(terms: ClauseTerms[], total: bigint): string[] {
  const errors: string[] = [];

  if (terms.length === 0) errors.push("The deal has no clauses.");
  if (terms.length > MAX_CLAUSES) {
    errors.push(`The deal has ${terms.length} clauses; the maximum is ${MAX_CLAUSES}.`);
  }

  const sum = terms.reduce((acc, t) => acc + t.amount, 0n);
  if (sum !== total) {
    errors.push(`Clause amounts add up to ${sum}, but the deal total is ${total}.`);
  }

  terms.forEach((t, i) => {
    if (t.amount <= 0n) errors.push(`C${i} has no money assigned to it.`);
    if (t.dependsOn !== NO_DEPENDENCY) {
      if (t.dependsOn === i) errors.push(`C${i} depends on itself.`);
      else if (t.dependsOn >= terms.length) {
        errors.push(`C${i} depends on C${t.dependsOn}, which does not exist.`);
      } else if (t.dependsOn > i) {
        // the deployed ClauseEscrow only accepts dependencies on EARLIER clauses
        errors.push(
          `C${i} depends on C${t.dependsOn}, a later clause. A clause can only depend on an earlier one.`
        );
      }
    }
  });

  // cycles: follow dependsOn from each clause
  terms.forEach((_, start) => {
    const seen = new Set<number>();
    let cur = start;
    while (cur !== NO_DEPENDENCY && cur < terms.length) {
      if (seen.has(cur)) {
        if (cur === start && terms[start].dependsOn !== start) {
          errors.push(`C${start} is part of a circular dependency.`);
        }
        break;
      }
      seen.add(cur);
      cur = terms[cur].dependsOn;
    }
  });

  return errors;
}

// ---------- main entry ----------
export function checkDeal(
  terms: ClauseTerms[],
  total: bigint,
  opts: CheckerOptions = DEFAULT_OPTIONS
): CheckResult {
  const errors = staticErrors(terms, total);
  // don't explore a structurally broken deal
  if (errors.length > 0) return { valid: false, errors, statesExplored: 0 };

  // 1) explore every reachable state from "all Pending"
  const start = terms.map(() => Status.Pending) as StatusValue[];
  const key = (s: number[]) => s.join(",");
  const reachable = new Map<string, StatusValue[]>([[key(start), start]]);
  const edges = new Map<string, string[]>();
  const queue: StatusValue[][] = [start];

  while (queue.length > 0) {
    const s = queue.shift()!;
    const k = key(s);
    const nexts = nextStates(s, terms, opts);
    edges.set(k, nexts.map(key));
    for (const n of nexts) {
      const nk = key(n);
      if (!reachable.has(nk)) {
        reachable.set(nk, n);
        queue.push(n);
      }
    }
  }

  // 2) work backwards from "everything paid or refunded"
  const canFinish = new Set<string>();
  for (const [k, s] of reachable) {
    if (s.every(isFinal)) canFinish.add(k);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [k, outs] of edges) {
      if (!canFinish.has(k) && outs.some((o) => canFinish.has(o))) {
        canFinish.add(k);
        changed = true;
      }
    }
  }

  // 3) any reachable state that can't finish = money can get stuck.
  //    Pick the clearest example: the stuck state with the most clauses already settled.
  const stuckStates = [...reachable.entries()].filter(([k]) => !canFinish.has(k));
  if (stuckStates.length > 0) {
    stuckStates.sort(
      ([, a], [, b]) => b.filter(isFinal).length - a.filter(isFinal).length
    );
    const [, s] = stuckStates[0];

    // which clauses can never reach Released/Refunded from this state?
    const seen = new Set<string>([key(s)]);
    const q: StatusValue[][] = [s];
    const canSettle = new Set<number>();
    while (q.length > 0) {
      const cur = q.shift()!;
      cur.forEach((st, i) => { if (isFinal(st)) canSettle.add(i); });
      for (const n of nextStates(cur, terms, opts)) {
        const nk = key(n);
        if (!seen.has(nk)) { seen.add(nk); q.push(n); }
      }
    }

    const stuck = s
      .map((_, i) => i)
      .filter((i) => !canSettle.has(i))
      .map((i) => {
        const dep = terms[i].dependsOn;
        const why =
          dep !== NO_DEPENDENCY && s[dep] === Status.Refunded
            ? ` — it only pays out after C${dep} is paid, but C${dep} was refunded`
            : "";
        return `C${i}'s ${terms[i].amount} units can never be paid or refunded${why}`;
      });
    errors.push(
      `Money can get stuck. Example: [${describe(s)}]: ${stuck.join("; ")}.` +
        ` Fix: add a rule that refunds a clause when the clause it depends on is refunded.`
    );
  }

  return { valid: errors.length === 0, errors, statesExplored: reachable.size };
}
