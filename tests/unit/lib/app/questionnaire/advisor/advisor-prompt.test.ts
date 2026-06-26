/**
 * Unit test for the Config Advisor prompt builders (`advisor-prompt.ts`).
 *
 * Pure functions — verify both phases produce a system+user message pair, that the snapshot is
 * serialised into the user content, and that the suggestions prompt constrains the model to the
 * applyable-field allowlist (so it can't propose a one-click patch on a structured block).
 */

import { describe, it, expect } from 'vitest';

import {
  buildAdvisorNarrativePrompt,
  buildAdvisorSuggestionsPrompt,
  serializeAdvisorContext,
} from '@/lib/app/questionnaire/advisor/advisor-prompt';
import { ADVISOR_APPLYABLE_CONFIG_FIELDS } from '@/lib/app/questionnaire/advisor/advisor-schema';
import type { AdvisorContext } from '@/lib/app/questionnaire/advisor/context';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';

const context: AdvisorContext = {
  questionnaire: { title: 'Churn survey', status: 'launched', demoClientName: 'Acme' },
  version: {
    versionNumber: 3,
    status: 'launched',
    goal: 'Understand churn',
    audience: null,
    sessionCount: 12,
  },
  structure: {
    sectionCount: 2,
    questionCount: 5,
    requiredCount: 4,
    optionalCount: 1,
    typeHistogram: { free_text: 3, single_choice: 2 },
    sections: [
      { title: 'Onboarding', questionCount: 3, samplePrompts: ['How did onboarding go?'] },
      { title: 'Value', questionCount: 2, samplePrompts: ['What value do you get?'] },
    ],
  },
  config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, saved: true, selectionStrategy: 'adaptive' },
  dataSlots: { count: 1, samples: [{ name: 'Sentiment', theme: 'affect' }] },
  scoring: { present: false, name: null },
};

describe('serializeAdvisorContext', () => {
  it('includes the key snapshot facts the advisor needs', () => {
    const s = serializeAdvisorContext(context);
    expect(s).toContain('Churn survey');
    expect(s).toContain('"sessionCount": 12');
    expect(s).toContain('adaptive');
    expect(s).toContain('Sentiment');
  });
});

describe('buildAdvisorNarrativePrompt', () => {
  it('returns a system+user pair with the snapshot in the user message', () => {
    const messages = buildAdvisorNarrativePrompt(context);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content as string).toContain('Churn survey');
    // The narrative phase asks for the two prose sections, not JSON.
    expect(messages[0].content as string).toMatch(/Current state/);
    expect(messages[0].content as string).toMatch(/Respondent experience/);
  });
});

describe('buildAdvisorSuggestionsPrompt', () => {
  it('embeds the narrative and constrains patches to the applyable allowlist', () => {
    const narrative = 'NARRATIVE-MARKER about the experience.';
    const messages = buildAdvisorSuggestionsPrompt(context, narrative);

    expect(messages).toHaveLength(2);
    expect(messages[1].content as string).toContain(narrative);

    const system = messages[0].content as string;
    // Names the allowlist fields and forbids inventing fields.
    expect(system).toContain('selectionStrategy');
    expect(system).toContain('accessMode');
    expect(system).toMatch(/allowlist/i);
    // Every applyable field is advertised to the model.
    for (const field of ADVISOR_APPLYABLE_CONFIG_FIELDS) {
      expect(system).toContain(field);
    }
  });
});
