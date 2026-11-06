// Settld AI court: the deliberation rules, as pure functions (no CRE, no network).
// main.ts wires these into the CRE workflow; court.test.ts tests them with bun.
//
// Rules (docs/INTERFACES.md, V2 AICourt; the contract enforces the same limits on-chain):
//   - 3 judges. Round 0 = independent, blind opinions. Later rounds = discussion.
//   - Each judge has a 200-word budget for the WHOLE case (counted and cut off here, checked on-chain).
//   - If 2 of 3 judges ask for more words: +100 words each and +60 s (at most 2 times, hard cap 5 min).
//   - A judge may change its band only by citing evidence. Final judges stop talking.
//   - Max 3 rounds (+1 per extension). On the last round everyone must vote final.
//   - The verdict (majority of the LATEST bands, else the middle band) is computed by the contract.

import { countWords, evidence, GUARDRAIL, parseJson, truncateWords } from "../lib/llm";

export const WORD_BUDGET = 200;
export const EXTEND_WORDS = 100;
export const EXTEND_SECS = 60;
export const BASE_SECS = 180;
export const HARD_CAP_SECS = 300;
export const MAX_EXT = 2;
export const MAX_ROUNDS = 3;
export const BANDS = [0, 50, 80, 100] as const;
export const EVIDENCE_IDS = [0, 1, 2] as const; // 0 clause terms, 1 submitted evidence, 2 dispute reason

export type JudgeTurn = {
  band: number;
  statement: string;
  cited: number[];
  wantsExtend: boolean;
  isFinal: boolean;
  wordsUsed: number; // running total
  note?: string;     // why WF3 changed or skipped this turn (shown in the courtroom UI)
};

export type Round = {
  round: number;
  judges: JudgeTurn[];
  extensionGranted: boolean;
  wordBudget: number; // budget AFTER this round
  deadline: number;   // deadline AFTER this round (unix seconds)
};

export type Transcript = {
  v: 1;
  caseId: string;
  dealId: string;
  clauseId: number;
  reason: string;       // evidence 2
  terms: string;        // evidence 0 (plain-English clause)
  evidence: string;     // the submitted evidence string (link / id)
  evidenceText: string; // evidence 1 as the judges read it
  deadline0: number;    // CaseOpened deadline (openedAt + BASE_SECS)
  judges: string[];
  rounds: Round[];
};

export type CourtState = {
  nextRound: number;
  extensions: number;
  wordBudget: number;
  deadline: number;
  maxRounds: number;
  allFinal: boolean;
};

export function stateOf(t: Transcript): CourtState {
  const extensions = t.rounds.filter((r) => r.extensionGranted).length;
  const openedAt = t.deadline0 - BASE_SECS;
  const last = t.rounds[t.rounds.length - 1];
  return {
    nextRound: t.rounds.length,
    extensions,
    wordBudget: WORD_BUDGET + EXTEND_WORDS * extensions,
    deadline: Math.min(t.deadline0 + EXTEND_SECS * extensions, openedAt + HARD_CAP_SECS),
    maxRounds: MAX_ROUNDS + extensions,
    allFinal: !!last && last.judges.every((j) => j.isFinal),
  };
}

/** Should WF3 run another round? (it must also land before the deadline; `marginSecs` leaves time for the tx) */
export function shouldRunRound(t: Transcript, nowSec: number, marginSecs = 20): boolean {
  const s = stateOf(t);
  return !s.allFinal && s.nextRound < s.maxRounds && nowSec + marginSecs < s.deadline;
}

const BAND_MEANING =
  "Bands = the freelancer's share of this clause's money: 0 = full refund to the client, 50 = half, " +
  "80 = mostly delivered, 100 = pay the freelancer in full.";

export function systemPrompt(): string {
  return [
    GUARDRAIL,
    "You are one of three AI judges in Settld's court. You decide how much of ONE disputed clause the freelancer earned.",
    BAND_MEANING,
    "Evidence ids: 0 = clause terms, 1 = submitted work, 2 = the dispute reason.",
    "Be concise and specific. Cite the evidence ids you rely on.",
  ].join("\n");
}

export function userPrompt(t: Transcript, judge: number, wordsLeft: number, round: number, lastRound: boolean): string {
  const parts = [
    `CASE ${t.caseId}: a dispute over clause ${t.clauseId} of deal ${t.dealId}.`,
    evidence(0, "clause terms", t.terms),
    evidence(1, "submitted work", t.evidenceText || "(the submitted work could not be read)"),
    evidence(2, "dispute reason", t.reason),
  ];
  if (round === 0) {
    parts.push("ROUND 0: give your own independent opinion. You have not seen the other judges.");
  } else {
    parts.push(`ROUND ${round}: the discussion so far (latest statement of each judge):`);
    t.judges.forEach((name, i) => {
      const said = latestStatement(t, i);
      const band = latestTurn(t, i)?.band;
      parts.push(`${i === judge ? "You" : name} (band ${band}): "${said || "(no statement)"}"`);
    });
    parts.push("Reply to the other judges. You may change your band only if you cite evidence ids that justify it.");
  }
  parts.push(
    `You have ${wordsLeft} words left for the whole case; longer statements are cut off.`,
    lastRound
      ? "This is the LAST round: set isFinal to true and give your final band."
      : 'Set isFinal to true when you will not change your mind. Set wantsExtend to true only if you need more words to explain.',
    'Reply ONLY with JSON: {"band": 0|50|80|100, "statement": "...", "cited": [ids], "wantsExtend": true|false, "isFinal": true|false}'
  );
  return parts.join("\n\n");
}

export const latestTurn = (t: Transcript, judge: number): JudgeTurn | undefined =>
  t.rounds.length ? t.rounds[t.rounds.length - 1].judges[judge] : undefined;

function latestStatement(t: Transcript, judge: number): string {
  for (let r = t.rounds.length - 1; r >= 0; r--) {
    const s = t.rounds[r].judges[judge]?.statement;
    if (s) return s;
  }
  return "";
}

type Answer = { band?: unknown; statement?: unknown; cited?: unknown; wantsExtend?: unknown; isFinal?: unknown };

/** Turn a raw model answer into a judge turn, enforcing every rule. */
export function applyAnswer(
  raw: string,
  prev: JudgeTurn | undefined,
  wordBudget: number,
  lastRound: boolean
): JudgeTurn {
  const prevWords = prev?.wordsUsed ?? 0;
  const prevBand = prev?.band ?? 50;
  const a = parseJson<Answer>(raw);

  if (!a || !BANDS.includes(a.band as (typeof BANDS)[number])) {
    return {
      band: prevBand, statement: "", cited: [], wantsExtend: false, isFinal: lastRound,
      wordsUsed: prevWords, note: "skipped: no valid answer",
    };
  }

  const cited = Array.isArray(a.cited)
    ? [...new Set(a.cited.map(Number).filter((n) => (EVIDENCE_IDS as readonly number[]).includes(n)))].sort()
    : [];
  let band = a.band as number;
  let note: string | undefined;
  if (prev && band !== prev.band && cited.length === 0) {
    band = prev.band;
    note = "band change rejected: no evidence cited";
  }

  const wordsLeft = Math.max(0, wordBudget - prevWords);
  const said = typeof a.statement === "string" ? a.statement : "";
  const statement = truncateWords(said, wordsLeft);
  if (countWords(said) > wordsLeft) note = note ?? `statement cut to ${wordsLeft} words`;

  return {
    band,
    statement,
    cited,
    wantsExtend: a.wantsExtend === true,
    isFinal: a.isFinal === true || lastRound,
    wordsUsed: prevWords + countWords(statement),
    note,
  };
}

/** Run one round. `ask(judge, system, user)` returns the model's raw answer. */
export function runRound(t: Transcript, ask: (judge: number, system: string, user: string) => string): Transcript {
  const s = stateOf(t);
  const round = s.nextRound;
  const lastRound = round >= s.maxRounds - 1;
  const system = systemPrompt();

  const judges = t.judges.map((_, i) => {
    const prev = latestTurn(t, i);
    if (prev?.isFinal) {
      // a final judge keeps its vote and stays silent (saves a model call)
      return { ...prev, statement: "", wantsExtend: false, note: undefined };
    }
    const wordsLeft = Math.max(0, s.wordBudget - (prev?.wordsUsed ?? 0));
    return applyAnswer(ask(i, system, userPrompt(t, i, wordsLeft, round, lastRound)), prev, s.wordBudget, lastRound);
  });

  const wants = judges.filter((j) => j.wantsExtend).length;
  const extensionGranted = wants >= 2 && s.extensions < MAX_EXT;
  if (extensionGranted && lastRound) {
    // the extension adds a round, so nobody is forced final this round
    judges.forEach((j, i) => {
      const prev = latestTurn(t, i);
      if (j.isFinal && !prev?.isFinal) j.isFinal = false;
    });
  }

  const after: Transcript = { ...t, rounds: [...t.rounds] };
  const ext = s.extensions + (extensionGranted ? 1 : 0);
  const openedAt = t.deadline0 - BASE_SECS;
  after.rounds.push({
    round,
    judges,
    extensionGranted,
    wordBudget: WORD_BUDGET + EXTEND_WORDS * ext,
    deadline: Math.min(t.deadline0 + EXTEND_SECS * ext, openedAt + HARD_CAP_SECS),
  });
  return after;
}

/** Fields for the on-chain round report (the transcript hash is added by the caller). */
export function reportFields(t: Transcript) {
  const r = t.rounds[t.rounds.length - 1];
  const three = <T>(f: (j: JudgeTurn) => T) => r.judges.map(f) as [T, T, T];
  return {
    round: r.round,
    bands: three((j) => j.band),
    wordsUsed: three((j) => j.wordsUsed),
    wantsExtend: three((j) => j.wantsExtend),
    isFinal: three((j) => j.isFinal),
    citedMask: three((j) => j.cited.reduce((m, id) => m | (1 << id), 0)),
  };
}

/** What the contract will decide from these bands (for logs / UI; the contract is the source of truth). */
export function expectedVerdict(bands: number[]): number {
  for (const b of bands) if (bands.filter((x) => x === b).length >= 2) return b;
  return [...bands].sort((a, b) => a - b)[1];
}
