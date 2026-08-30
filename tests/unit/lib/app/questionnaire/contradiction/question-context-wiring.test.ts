/**
 * The detector's question context → capability args wiring (F4.3 follow-up).
 *
 * THE GAP THIS EXISTS TO CLOSE — the same one the glossary seam fell into (see
 * `glossary/capability-args-wiring.test.ts`). `BaseCapability.validate` safe-parses args against a
 * NON-STRICT `z.object`, so a key the schema does not declare is silently STRIPPED: the invoker
 * goes on passing it, the prompt builder goes on supporting it, every prompt test goes on passing,
 * and the detector never sees it. That is exactly how the glossary shipped inert.
 *
 * `activeQuestion` is what stops session 5GB3M8SS from happening again — "70" to hours actually
 * worked and "40 hrs" to hours that would be sustainable, put to the respondent as a contradiction
 * because the detector could not see which question the second number answered. If that key is
 * ever dropped at this boundary the fix silently reverts, so it is asserted here rather than only
 * where the prompt is built.
 *
 * @see lib/app/questionnaire/capabilities/detect-contradictions.ts
 * @see .context/app/questionnaire/contradiction-detection.md
 */

import { describe, it, expect } from 'vitest';

import {
  AppDetectContradictionsCapability,
  MAX_DETECTION_TRANSCRIPT,
} from '@/lib/app/questionnaire/capabilities/detect-contradictions';

const BASE_ARGS = {
  slots: [
    {
      key: 'current_weekly_work_hours',
      prompt: 'How many hours per week are you actually working?',
      type: 'numeric' as const,
      required: false,
    },
  ],
  answers: [{ slotKey: 'current_weekly_work_hours', value: 70, confidence: 0.917 }],
  mode: 'probe' as const,
  windowN: 3,
  currentStatement: '40 hrs',
};

const ACTIVE_QUESTION = {
  key: 'sustainable_weekly_hours',
  prompt: 'What would a sustainable total number of weekly hours look like for you?',
};

/** Reach the capability's protected Zod schema — the thing that silently drops undeclared keys. */
function schema() {
  const instance = new AppDetectContradictionsCapability();
  return (instance as unknown as { schema: { parse: (v: unknown) => Record<string, unknown> } })
    .schema;
}

describe('detect-contradictions argsSchema — the question being answered', () => {
  it('preserves activeQuestion instead of silently stripping it', () => {
    const parsed = schema().parse({ ...BASE_ARGS, activeQuestion: ACTIVE_QUESTION });

    expect(parsed.activeQuestion).toEqual(ACTIVE_QUESTION);
  });

  it('accepts an omitted activeQuestion — data-slot mode has no single active question', () => {
    const parsed = schema().parse({ ...BASE_ARGS });

    expect(parsed.activeQuestion).toBeUndefined();
  });

  it('rejects a half-filled activeQuestion rather than passing a key with no question text', () => {
    // A key alone tells the model nothing it can reason with; the prompt renders the TEXT.
    expect(() => schema().parse({ ...BASE_ARGS, activeQuestion: { key: 'k' } })).toThrow();
    expect(() => schema().parse({ ...BASE_ARGS, activeQuestion: { prompt: 'p' } })).toThrow();
  });

  it('preserves the recent transcript', () => {
    const recentMessages = ['i do 70 hrs per week', 'If you imagine a more sustainable rhythm…'];
    const parsed = schema().parse({ ...BASE_ARGS, recentMessages });

    expect(parsed.recentMessages).toEqual(recentMessages);
  });

  it('bounds the transcript, so no caller can hand the detector a whole conversation', () => {
    // The transcript is context for reading ONE message. Prose that was never an answer is where a
    // detector invents conflicts, so this cap is a guard and not a performance tweak.
    const tooMany = Array.from({ length: MAX_DETECTION_TRANSCRIPT + 1 }, (_, i) => `line ${i}`);

    expect(() => schema().parse({ ...BASE_ARGS, recentMessages: tooMany })).toThrow();
  });
});

describe('detect-contradictions provenance redaction', () => {
  it('keeps the question key but never the respondent transcript', () => {
    const capability = new AppDetectContradictionsCapability();
    const { args } = capability.redactProvenance(
      { ...BASE_ARGS, activeQuestion: ACTIVE_QUESTION, recentMessages: ['i do 70 hrs per week'] },
      { success: true, data: { findings: [], droppedCount: 0, costUsd: 0 } }
    );

    const safe = args as Record<string, unknown>;
    // The question is authored by the admin — safe, and it is the field that explains after the
    // fact why a finding was or was not raised.
    expect(safe.activeQuestionKey).toBe('sustainable_weekly_hours');
    // The transcript is the respondent's own words: count only, never the text.
    expect(safe.recentMessageCount).toBe(1);
    expect(JSON.stringify(safe)).not.toContain('70 hrs per week');
  });
});
