import { describe, it, expect } from 'vitest';

import {
  buildVerifyPrompt,
  buildVerifyRetryMessage,
} from '@/lib/app/questionnaire/ingestion/verify-prompt';
import { VERIFY_ISSUES } from '@/lib/app/questionnaire/ingestion/verify-schema';

/**
 * Contract tests for the fidelity critic's prompt.
 *
 * The load-bearing rubric lives here rather than in the agent's seeded `systemInstructions` (the
 * seed says so explicitly), which makes this file the only place the critic's policy is asserted.
 *
 * These exist because of a false positive found by the routing corpus: a "Rating 1-5" correctly
 * extracted as `numeric` was flagged `type_mismatch` — "extracted as numeric instead of a
 * rating/likert scale". The repair specialist then built an unanchored likert, which
 * `likertWriteConfigSchema` rejects by design, so the correction was discarded and the original
 * kept. Correct outcome, reached by accident, after a wasted model call. The rubric listed the
 * wrong types for a rating scale but never said which type was RIGHT.
 */

function systemRules(): string {
  const messages = buildVerifyPrompt({ questions: [], documentText: 'Q1', fileName: 'survey.csv' });
  const system = messages.find((m) => m.role === 'system');
  if (!system || typeof system.content !== 'string') {
    throw new Error('expected a string system message');
  }
  return system.content;
}

describe('buildVerifyPrompt — structure', () => {
  it('returns exactly a system message then a user message', () => {
    const messages = buildVerifyPrompt({ questions: [], documentText: 'Q1' });
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('embeds the source document and the questions to verify', () => {
    const messages = buildVerifyPrompt({
      questions: [{ key: 'pm1', prompt: 'How controlled is your pain?', suggestedType: 'numeric' }],
      documentText: 'PM1,How well controlled is your pain?,Rating 1-5',
      fileName: 'medication-review.csv',
    });
    const user = messages[1].content;
    expect(user).toContain('medication-review.csv');
    expect(user).toContain('Rating 1-5');
    expect(user).toContain('pm1');
    expect(user).toContain('numeric');
  });

  it('surfaces every issue value from its single source of truth', () => {
    const rules = systemRules();
    for (const issue of VERIFY_ISSUES) {
      expect(rules).toContain(issue);
    }
  });
});

describe('buildVerifyPrompt — the numeric carve-out', () => {
  it('tells the critic an unanchored rating typed numeric is CORRECT, not a mismatch', () => {
    const rules = systemRules();
    expect(rules).toMatch(/NEVER flag/);
    expect(rules).toMatch(/unanchored rating typed "numeric"|UNANCHORED rating typed "numeric"/i);
    expect(rules).toMatch(/Rating 1-5/);
  });

  it('explains WHY, so the rule survives a reword — an unlabelled likert cannot validate', () => {
    const rules = systemRules();
    expect(rules).toMatch(/rejects an unlabelled|REJECTS an unlabelled/i);
  });

  it('still flags a rating the source DOES anchor but the extractor typed numeric', () => {
    // The carve-out must not become a blanket "never question a numeric".
    expect(systemRules()).toMatch(/Only call a rating mis-typed when the source DOES anchor it/i);
  });

  it('does not treat a numeric without labels as a missing config', () => {
    expect(systemRules()).toMatch(/Numeric questions never have labels/i);
  });
});

describe('buildVerifyRetryMessage', () => {
  it('demands the bare JSON object with both arrays', () => {
    const message = buildVerifyRetryMessage();
    expect(message).toMatch(/verdicts/);
    expect(message).toMatch(/matrixGroups/);
    expect(message).toMatch(/no code fences/i);
  });
});

describe('coverage — the axis per-question verdicts cannot see', () => {
  // The critic checked all 28 questions on a run of routing-corpus doc 02, flagged 3 sensibly, and
  // never remarked that the source had 22 numbered items. Every verdict can be `ok` while the
  // question SET is wrong: a compound split in two, a heading promoted to a question, a page
  // missed. That is a different question from "is this question faithful?" and needs asking
  // separately.
  const prompt = buildVerifyPrompt({
    questions: [{ key: 'q1', prompt: 'Anything?', suggestedType: 'free_text' }],
    documentText: '1. Anything?',
  })
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');

  it('asks for a count assessment alongside the per-question verdicts', () => {
    expect(prompt).toContain('"coverage"');
    for (const assessment of ['matches', 'extra_questions', 'missing_questions', 'uncountable']) {
      expect(prompt).toContain(assessment);
    }
  });

  it('names the compound split as the usual cause of extra questions', () => {
    // The specific drift this exists to catch, named so the critic recognises it rather than
    // reporting a bare count mismatch the reader has to diagnose.
    expect(prompt).toMatch(/compound question/i);
  });

  it('licenses "uncountable" instead of pushing the critic to guess', () => {
    // Most instruments do not number their questions. Without this the critic invents a count to
    // avoid an apparent non-answer, and a fabricated number is worse than an honest shrug — it
    // would make every unnumbered document look like a coverage failure.
    expect(prompt).toMatch(/perfectly good answer/i);
    expect(prompt).toMatch(/Never guess a count/i);
  });

  it('forbids reasoning backwards from the extracted count', () => {
    // Without this the check is circular: told 28 questions, the critic concludes the source has 28.
    expect(prompt).toMatch(/Do not reason backwards/i);
  });
});
