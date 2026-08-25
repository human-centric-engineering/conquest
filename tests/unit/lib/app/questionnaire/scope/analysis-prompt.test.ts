/**
 * Routing Analyst prompt builder — unit tests (P17.4).
 *
 * Two properties carry real weight here:
 *
 *   1. **Optional blocks cost nothing when absent, but the analyst is told plainly when it is
 *      working without a document or data slots** — unlike the Glossary Analyst's silent omission,
 *      this prompt always emits a DOCUMENT and DATA SLOTS section, just with a different message
 *      when the input is missing (`fromDocument` depends on the analyst knowing which case it's in).
 *   2. **Existing topics actually reach the model**, with their key, phase, source and criteria, so
 *      a re-run revises rather than duplicates — the analyst is told to reuse a key when it means
 *      the same topic.
 *
 * @see lib/app/questionnaire/scope/analysis-prompt.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildRoutingAnalysisPrompt,
  buildRoutingAnalysisRetryMessage,
} from '@/lib/app/questionnaire/scope/analysis-prompt';
import { LIGHT_DEPTH_MEMBER_COUNT, type Topic } from '@/lib/app/questionnaire/scope/types';

const QUESTIONS = [
  { key: 'q1', prompt: 'How many partners does your firm work through?', sectionTitle: 'Channel' },
  { key: 'q2', prompt: 'Describe your renewal process.' },
];

const DATA_SLOTS = [
  { key: 'channel_type', name: 'Channel type', theme: 'Go-to-market' },
  { key: 'company_size', name: 'Company size' },
];

function existingTopic(over: Partial<Topic> = {}): Topic {
  return {
    id: 'id-partner_channel',
    key: 'partner_channel',
    label: 'Partner channel',
    description: null,
    phase: 'conditional',
    criteria: 'They sell through partners or resellers',
    depth: 'full',
    members: { dataSlotKeys: [], questionKeys: [] },
    ordinal: 0,
    source: 'analyst',
    ...over,
  };
}

/** The user turn — everything variable lives there; the system turn is the fixed rubric. */
function userContent(messages: ReturnType<typeof buildRoutingAnalysisPrompt>): string {
  const user = messages.find((m) => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

describe('buildRoutingAnalysisPrompt', () => {
  it('returns a system rubric followed by one user turn', () => {
    const messages = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('includes every question prompt with its section title', () => {
    const content = userContent(buildRoutingAnalysisPrompt({ questions: QUESTIONS }));
    expect(content).toContain('q1 [Channel]: How many partners does your firm work through?');
    expect(content).toContain('q2: Describe your renewal process.');
  });

  it('omits the goal and audience blocks when absent', () => {
    const content = userContent(buildRoutingAnalysisPrompt({ questions: QUESTIONS }));
    expect(content).not.toContain('QUESTIONNAIRE GOAL');
    expect(content).not.toContain('AUDIENCE');
  });

  it('includes the goal and audience when supplied', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        goal: 'Assess channel readiness.',
        audience: { segment: 'B2B sales leaders' },
      })
    );
    expect(content).toContain('QUESTIONNAIRE GOAL');
    expect(content).toContain('Assess channel readiness.');
    expect(content).toContain('B2B sales leaders');
  });

  it('treats a null goal and audience as absent rather than printing "null"', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({ questions: QUESTIONS, goal: null, audience: null })
    );
    expect(content).not.toContain('QUESTIONNAIRE GOAL');
    expect(content).not.toContain('AUDIENCE');
    expect(content).not.toContain('null');
  });

  it('marks the source document for the analyst to read first, and names the file', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        documentText: 'Only ask the Partner Channel section if they sell through resellers.',
        documentFileName: 'channel-instrument.pdf',
      })
    );
    expect(content).toContain(
      "SOURCE DOCUMENT (channel-instrument.pdf) — read the author's guidance in it first:"
    );
    expect(content).toContain(
      'Only ask the Partner Channel section if they sell through resellers.'
    );
  });

  it('still marks the document section when no filename is known', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        documentText: 'Route by company size.',
      })
    );
    expect(content).toContain("SOURCE DOCUMENT — read the author's guidance in it first:");
    expect(content).not.toContain('SOURCE DOCUMENT (');
  });

  it('tells the analyst plainly when no document is attached, rather than omitting the section', () => {
    const content = userContent(buildRoutingAnalysisPrompt({ questions: QUESTIONS }));
    expect(content).toContain('SOURCE DOCUMENT: none is attached to this version.');
    expect(content).toContain('set "fromDocument" false');
  });

  it('lists data slots with their theme when present', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({ questions: QUESTIONS, dataSlots: DATA_SLOTS })
    );
    expect(content).toContain('DATA SLOTS (the only keys a rule may test):');
    expect(content).toContain('channel_type [Go-to-market]: Channel type');
    expect(content).toContain('company_size: Company size');
  });

  it('tells the analyst to propose no rules when there are no data slots', () => {
    const content = userContent(buildRoutingAnalysisPrompt({ questions: QUESTIONS }));
    expect(content).toContain('DATA SLOTS: none. Propose no hard rules');
    expect(content).not.toContain('the only keys a rule may test');
  });

  it('also falls back to the no-data-slots message when given an empty array', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({ questions: QUESTIONS, dataSlots: [] })
    );
    expect(content).toContain('DATA SLOTS: none. Propose no hard rules');
  });

  it('lists existing topics with their key, phase, source and criteria, telling the analyst to reuse keys', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        existingTopics: [existingTopic()],
      })
    );
    expect(content).toContain('TOPICS ALREADY ON THIS VERSION');
    expect(content).toContain('Reuse a key');
    expect(content).toContain(
      '- partner_channel (conditional, analyst): Partner channel — include when: They sell through partners or resellers'
    );
  });

  it('omits the "include when" clause for an existing topic with no criteria', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        existingTopics: [existingTopic({ key: 'core_ops', criteria: null, phase: 'core' })],
      })
    );
    expect(content).toContain('- core_ops (core, analyst): Partner channel');
    expect(content).not.toContain('include when');
  });

  it('omits the existing-topics block when the list is empty', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({ questions: QUESTIONS, existingTopics: [] })
    );
    expect(content).not.toContain('TOPICS ALREADY ON THIS VERSION');
  });

  it('includes the administrator note for this run, trimmed', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({
        questions: QUESTIONS,
        instructions: '  The routing rules are on the Guardrails tab.  ',
      })
    );
    expect(content).toContain("ADMINISTRATOR'S NOTE FOR THIS RUN:");
    expect(content).toContain('The routing rules are on the Guardrails tab.');
    // Trimmed — no leading/trailing whitespace carried into the rendered block.
    expect(content).not.toContain('RUN:\n  The routing');
  });

  it('omits the administrator note block when it is only whitespace', () => {
    const content = userContent(
      buildRoutingAnalysisPrompt({ questions: QUESTIONS, instructions: '   ' })
    );
    expect(content).not.toContain("ADMINISTRATOR'S NOTE FOR THIS RUN");
  });

  it('omits the administrator note block when absent', () => {
    const content = userContent(buildRoutingAnalysisPrompt({ questions: QUESTIONS }));
    expect(content).not.toContain("ADMINISTRATOR'S NOTE FOR THIS RUN");
  });

  it('states the phase vocabulary, the quoting-versus-inferring rule and the output contract', () => {
    const [system] = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
    const rubric = typeof system.content === 'string' ? system.content : '';
    // The grounding instruction is the load-bearing half of this prompt.
    expect(rubric).toContain('OMIT "sourceQuote" entirely');
    expect(rubric).toContain('Set "fromDocument" true only when');
    expect(rubric).toContain('"opening"');
    expect(rubric).toContain('"core"');
    expect(rubric).toContain('"conditional"');
    expect(rubric).toContain('"closing"');
    expect(rubric).toContain('Propose at most 40 topics');
    expect(rubric).toContain('Propose at most 20 rules');
    expect(rubric).toContain('Output ONLY a single JSON object');
  });

  it('states the gaps rubric — required quote, capped count', () => {
    const [system] = buildRoutingAnalysisPrompt({ questions: QUESTIONS });
    const rubric = typeof system.content === 'string' ? system.content : '';
    expect(rubric).toContain('## Gaps');
    expect(rubric).toContain('"sourceQuote" is REQUIRED');
    expect(rubric).toContain('Report at most 15 gaps');
    expect(rubric).toContain('"gaps"');
  });
});

describe('buildRoutingAnalysisRetryMessage', () => {
  it('names the required shape without echoing the malformed output', () => {
    const message = buildRoutingAnalysisRetryMessage();
    expect(message).toContain('"topics"');
    expect(message).toContain('lowercase_snake_case');
    expect(message).toContain('"criteria"');
    expect(message).toContain('"rules"');
    expect(message).toContain('"gaps"');
    expect(message).toContain('"fromDocument"');
    expect(message).toContain('No prose, no code fences');
  });
});

describe('the rubric the analyst kept getting wrong (F17.23)', () => {
  /** The system turn — where SYSTEM_RULES lives. */
  const rubric = () => buildRoutingAnalysisPrompt({ questions: QUESTIONS })[0].content;

  describe('depth', () => {
    it('forbids light on every phase that runs for everyone, by name', () => {
      const text = rubric();
      expect(text).toContain('NEVER set "light" on an "opening", "core" or "closing" topic');
    });

    it('says what light actually costs, in members rather than adjectives', () => {
      // The old rubric called light "a sample of the most important few", which reads as a
      // refinement rather than a deletion — and the analyst proposed it on openings twice on real
      // instruments. Naming the number is what makes the instruction checkable.
      expect(rubric()).toContain(`${LIGHT_DEPTH_MEMBER_COUNT} highest-weighted questions`);
    });

    it('names full as the answer when the document says nothing about depth', () => {
      expect(rubric()).toContain('If the document says nothing about depth, use "full"');
    });
  });

  describe('the two settings that are not topics', () => {
    it('teaches both fields', () => {
      const text = rubric();
      expect(text).toContain('"fallbackTopicKeys"');
      expect(text).toContain('"checkTopicPreference"');
    });

    it('says the fallback list is used only when nothing else was chosen', () => {
      // The distinction that matters: it is not a preference ordering, and folding it into topic
      // criteria instead (which is what the analyst used to do) is a different runtime path.
      expect(rubric()).toContain('ONLY when nothing else was chosen');
    });

    it('tells the analyst to omit them rather than guess, like maxConditionalTopics', () => {
      expect(rubric()).toContain('OMIT the field');
    });

    it('stops them being reported as unformalizable gaps', () => {
      expect(rubric()).toContain(
        'Do NOT report a gap for anything "fallbackTopicKeys" or "checkTopicPreference" can express'
      );
    });

    it('puts both keys in the output template', () => {
      const text = rubric();
      expect(text).toContain('"fallbackTopicKeys": [');
      expect(text).toContain('"checkTopicPreference": [');
    });
  });
});
