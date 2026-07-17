/**
 * Unit tests: per-questionnaire applicability predicates.
 *
 * Drives each diagram's `applicability(ctx)` across representative contexts so
 * the questionnaire lens stays honest: a per-version gate off ⇒ `inactive`, the
 * gate on ⇒ `applies`. Also pins the distinctive gates (ingested-vs-composed
 * provenance, launched-only live flows, the cohort round gate, the
 * respondent-report AI-mode gate) so a renamed config field fails CI.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import { getWorkflowDiagram } from '@/lib/app/questionnaire/workflows/registry';
import type { ApplicabilityContext } from '@/lib/app/questionnaire/workflows/types';

function makeCtx(overrides: Partial<ApplicabilityContext> = {}): ApplicabilityContext {
  return {
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

  it('answer extraction applies on launched versions, inactive on drafts', () => {
    expect(statusOf('answer-extraction', makeCtx({ versionStatus: 'launched' }))).toBe('applies');
    expect(statusOf('answer-extraction', makeCtx({ versionStatus: 'draft' }))).toBe('inactive');
  });

  it('structure edit applies on drafts, inactive once launched', () => {
    expect(statusOf('structure-edit', makeCtx({ versionStatus: 'draft' }))).toBe('applies');
    expect(statusOf('structure-edit', makeCtx({ versionStatus: 'launched' }))).toBe('inactive');
  });

  it('data-slot generation applies on any version', () => {
    expect(statusOf('data-slot-generation', makeCtx())).toBe('applies');
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

  it('turn inspector needs the inspector toggle on', () => {
    const on = makeCtx({
      config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, previewInspectorEnabled: true },
    });
    expect(statusOf('turn-inspector', on)).toBe('applies');
    // Toggle off → inactive (per-version config gate off).
    expect(
      statusOf(
        'turn-inspector',
        makeCtx({ config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, previewInspectorEnabled: false } })
      )
    ).toBe('inactive');
  });

  it('design evaluation, config advisor, and report config assistant apply on any version', () => {
    expect(statusOf('design-evaluation', makeCtx())).toBe('applies');
    expect(statusOf('config-advisor', makeCtx())).toBe('applies');
    expect(statusOf('report-config-assistant', makeCtx())).toBe('applies');
  });

  it('agent settings advisor applies workspace-wide', () => {
    // Workspace-level (not version-specific): available whenever the surface is on.
    expect(statusOf('agent-settings-advisor', makeCtx())).toBe('applies');
  });

  it('turn evaluation needs captured turns', () => {
    const on = makeCtx({
      config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, previewInspectorEnabled: true },
    });
    expect(statusOf('turn-evaluation', on)).toBe('applies');
    // No inspector (no captured turns) → inactive.
    expect(
      statusOf(
        'turn-evaluation',
        makeCtx({ config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, previewInspectorEnabled: false } })
      )
    ).toBe('inactive');
  });
});
