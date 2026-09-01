/**
 * `assessSectionCompletion` — the per-section close gate.
 *
 * This is a thin wrapper over F4.5's `assessCompletion`, so the tests that matter are the ones
 * proving the wrapper does not quietly lose what it is wrapping: the required gate, the confidence
 * floor, and the ordering. Plus the two behaviours that are the wrapper's own — the turn cap, and
 * the fact that answers from OTHER sections must not count toward this one.
 */

import { describe, expect, it } from 'vitest';

import { assessSectionCompletion } from '@/lib/app/questionnaire/sections/close';
import { DEFAULT_SECTIONED_INTERVIEW_SETTINGS } from '@/lib/app/questionnaire/sections/settings';
import type { InterviewSection } from '@/lib/app/questionnaire/sections/types';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import type { AnsweredView, QuestionView } from '@/lib/app/questionnaire/selection/types';

function question(key: string, overrides: Partial<QuestionView> = {}): QuestionView {
  return {
    id: `id_${key}`,
    key,
    sectionId: 'sec',
    sectionOrdinal: 0,
    ordinal: 0,
    weight: 1,
    required: false,
    type: 'free_text',
    tagIds: [],
    ...overrides,
  };
}

const SECTION: InterviewSection = {
  key: 'context',
  label: 'Context',
  ordinal: 0,
  source: 'topics',
  questionKeys: ['q1', 'q2'],
  dataSlotKeys: [],
};

function assess(opts: {
  questions?: QuestionView[];
  answered?: AnsweredView[];
  settings?: Partial<typeof DEFAULT_SECTIONED_INTERVIEW_SETTINGS>;
  turnsInSection?: number;
  section?: InterviewSection;
}) {
  return assessSectionCompletion({
    section: opts.section ?? SECTION,
    questions: opts.questions ?? [question('q1'), question('q2')],
    answered: opts.answered ?? [],
    config: DEFAULT_QUESTIONNAIRE_CONFIG,
    settings: {
      ...DEFAULT_SECTIONED_INTERVIEW_SETTINGS,
      enabled: true,
      ...opts.settings,
    },
    turnsInSection: opts.turnsInSection ?? 0,
    sessionId: 'sess_1',
  });
}

describe('assessSectionCompletion', () => {
  it('will not close a section with nothing answered', () => {
    const result = assess({});
    expect(result.canClose).toBe(false);
    expect(result.assessment.kind).toBe('not_ready');
  });

  it('closes at the default bar only once every question in the section is answered', () => {
    // `closeCoverage` defaults to 1.0, so one of two is not enough.
    expect(assess({ answered: [{ questionId: 'id_q1', confidence: 0.9 }] }).canClose).toBe(false);
    expect(
      assess({
        answered: [
          { questionId: 'id_q1', confidence: 0.9 },
          { questionId: 'id_q2', confidence: 0.9 },
        ],
      }).canClose
    ).toBe(true);
  });

  it('closes at a lowered coverage bar', () => {
    const result = assess({
      settings: { closeCoverage: 0.5 },
      answered: [{ questionId: 'id_q1', confidence: 0.9 }],
    });
    expect(result.canClose).toBe(true);
  });

  it('requires BOTH bars, unlike the early-finish pair it superficially resembles', () => {
    // Deliberately an AND, inherited from `assessCompletion` rather than restated. Early finish ORs
    // its two bars because it is a respondent's right to leave; this is an author's statement about
    // when a section is genuinely covered.
    const meetsCountOnly = assess({
      settings: { closeMinAnswered: 1, closeCoverage: 1 },
      answered: [{ questionId: 'id_q1', confidence: 0.9 }],
    });
    expect(meetsCountOnly.assessment.answeredCount).toBe(1);
    expect(meetsCountOnly.canClose).toBe(false);

    const meetsCoverageOnly = assess({
      settings: { closeMinAnswered: 5, closeCoverage: 0.5 },
      answered: [{ questionId: 'id_q1', confidence: 0.9 }],
    });
    expect(meetsCoverageOnly.canClose).toBe(false);

    const meetsBoth = assess({
      settings: { closeMinAnswered: 2, closeCoverage: 1 },
      answered: [
        { questionId: 'id_q1', confidence: 0.9 },
        { questionId: 'id_q2', confidence: 0.9 },
      ],
    });
    expect(meetsBoth.canClose).toBe(true);
  });

  it('treats a count bar of 0 as no criterion, so it cannot tighten the coverage bar', () => {
    const result = assess({
      settings: { closeMinAnswered: 0, closeCoverage: 0.5 },
      answered: [{ questionId: 'id_q1', confidence: 0.9 }],
    });
    expect(result.canClose).toBe(true);
  });

  it('ignores answers belonging to other sections', () => {
    // The single most likely way to build this wrong: leaving the whole session's answers in makes
    // every section read as more complete than it is.
    const result = assess({
      questions: [question('q1'), question('q2'), question('elsewhere')],
      answered: [
        { questionId: 'id_elsewhere', confidence: 0.9 },
        { questionId: 'id_q1', confidence: 0.9 },
      ],
    });
    expect(result.assessment.answeredCount).toBe(1);
    expect(result.canClose).toBe(false);
  });

  it('ignores questions belonging to other sections', () => {
    const result = assess({
      questions: [question('q1'), question('q2'), question('elsewhere', { required: true })],
      answered: [
        { questionId: 'id_q1', confidence: 0.9 },
        { questionId: 'id_q2', confidence: 0.9 },
      ],
    });
    // The other section's required question must not block this one.
    expect(result.blockedOnRequired).toBe(false);
    expect(result.canClose).toBe(true);
  });

  it('blocks on an unanswered required question even at full coverage of the rest', () => {
    const result = assess({
      questions: [question('q1', { weight: 1 }), question('q2', { required: true, weight: 0 })],
      answered: [{ questionId: 'id_q1', confidence: 0.9 }],
    });
    expect(result.assessment.kind).toBe('blocked_on_required');
    expect(result.blockedOnRequired).toBe(true);
    expect(result.canClose).toBe(false);
  });

  it('lets the turn cap release a section blocked on a required question', () => {
    // The escape hatch, and the reason a sequential run cannot dead-end.
    const result = assess({
      questions: [question('q1'), question('q2', { required: true })],
      answered: [],
      settings: { maxTurnsPerSection: 4 },
      turnsInSection: 4,
    });
    expect(result.canClose).toBe(true);
    expect(result.assessment.capReached).toBe(true);
    // Not reported as blocked once it is releasable: the UI must not say "one thing still needed"
    // beside an unlocked control.
    expect(result.blockedOnRequired).toBe(false);
  });

  it('does not apply a cap of 0, which means off', () => {
    const result = assess({ settings: { maxTurnsPerSection: 0 }, turnsInSection: 99 });
    expect(result.canClose).toBe(false);
    expect(result.assessment.capReached).toBe(false);
  });

  it('does not treat the turn count as an answered count', () => {
    // `assessCompletion`'s own cap compares against ANSWERS. Feeding the turn budget to it would
    // close a section the moment its answered count reached the budget, which is a different thing.
    const result = assess({
      settings: { maxTurnsPerSection: 10 },
      turnsInSection: 3,
      answered: [{ questionId: 'id_q1', confidence: 0.9 }],
    });
    expect(result.canClose).toBe(false);
  });

  it('closes a section scope left with no questions rather than stranding the respondent', () => {
    const result = assess({
      section: { ...SECTION, questionKeys: [], dataSlotKeys: ['s1'] },
      questions: [question('q1')],
    });
    expect(result.canClose).toBe(true);
  });

  it('keeps the confidence floor, so a tentative capture cannot close a section out', () => {
    const result = assess({
      questions: [question('q1'), question('q2')],
      answered: [
        // Both below the default 0.5 floor: opportunistic guesses, not corroborated answers.
        { questionId: 'id_q1', confidence: 0.3 },
        { questionId: 'id_q2', confidence: 0.4 },
      ],
    });
    expect(result.canClose).toBe(false);
    expect(result.assessment.coverage).toBe(0);
    // The progress figure still shows movement, which is the two-figure split F4.5 already draws.
    expect(result.assessment.displayCoverage).toBeGreaterThan(0);
  });
});
