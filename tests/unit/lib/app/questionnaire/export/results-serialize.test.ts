/**
 * Unit test: result-export serialisers (F8.2).
 *
 * Pure model-in / string-or-object-out. Asserts the CSV is one row per session ×
 * question (unanswered slots → empty cells), that every cell is run through the
 * formula-injection-safe `csvEscape`, that `renderAnswerValue` shapes each value kind,
 * and that the JSON export is the faithful graph (turns + provenance preserved). The
 * anonymous-mode redaction itself lives in the loader; here we confirm the serialisers
 * carry through whatever the model says (null respondent → empty cell, `turns: []`).
 */

import { describe, it, expect } from 'vitest';

import {
  RESULTS_CSV_COLUMNS,
  renderAnswerValue,
  toResultsCsv,
  toResultsJson,
} from '@/lib/app/questionnaire/export/results-serialize';
import type { ResultsExportModel } from '@/lib/app/questionnaire/export/results-types';

function model(overrides: Partial<ResultsExportModel> = {}): ResultsExportModel {
  return {
    versionId: 'v1',
    versionNumber: 2,
    questionnaireTitle: 'Onboarding',
    range: { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
    anonymous: false,
    capped: false,
    questions: [
      {
        questionId: 'q1',
        key: 'role',
        prompt: 'Your role?',
        type: 'free_text',
        sectionTitle: 'About you',
        required: true,
      },
      {
        questionId: 'q2',
        key: 'rating',
        prompt: 'Rate us',
        type: 'numeric',
        sectionTitle: 'Feedback',
        required: false,
      },
    ],
    sessions: [
      {
        id: 's1',
        status: 'completed',
        createdAt: '2026-01-10T09:00:00.000Z',
        completedAt: '2026-01-10T09:30:00.000Z',
        respondentName: 'Ada Lovelace',
        profile: { team: 'Analytics' },
        answers: [
          {
            questionKey: 'role',
            value: 'Engineer',
            confidence: 0.9,
            provenanceLabel: 'direct',
            provenanceItems: null,
            rationale: null,
            refinementHistory: [],
            lastUpdatedTurnOrdinal: 1,
          },
          // q2 (rating) deliberately unanswered for this session.
        ],
        turns: [
          {
            ordinal: 1,
            userMessage: "I'm an engineer",
            agentResponse: 'Thanks!',
            targetedQuestionId: 'q1',
            toolCalls: [],
            sideEffectAnswerIds: ['a1'],
            costUsd: 0.01,
            createdAt: '2026-01-10T09:01:00.000Z',
          },
        ],
      },
      {
        id: 's2',
        status: 'completed',
        createdAt: '2026-01-11T09:00:00.000Z',
        completedAt: '2026-01-11T09:30:00.000Z',
        respondentName: null,
        profile: null,
        answers: [
          {
            questionKey: 'rating',
            value: 5,
            confidence: null,
            provenanceLabel: 'inferred',
            provenanceItems: null,
            rationale: 'mentioned in passing',
            refinementHistory: [],
            lastUpdatedTurnOrdinal: null,
          },
        ],
        turns: [],
      },
    ],
    ...overrides,
  };
}

describe('renderAnswerValue', () => {
  it('renders each value kind faithfully (data view, not display labels)', () => {
    expect(renderAnswerValue(null)).toBe('');
    expect(renderAnswerValue(undefined)).toBe('');
    expect(renderAnswerValue('')).toBe('');
    expect(renderAnswerValue('hello')).toBe('hello');
    expect(renderAnswerValue(42)).toBe('42');
    expect(renderAnswerValue(true)).toBe('true');
    expect(renderAnswerValue(false)).toBe('false');
    expect(renderAnswerValue(['a', 'b', 'c'])).toBe('a, b, c');
    expect(renderAnswerValue({ city: 'London' })).toBe('{"city":"London"}');
  });
});

describe('toResultsCsv', () => {
  it('emits the canonical header row', () => {
    const [header] = toResultsCsv(model()).split('\n');
    expect(header).toBe(RESULTS_CSV_COLUMNS.join(','));
  });

  it('emits exactly one row per session × question (header excluded)', () => {
    const lines = toResultsCsv(model()).split('\n');
    // 1 header + 2 sessions × 2 questions = 5 lines.
    expect(lines).toHaveLength(5);
  });

  it('leaves answer cells empty for unanswered slots', () => {
    const lines = toResultsCsv(model()).split('\n');
    // Session s1 / question rating (q2) is unanswered: trailing answer/confidence/prov empty.
    const ratingRow = lines.find((l) => l.startsWith('s1,') && l.includes(',rating,'));
    expect(ratingRow).toBeDefined();
    expect(ratingRow!.endsWith(',,,')).toBe(true);
  });

  it('renders an answered cell with value, confidence and provenance', () => {
    const lines = toResultsCsv(model()).split('\n');
    const roleRow = lines.find((l) => l.startsWith('s1,') && l.includes(',role,'));
    expect(roleRow).toContain('Engineer');
    expect(roleRow).toContain('0.9');
    expect(roleRow).toContain('direct');
  });

  it('renders an empty respondent_name cell when the name is null', () => {
    const csv = toResultsCsv(model());
    const s2Row = csv.split('\n').find((l) => l.startsWith('s2,'));
    // respondent_name is the 5th column; with empty completed/respondent it appears blank.
    expect(s2Row).toContain('s2,completed,');
    expect(s2Row).not.toContain('Ada Lovelace');
  });

  it('serialises the collected profile as a JSON cell (F8.3)', () => {
    const csv = toResultsCsv(model());
    const s1Row = csv.split('\n').find((l) => l.startsWith('s1,'));
    // s1 carries profile { team: 'Analytics' }; s2 carries none → blank cell.
    expect(s1Row).toContain('Analytics');
    const s2Row = csv.split('\n').find((l) => l.startsWith('s2,'));
    expect(s2Row).not.toContain('Analytics');
  });

  it('neutralises formula-injection in answer values', () => {
    const m = model();
    m.sessions[0].answers[0].value = '=HYPERLINK("http://evil")';
    const csv = toResultsCsv(m);
    // csvEscape prefixes a leading-trigger value with a quote, and the comma forces RFC quoting.
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

describe('toResultsJson', () => {
  it('returns the faithful session graph including turns and provenance', () => {
    const out = toResultsJson(model());
    expect(out.versionId).toBe('v1');
    expect(out.sessions[0].turns[0].userMessage).toBe("I'm an engineer");
    expect(out.sessions[0].answers[0].provenanceLabel).toBe('direct');
  });

  it('carries through an anonymous model untouched (null respondent, no profile, empty turns)', () => {
    const anon = model({
      anonymous: true,
      sessions: model().sessions.map((s) => ({
        ...s,
        respondentName: null,
        profile: null,
        turns: [],
      })),
    });
    const out = toResultsJson(anon);
    expect(out.anonymous).toBe(true);
    expect(out.sessions.every((s) => s.respondentName === null)).toBe(true);
    expect(out.sessions.every((s) => s.profile === null)).toBe(true);
    expect(out.sessions.every((s) => s.turns.length === 0)).toBe(true);
  });
});
