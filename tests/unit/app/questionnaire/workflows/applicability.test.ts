/**
 * Unit tests: per-questionnaire applicability predicates.
 *
 * Drives each diagram's `applicability(ctx)` across representative contexts so
 * the questionnaire lens stays honest: a flag off ⇒ `unavailable`, a flag on but
 * the per-version gate off ⇒ `inactive`, both on ⇒ `applies`. Also pins the
 * distinctive gates (ingested-vs-composed provenance, launched-only live flows,
 * the cohort round gate, the respondent-report AI-mode gate) so a renamed flag
 * or config field fails CI.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import { WORKFLOW_DIAGRAMS, getWorkflowDiagram } from '@/lib/app/questionnaire/workflows/registry';
import type { ApplicabilityContext, WorkflowFlags } from '@/lib/app/questionnaire/workflows/types';

function flags(value: boolean): WorkflowFlags {
  return {
    master: value,
    generativeAuthoring: value,
    editAgent: value,
    liveSessions: value,
    answerExtraction: value,
    dataSlots: value,
    respondentReport: value,
    cohortReport: value,
    introScreen: value,
    voiceInput: value,
    personaSelection: value,
    adaptiveSelection: value,
    turnEvaluation: value,
    designEvaluation: value,
    advisor: value,
  };
}

function makeCtx(overrides: Partial<ApplicabilityContext> = {}): ApplicabilityContext {
  return {
    flags: flags(true),
    config: DEFAULT_QUESTIONNAIRE_CONFIG,
    versionStatus: 'launched',
    goalProvenance: 'inferred',
    sourceDocumentCount: 1,
    dataSlotCount: 1,
    roundItemCount: 1,
    ...overrides,
  };
}

function statusOf(slug: string, ctx: ApplicabilityContext): string {
  const diagram = getWorkflowDiagram(slug);
  if (!diagram) throw new Error(`unknown workflow ${slug}`);
  return diagram.applicability(ctx).status;
}

describe('workflow applicability', () => {
  it('every workflow is unavailable when all flags are off', () => {
    const ctx = makeCtx({ flags: flags(false) });
    for (const diagram of WORKFLOW_DIAGRAMS) {
      expect(diagram.applicability(ctx).status, diagram.slug).toBe('unavailable');
    }
  });

  it('document ingestion applies only to versions with source documents', () => {
    expect(statusOf('document-ingestion', makeCtx({ sourceDocumentCount: 2 }))).toBe('applies');
    expect(statusOf('document-ingestion', makeCtx({ sourceDocumentCount: 0 }))).toBe('inactive');
  });

  it('generative authoring applies only to composed versions', () => {
    expect(
      statusOf(
        'generative-authoring',
        makeCtx({ sourceDocumentCount: 0, goalProvenance: 'inferred' })
      )
    ).toBe('applies');
    expect(statusOf('generative-authoring', makeCtx({ sourceDocumentCount: 3 }))).toBe('inactive');
  });

  it('conversational run applies only to launched versions', () => {
    expect(statusOf('conversation-turn', makeCtx({ versionStatus: 'launched' }))).toBe('applies');
    expect(statusOf('conversation-turn', makeCtx({ versionStatus: 'draft' }))).toBe('inactive');
  });

  it('data-slot turn needs both a launched version and data slots', () => {
    expect(
      statusOf('data-slot-turn', makeCtx({ versionStatus: 'launched', dataSlotCount: 4 }))
    ).toBe('applies');
    expect(statusOf('data-slot-turn', makeCtx({ dataSlotCount: 0 }))).toBe('inactive');
  });

  it('respondent report needs it enabled in an AI mode', () => {
    const enabledAi = makeCtx({
      config: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG,
        respondentReport: {
          ...DEFAULT_QUESTIONNAIRE_CONFIG.respondentReport,
          enabled: true,
          mode: 'narrative',
        },
      },
    });
    expect(statusOf('respondent-report', enabledAi)).toBe('applies');

    const disabled = makeCtx({
      config: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG,
        respondentReport: { ...DEFAULT_QUESTIONNAIRE_CONFIG.respondentReport, enabled: false },
      },
    });
    expect(statusOf('respondent-report', disabled)).toBe('inactive');
  });

  it('cohort report needs it enabled and a round', () => {
    const enabledInRound = makeCtx({
      config: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG,
        cohortReport: { ...DEFAULT_QUESTIONNAIRE_CONFIG.cohortReport, enabled: true },
      },
      roundItemCount: 2,
    });
    expect(statusOf('cohort-report', enabledInRound)).toBe('applies');

    const noRound = makeCtx({
      config: {
        ...DEFAULT_QUESTIONNAIRE_CONFIG,
        cohortReport: { ...DEFAULT_QUESTIONNAIRE_CONFIG.cohortReport, enabled: true },
      },
      roundItemCount: 0,
    });
    expect(statusOf('cohort-report', noRound)).toBe('inactive');
  });

  it('turn inspector needs live sessions and the inspector toggle on', () => {
    const on = makeCtx({
      config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, previewInspectorEnabled: true },
    });
    expect(statusOf('turn-inspector', on)).toBe('applies');
    // Toggle off → inactive (flag on, per-version config gate off).
    expect(
      statusOf(
        'turn-inspector',
        makeCtx({ config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, previewInspectorEnabled: false } })
      )
    ).toBe('inactive');
    // Live sessions off → unavailable.
    expect(
      statusOf(
        'turn-inspector',
        makeCtx({
          flags: { ...flags(true), liveSessions: false },
          config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, previewInspectorEnabled: true },
        })
      )
    ).toBe('unavailable');
  });

  it('design evaluation and config advisor gate purely on their flags', () => {
    expect(statusOf('design-evaluation', makeCtx())).toBe('applies');
    expect(
      statusOf('design-evaluation', makeCtx({ flags: { ...flags(true), designEvaluation: false } }))
    ).toBe('unavailable');
    expect(statusOf('config-advisor', makeCtx())).toBe('applies');
    expect(statusOf('config-advisor', makeCtx({ flags: { ...flags(true), advisor: false } }))).toBe(
      'unavailable'
    );
  });

  it('turn evaluation needs the turn-evaluation flag and captured turns', () => {
    const on = makeCtx({
      config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, previewInspectorEnabled: true },
    });
    expect(statusOf('turn-evaluation', on)).toBe('applies');
    // Flag off → unavailable.
    expect(
      statusOf(
        'turn-evaluation',
        makeCtx({
          flags: { ...flags(true), turnEvaluation: false },
          config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, previewInspectorEnabled: true },
        })
      )
    ).toBe('unavailable');
    // Flag on but no inspector (no captured turns) → inactive.
    expect(
      statusOf(
        'turn-evaluation',
        makeCtx({ config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, previewInspectorEnabled: false } })
      )
    ).toBe('inactive');
  });
});
