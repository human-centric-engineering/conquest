/**
 * Glossary Analyst prompt builder — unit tests (P16).
 *
 * Two properties carry real weight here:
 *
 *   1. **Optional blocks cost nothing when absent.** A bare questionnaire must not ship an empty
 *      "DEFINITIONS DOCUMENT" or "ALREADY ADJUDICATED" header — that is both wasted tokens and an
 *      instruction the model may try to honour against nothing.
 *   2. **The already-adjudicated list actually reaches the model.** It is the entire mechanism
 *      that stops a re-run re-proposing a term the admin rejected, which is what makes the
 *      feature safe to run more than once.
 *
 * @see lib/app/questionnaire/glossary/analysis-prompt.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildGlossaryAnalysisPrompt,
  buildGlossaryAnalysisRetryMessage,
} from '@/lib/app/questionnaire/glossary/analysis-prompt';

const QUESTIONS = [
  {
    key: 'connection',
    prompt: 'How connected do you feel to your higher self?',
    sectionTitle: 'Inner life',
  },
  { key: 'ego', prompt: 'When does your ego get in the way?', guidelines: 'Probe for examples.' },
];

/** The user turn — everything variable lives there; the system turn is the fixed rubric. */
function userContent(messages: ReturnType<typeof buildGlossaryAnalysisPrompt>): string {
  const user = messages.find((m) => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

describe('buildGlossaryAnalysisPrompt', () => {
  it('returns a system rubric followed by one user turn', () => {
    const messages = buildGlossaryAnalysisPrompt({ questions: QUESTIONS });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('includes every question prompt, with its section and guidance', () => {
    const content = userContent(buildGlossaryAnalysisPrompt({ questions: QUESTIONS }));
    expect(content).toContain('How connected do you feel to your higher self?');
    expect(content).toContain('When does your ego get in the way?');
    expect(content).toContain('Inner life');
    expect(content).toContain('Probe for examples.');
  });

  it('omits the goal, audience, data-slot and document blocks when absent', () => {
    const content = userContent(buildGlossaryAnalysisPrompt({ questions: QUESTIONS }));
    expect(content).not.toContain('QUESTIONNAIRE GOAL');
    expect(content).not.toContain('AUDIENCE');
    expect(content).not.toContain('DATA POINTS');
    expect(content).not.toContain('DEFINITIONS DOCUMENT');
    expect(content).not.toContain('ALREADY ADJUDICATED');
  });

  it('includes the goal and audience when supplied', () => {
    const content = userContent(
      buildGlossaryAnalysisPrompt({
        questions: QUESTIONS,
        goal: 'Assess spiritual development.',
        audience: { segment: 'retreat participants' },
      })
    );
    expect(content).toContain('QUESTIONNAIRE GOAL');
    expect(content).toContain('Assess spiritual development.');
    expect(content).toContain('retreat participants');
  });

  it('treats a null goal as absent rather than printing "null"', () => {
    const content = userContent(
      buildGlossaryAnalysisPrompt({ questions: QUESTIONS, goal: null, audience: null })
    );
    expect(content).not.toContain('QUESTIONNAIRE GOAL');
    expect(content).not.toContain('AUDIENCE');
    expect(content).not.toContain('null');
  });

  it('marks the definitions document as authoritative and names the file', () => {
    const content = userContent(
      buildGlossaryAnalysisPrompt({
        questions: QUESTIONS,
        documentText: 'Higher self: the Self that observes.',
        documentFileName: 'house-glossary.pdf',
      })
    );
    expect(content).toContain('DEFINITIONS DOCUMENT (house-glossary.pdf) — AUTHORITATIVE');
    expect(content).toContain('Higher self: the Self that observes.');
  });

  it('still marks the document authoritative when no filename is known', () => {
    const content = userContent(
      buildGlossaryAnalysisPrompt({
        questions: QUESTIONS,
        documentText: 'Ego: the constructed self.',
      })
    );
    expect(content).toContain('DEFINITIONS DOCUMENT — AUTHORITATIVE');
  });

  it('passes the already-adjudicated terms so a re-run does not re-propose them', () => {
    const content = userContent(
      buildGlossaryAnalysisPrompt({
        questions: QUESTIONS,
        existingTerms: ['higher self', 'shadow'],
      })
    );
    expect(content).toContain('ALREADY ADJUDICATED');
    expect(content).toContain('higher self, shadow');
  });

  it('omits the exclusion block when the list is empty', () => {
    const content = userContent(
      buildGlossaryAnalysisPrompt({ questions: QUESTIONS, existingTerms: [] })
    );
    expect(content).not.toContain('ALREADY ADJUDICATED');
  });

  it('lists data-slot names when the version has them', () => {
    const content = userContent(
      buildGlossaryAnalysisPrompt({
        questions: QUESTIONS,
        dataSlotNames: ['Spiritual practice', 'Self-awareness'],
      })
    );
    expect(content).toContain('Spiritual practice, Self-awareness');
  });

  it('tells the model to prefer precision and to prefer document-sourced definitions', () => {
    const [system] = buildGlossaryAnalysisPrompt({ questions: QUESTIONS });
    const rubric = typeof system.content === 'string' ? system.content : '';
    // The restraint instruction is the load-bearing half of this prompt.
    expect(rubric).toContain('Precision matters far more than recall');
    expect(rubric).toContain('Do NOT propose');
    expect(rubric).toContain('AUTHORITATIVE');
    expect(rubric).toContain('Never invent a quote');
    // And it must not invite a plural-alias dump the matcher already handles.
    expect(rubric).toContain('Do NOT list regular plurals');
  });
});

describe('buildGlossaryAnalysisRetryMessage', () => {
  it('names the required shape without echoing the malformed output', () => {
    const message = buildGlossaryAnalysisRetryMessage();
    expect(message).toContain('"terms"');
    expect(message).toContain('"definitions"');
    expect(message).toContain('No prose, no code fences');
  });
});
