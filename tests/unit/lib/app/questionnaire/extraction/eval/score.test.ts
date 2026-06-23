/**
 * Unit tests for the extraction calibration scorer + golden-set wellformedness.
 *
 * Pure (no LLM): feeds synthetic extractor outputs through the scorer to lock the three calibration
 * axes (provenance, band, covered) and the forbidden-key check, and asserts every golden fixture is
 * internally consistent (its expectation/forbidden keys exist in its own context). The live-model
 * run lives in `scripts/eval/extraction.ts`; this guards the contract that scores it.
 */

import { describe, expect, it } from 'vitest';

import type { AnswerExtraction } from '@/lib/app/questionnaire/extraction/extraction-schema';
import {
  aggregate,
  classifyBand,
  CLEAR_BAND_MIN,
  isCoveredOutput,
  PARTIAL_BAND_MIN,
  scoreFixture,
} from '@/lib/app/questionnaire/extraction/eval/score';
import {
  GOLDEN_FIXTURES,
  type GoldenFixture,
} from '@/lib/app/questionnaire/extraction/eval/golden-set';

/** Build an AnswerExtraction output from sparse answer/fill specs. */
function output(opts: {
  answers?: Array<{ slotKey: string; provenance: string; confidence: number }>;
  fills?: Array<{ dataSlotKey: string; provenance: string; confidence: number }>;
}): AnswerExtraction {
  return {
    answers: (opts.answers ?? []).map((a) => ({
      slotKey: a.slotKey,
      value: 'v',
      confidence: a.confidence,
      provenance: a.provenance as AnswerExtraction['answers'][number]['provenance'],
      rationale: 'r',
    })),
    ...(opts.fills
      ? {
          dataSlotFills: opts.fills.map((f) => ({
            dataSlotKey: f.dataSlotKey,
            value: 'v',
            paraphrase: 'p',
            confidence: f.confidence,
            provenance: f.provenance as AnswerExtraction['answers'][number]['provenance'],
          })),
        }
      : {}),
  };
}

const recommendFixture = GOLDEN_FIXTURES.find((f) => f.id === 'recommend-extremely-unlikely')!;

describe('classifyBand', () => {
  it('buckets at the band boundaries', () => {
    expect(classifyBand(CLEAR_BAND_MIN)).toBe('clear');
    expect(classifyBand(0.95)).toBe('clear');
    // A terse/vague answer (rubric ~0.45–0.6) is partial — worth deepening, still gettable.
    expect(classifyBand(PARTIAL_BAND_MIN)).toBe('partial');
    expect(classifyBand(0.69)).toBe('partial');
    // Below 0.45 is a tangential inference — the new low end the rubric distinguishes.
    expect(classifyBand(0.44)).toBe('unclear');
    expect(classifyBand(0.39)).toBe('unclear');
    expect(classifyBand(0)).toBe('unclear');
  });
});

describe('isCoveredOutput', () => {
  it('covers a direct fill regardless of confidence, else only above the fill threshold', () => {
    expect(isCoveredOutput('direct', 0.1)).toBe(true);
    expect(isCoveredOutput('inferred', 0.4)).toBe(false);
    expect(isCoveredOutput('inferred', 0.5)).toBe(true);
  });
});

describe('scoreFixture — the reported regression', () => {
  it('PASSES when the NPS answer is a correctly-calibrated direct/clear fill', () => {
    const result = scoreFixture(
      recommendFixture,
      output({
        fills: [
          { dataSlotKey: 'workplace_recommendation', provenance: 'direct', confidence: 0.85 },
        ],
        answers: [{ slotKey: 'nps', provenance: 'inferred', confidence: 0.8 }],
      })
    );
    expect(result.pass).toBe(true);
    expect(result.expectations.every((e) => e.pass)).toBe(true);
  });

  it('FAILS on all three axes when the direct answer is mislabelled inferred + under-scored (the bug)', () => {
    const result = scoreFixture(
      recommendFixture,
      output({
        // Exactly the screenshot: inferred / 0.40 for a plainly-stated position.
        fills: [
          { dataSlotKey: 'workplace_recommendation', provenance: 'inferred', confidence: 0.4 },
        ],
        answers: [{ slotKey: 'nps', provenance: 'inferred', confidence: 0.8 }],
      })
    );
    expect(result.pass).toBe(false);
    const fill = result.expectations.find((e) => e.key === 'workplace_recommendation')!;
    expect(fill.provenanceMatch).toBe(false); // inferred ≠ direct
    expect(fill.bandMatch).toBe(false); // unclear ≠ clear
    expect(fill.coveredMatch).toBe(false); // 0.40 inferred is not covered
  });

  it('marks an expectation not found when the model omits it entirely', () => {
    const result = scoreFixture(recommendFixture, output({ answers: [] }));
    const fill = result.expectations.find((e) => e.key === 'workplace_recommendation')!;
    expect(fill.found).toBe(false);
    expect(fill.pass).toBe(false);
  });
});

describe('scoreFixture — forbidden keys (non-answers)', () => {
  const dontKnow = GOLDEN_FIXTURES.find((f) => f.id === 'genuine-dont-know')!;

  it('passes when nothing is emitted for a genuine non-answer', () => {
    const result = scoreFixture(dontKnow, output({}));
    expect(result.pass).toBe(true);
    expect(result.forbiddenEmitted).toEqual([]);
  });

  it('fails when the model invents a fill for a forbidden key', () => {
    const result = scoreFixture(
      dontKnow,
      output({ answers: [{ slotKey: 'top_concern', provenance: 'inferred', confidence: 0.3 }] })
    );
    expect(result.pass).toBe(false);
    expect(result.forbiddenEmitted).toEqual(['top_concern']);
  });
});

describe('aggregate', () => {
  it('rolls per-axis accuracy and splits known gaps from regressions', () => {
    const passing = scoreFixture(
      recommendFixture,
      output({
        fills: [
          { dataSlotKey: 'workplace_recommendation', provenance: 'direct', confidence: 0.85 },
        ],
        answers: [{ slotKey: 'nps', provenance: 'inferred', confidence: 0.8 }],
      })
    );
    const blocker = GOLDEN_FIXTURES.find((f) => f.id === 'direct-free-text-blocker')!;
    const failingRegression = scoreFixture(
      blocker,
      output({ answers: [{ slotKey: 'blocker', provenance: 'inferred', confidence: 0.3 }] })
    );
    const card = aggregate([passing, failingRegression]);
    expect(card.fixtures).toBe(2);
    expect(card.fixturesPassed).toBe(1);
    expect(card.overallAccuracy).toBeGreaterThan(0);
    expect(card.overallAccuracy).toBeLessThan(1);
    expect(card.failedRegressions).toContain('direct-free-text-blocker');
    expect(card.failedKnownGaps).toEqual([]);
  });

  it('reports full accuracy on an empty run without dividing by zero', () => {
    const card = aggregate([]);
    expect(card.overallAccuracy).toBe(1);
    expect(card.expectations).toBe(0);
  });

  it('routes a failing knownGap fixture into failedKnownGaps, not failedRegressions', () => {
    const tangential = GOLDEN_FIXTURES.find((f) => f.id === 'tangential-inference-is-unclear')!;
    expect(tangential.knownGap).toBe(true);
    // Score it deliberately wrong (a confident direct fill ≠ the expected inferred/unclear/uncovered),
    // so the fixture fails — a knownGap failure must land apart from genuine regressions.
    const failing = scoreFixture(
      tangential,
      output({
        fills: [{ dataSlotKey: 'change_readiness', provenance: 'direct', confidence: 0.95 }],
      })
    );
    expect(failing.pass).toBe(false);
    const card = aggregate([failing]);
    expect(card.failedKnownGaps).toContain('tangential-inference-is-unclear');
    expect(card.failedRegressions).toEqual([]);
  });
});

describe('golden set wellformedness', () => {
  const candidateKeys = (f: GoldenFixture) => new Set(f.context.candidateSlots.map((s) => s.key));
  const dataSlotKeys = (f: GoldenFixture) =>
    new Set((f.context.dataSlotCandidates ?? []).map((d) => d.key));

  it('has unique fixture ids', () => {
    const ids = GOLDEN_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every expectation + forbidden key references a slot present in its own context', () => {
    for (const f of GOLDEN_FIXTURES) {
      const answers = candidateKeys(f);
      const slots = dataSlotKeys(f);
      for (const exp of f.expectations) {
        const pool = exp.kind === 'answer' ? answers : slots;
        expect(pool.has(exp.key), `${f.id} → ${exp.kind} ${exp.key}`).toBe(true);
      }
      for (const key of f.forbiddenKeys ?? []) {
        expect(answers.has(key) || slots.has(key), `${f.id} → forbidden ${key}`).toBe(true);
      }
    }
  });

  it('every fixture exercises something (an expectation or a forbidden key)', () => {
    for (const f of GOLDEN_FIXTURES) {
      expect(f.expectations.length + (f.forbiddenKeys?.length ?? 0)).toBeGreaterThan(0);
    }
  });
});
