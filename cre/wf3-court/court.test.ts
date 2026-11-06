import { describe, expect, test } from "bun:test";
import replay from "./replay.json";
import {
  applyAnswer, BASE_SECS, expectedVerdict, HARD_CAP_SECS, reportFields, runRound, shouldRunRound, stateOf,
  WORD_BUDGET, type Transcript,
} from "./court";
import { countWords } from "../lib/llm";

const OPENED = 1_800_000_000;
const fresh = (): Transcript => ({
  v: 1, caseId: "1", dealId: "4", clauseId: 0,
  reason: "The signup form is broken.",
  terms: "Landing page with the client's logo and a working signup form. 100 USDC.",
  evidence: "https://example.com/landing", evidenceText: "Welcome. Sign up: [email] [Join]",
  deadline0: OPENED + BASE_SECS,
  judges: ["Llama (Groq)", "Gemini", "Mistral (OpenRouter)"],
  rounds: [],
});
const replayAsk = (round: number) => (judge: number) => JSON.stringify((replay.rounds as unknown[][])[round]?.[judge] ?? "");
const say = (o: object) => JSON.stringify(o);

describe("AI court rules", () => {
  test("the scripted demo: blind opinions → extension → majority of final votes", () => {
    let t = fresh();
    t = runRound(t, replayAsk(0));
    expect(reportFields(t).bands).toEqual([50, 80, 0]);
    expect(t.rounds[0].extensionGranted).toBe(false);

    t = runRound(t, replayAsk(1));
    expect(reportFields(t).bands).toEqual([80, 80, 50]);
    expect(t.rounds[1].extensionGranted).toBe(true);                  // 2 of 3 asked
    expect(t.rounds[1].wordBudget).toBe(WORD_BUDGET + 100);
    expect(t.rounds[1].deadline).toBe(OPENED + BASE_SECS + 60);
    expect(shouldRunRound(t, OPENED + 60)).toBe(true);

    t = runRound(t, replayAsk(2));
    const f = reportFields(t);
    expect(f.isFinal).toEqual([true, true, true]);
    expect(expectedVerdict(f.bands)).toBe(80);                          // not first-to-majority: final votes
    expect(shouldRunRound(t, OPENED + 90)).toBe(false);                 // all final → stop
    expect(f.citedMask).toEqual([0b011, 0b111, 0b110]);
  });

  test("statements are cut to the word budget and the running total never exceeds it", () => {
    const long = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
    const turn = applyAnswer(say({ band: 80, statement: long, cited: [1] }), undefined, WORD_BUDGET, false);
    expect(turn.wordsUsed).toBe(WORD_BUDGET);
    expect(countWords(turn.statement)).toBe(WORD_BUDGET);
    expect(turn.note).toContain("cut to 200");
    const next = applyAnswer(say({ band: 80, statement: "more words here", cited: [1] }), turn, WORD_BUDGET, false);
    expect(next.wordsUsed).toBe(WORD_BUDGET);                           // nothing left to say
    expect(next.statement).toBe("");
  });

  test("a judge cannot change its band without citing evidence", () => {
    const prev = applyAnswer(say({ band: 0, statement: "refund", cited: [2] }), undefined, WORD_BUDGET, false);
    const flip = applyAnswer(say({ band: 100, statement: "changed my mind", cited: [] }), prev, WORD_BUDGET, false);
    expect(flip.band).toBe(0);
    expect(flip.note).toContain("no evidence cited");
  });

  test("evidence the case doesn't have is ignored in citations", () => {
    const t = applyAnswer(say({ band: 50, statement: "x", cited: [1, 7, 1, -1, "2"] }), undefined, WORD_BUDGET, false);
    expect(t.cited).toEqual([1, 2]);
  });

  test("an invalid answer (prompt injection, wrong band, no JSON) is a skipped turn", () => {
    for (const raw of ["", "I refuse", say({ band: 70 }), say({ band: "100" })]) {
      const t = applyAnswer(raw, undefined, WORD_BUDGET, false);
      expect(t.band).toBe(50);
      expect(t.note).toContain("skipped");
    }
  });

  test("final judges stay final and silent", () => {
    let t = fresh();
    t = runRound(t, (j) => say({ band: 100, statement: "done", cited: [1], isFinal: j === 0 }));
    let asked: number[] = [];
    t = runRound(t, (j) => { asked.push(j); return say({ band: 100, statement: "ok", cited: [1] }); });
    expect(asked).toEqual([1, 2]);
    expect(t.rounds[1].judges[0]).toMatchObject({ band: 100, isFinal: true, statement: "" });
  });

  test("last round forces everyone final; max rounds is 3 without extensions", () => {
    let t = fresh();
    const ask = () => say({ band: 50, statement: "hm", cited: [0] });
    t = runRound(t, ask);
    t = runRound(t, ask);
    t = runRound(t, ask);
    expect(t.rounds[2].judges.every((j) => j.isFinal)).toBe(true);
    expect(shouldRunRound(t, OPENED)).toBe(false);
  });

  test("extensions stop at 2 and the deadline never passes the 5-minute hard cap", () => {
    let t = fresh();
    const ask = () => say({ band: 50, statement: "need more", cited: [0], wantsExtend: true });
    for (let i = 0; i < 4; i++) t = runRound(t, ask);
    const s = stateOf(t);
    expect(s.extensions).toBe(2);
    expect(s.wordBudget).toBe(WORD_BUDGET + 200);
    expect(s.deadline).toBeLessThanOrEqual(OPENED + HARD_CAP_SECS);
    expect(s.deadline).toBe(OPENED + BASE_SECS + 120);
  });

  test("no round is started too close to the deadline", () => {
    const t = fresh();
    expect(shouldRunRound(t, OPENED + BASE_SECS - 10)).toBe(false);
    expect(shouldRunRound(t, OPENED)).toBe(true);
  });

  test("verdict helper matches the contract rule", () => {
    expect(expectedVerdict([80, 80, 0])).toBe(80);
    expect(expectedVerdict([0, 50, 100])).toBe(50);
    expect(expectedVerdict([100, 100, 100])).toBe(100);
  });
});
