/**
 * Unit tests for the Prompt Library catalog (`prompt-catalog.ts`).
 *
 * The catalog invokes every questionnaire agent's REAL prompt builder with a fixed
 * sample context. These tests are the guard that those samples stay valid: if a
 * builder's input contract changes and the sample no longer satisfies it, the
 * specimen renders an `error` and the assertions below fail — surfacing the drift
 * before an admin sees a broken prompt. Prisma is mocked because the catalog
 * transitively imports server modules that import the client at load time.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));

import { buildPromptCatalog } from '@/app/api/v1/app/questionnaires/_lib/prompt-catalog';
import {
  QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG,
  QUESTIONNAIRE_SELECTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import { EVALUATION_DIMENSIONS } from '@/lib/app/questionnaire/evaluation/types';

const catalog = buildPromptCatalog();

describe('buildPromptCatalog', () => {
  it('covers the authoring, live, and evaluation stages', () => {
    const stages = new Set(catalog.map((e) => e.stage));
    expect(stages).toEqual(new Set(['authoring', 'live', 'evaluation']));
  });

  it('includes one judge entry per evaluation dimension', () => {
    const judges = catalog.filter((e) => e.stage === 'evaluation');
    expect(judges).toHaveLength(EVALUATION_DIMENSIONS.length);
  });

  it('uses unique, non-empty agent slugs', () => {
    const slugs = catalog.map((e) => e.slug);
    expect(slugs.every((s) => s.length > 0)).toBe(true);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('marks only the streamChat-dispatched selector as driven by stored instructions', () => {
    const loadBearing = catalog.filter((e) => e.instructionsAreLoadBearing);
    expect(loadBearing.map((e) => e.slug)).toEqual([QUESTIONNAIRE_SELECTOR_AGENT_SLUG]);
    // Every capability-dispatched agent assembles its prompt in code → not load-bearing.
    expect(
      catalog
        .filter((e) => e.slug !== QUESTIONNAIRE_SELECTOR_AGENT_SLUG)
        .every((e) => e.instructionsAreLoadBearing === false)
    ).toBe(true);
  });

  it('renders every specimen without error and with at least one non-empty message', () => {
    for (const entry of catalog) {
      expect(entry.specimens.length).toBeGreaterThan(0);
      for (const specimen of entry.specimens) {
        expect(specimen.error, `${entry.slug} / ${specimen.id} should render`).toBeUndefined();
        expect(specimen.messages.length).toBeGreaterThan(0);
        for (const message of specimen.messages) {
          expect(message.role.length).toBeGreaterThan(0);
          expect(message.content.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('emits a system role for a representative builder (structure extractor)', () => {
    const extractor = catalog.find((e) => e.slug.endsWith('extractor') && e.stage === 'authoring');
    const roles = extractor?.specimens[0]?.messages.map((m) => m.role) ?? [];
    expect(roles).toContain('system');
  });

  it('exposes the conditional answer-extractor variants (question, data-slot, sensitivity, seriousness)', () => {
    const extractor = catalog.find((e) => e.slug === QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG);
    const ids = extractor?.specimens.map((s) => s.id) ?? [];
    expect(ids).toEqual(
      expect.arrayContaining([
        'extract-answer.question',
        'extract-answer.data-slots',
        'extract-answer.sensitivity',
        'extract-answer.seriousness',
      ])
    );
  });

  it('renders the interviewer tone variant differently from the default voice', () => {
    const interviewer = catalog.find((e) => e.slug === QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG);
    const opening = interviewer?.specimens.find((s) => s.id === 'interview.opening');
    const tone = interviewer?.specimens.find((s) => s.id === 'interview.tone');
    expect(opening).toBeDefined();
    expect(tone).toBeDefined();
    // The tone-on specimen carries condition metadata the default does not.
    expect(tone?.conditions).toContain('Tone on');
  });
});
