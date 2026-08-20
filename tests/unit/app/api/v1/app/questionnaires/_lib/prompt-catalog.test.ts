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
  RECONCILER_AGENT_SLUG,
  TURN_EVALUATOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import { EVALUATION_JUDGE_SLUGS } from '@/lib/app/questionnaire/evaluation/dimensions';
import { EVALUATION_DIMENSIONS } from '@/lib/app/questionnaire/evaluation/types';
import { SCOPE_EVALUATION_JUDGE_SLUGS } from '@/lib/app/questionnaire/scope-evaluation/dimensions';
import { SCOPE_EVALUATION_DIMENSIONS } from '@/lib/app/questionnaire/scope-evaluation/types';

const catalog = buildPromptCatalog();

describe('buildPromptCatalog', () => {
  it('covers the authoring, live, and evaluation stages', () => {
    const stages = new Set(catalog.map((e) => e.stage));
    expect(stages).toEqual(new Set(['authoring', 'live', 'evaluation']));
  });

  it('includes one judge entry per design + scope evaluation dimension, alongside the two non-judges', () => {
    const evaluationStage = catalog.filter((e) => e.stage === 'evaluation');
    // Two evaluation-stage agents are NOT per-dimension judges and must not be counted as one: the
    // turn evaluator (a live-conversation critic) and the suggestion reconciler (which runs after
    // the design-evaluation panel and scores nothing — the scope-evaluation panel has no
    // reconciler). Identify the judges by their registry slugs rather than by "everything else in
    // the stage", so a future non-judge cannot quietly pass as one.
    const judgeSlugs = new Set([...EVALUATION_JUDGE_SLUGS, ...SCOPE_EVALUATION_JUDGE_SLUGS]);
    const judges = evaluationStage.filter((e) => judgeSlugs.has(e.slug));
    expect(judges).toHaveLength(EVALUATION_DIMENSIONS.length + SCOPE_EVALUATION_DIMENSIONS.length);

    const nonJudges = evaluationStage.filter((e) => !judgeSlugs.has(e.slug)).map((e) => e.slug);
    expect(nonJudges.sort()).toEqual([RECONCILER_AGENT_SLUG, TURN_EVALUATOR_AGENT_SLUG].sort());
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
    expect(tone?.conditions).toContain('Custom tone on');
  });

  it('renders a built-in persona interviewer specimen that injects the persona clause', () => {
    const interviewer = catalog.find((e) => e.slug === QUESTIONNAIRE_INTERVIEWER_AGENT_SLUG);
    const persona = interviewer?.specimens.find((s) => s.id === 'interview.persona');
    expect(persona).toBeDefined();
    expect(persona?.error).toBeUndefined();
    expect(persona?.conditions).toContain('Persona mode on');
    // The persona flows through the same tone block and adds the "Adopt this persona…" wrapper the
    // custom-tone variant (empathy + warmth only) never emits — proving personas are actually shown.
    const system = persona?.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toContain('Adopt this persona');
  });
});
