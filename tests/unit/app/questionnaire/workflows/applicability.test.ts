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
import { WORKFLOW_DIAGRAMS, getWorkflowDiagram } from '@/lib/app/questionnaire/workflows/registry';
import type {
  ApplicabilityContext,
  ApplicabilityStatus,
} from '@/lib/app/questionnaire/workflows/types';

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

  // The four Experience diagrams (switcher, meeting, run-lifecycle, experience-wide synthesis)
  // document pipelines that compose WHOLE questionnaires — a switcher's follow-up leg, a meeting's
  // breakout, a run spanning legs, a synthesis over finished step reports. None of them is scoped to
  // a single version the way e.g. `structure-edit` or `data-slot-turn` are, so their `applicability`
  // predicates deliberately ignore the per-version context entirely and always report `applies`. Each
  // case below drives the SAME diagram across contexts that would flip a version-scoped predicate
  // (draft vs launched, zero counts, disabled config) to pin that indifference as intentional rather
  // than an oversight — a predicate that started reading `ctx` would need this test updated too.
  it.each([
    ['experience-switcher', 'Agentic switcher (opening leg → follow-up leg)'],
    ['experience-meeting', 'Facilitated meeting (breakout runtime)'],
    ['experience-run-lifecycle', 'Run lifecycle & continuity (multi-leg journey)'],
    ['experience-synthesis', 'Experience-wide synthesis (across finished step reports)'],
  ] as const)('%s applies regardless of per-version context — %s', (slug, _label) => {
    // Draft, no source documents, no data slots, no round items, disabled reports — every signal a
    // version-scoped diagram gates on, all set to the "off" value. Still `applies`.
    expect(
      statusOf(
        slug,
        makeCtx({
          versionStatus: 'draft',
          sourceDocumentCount: 0,
          dataSlotCount: 0,
          roundItemCount: 0,
          goalProvenance: null,
        })
      )
    ).toBe('applies');

    // Launched, fully populated — also `applies`, because the gate the other diagrams apply here
    // simply does not exist for an experience-scoped pipeline.
    expect(
      statusOf(
        slug,
        makeCtx({
          versionStatus: 'launched',
          sourceDocumentCount: 5,
          dataSlotCount: 5,
          roundItemCount: 5,
          goalProvenance: 'admin-supplied',
        })
      )
    ).toBe('applies');
  });
});

describe('workflow applicability — exhaustiveness guard', () => {
  const VALID_STATUSES: readonly ApplicabilityStatus[] = ['applies', 'inactive', 'unavailable'];

  // Representative contexts spanning the gates every existing predicate reads: a freshly launched
  // version with content, an empty draft, and a fully-configured launched version. A NEW diagram
  // dropped into the registry without ever being named in this file is still exercised here, so its
  // `applicability` can never sit at 0% coverage the way the four Experience diagrams above did
  // before this test existed — and a predicate that throws or returns a malformed shape fails CI
  // immediately rather than silently rendering as a broken chip in the picker.
  const REPRESENTATIVE_CONTEXTS: readonly [string, ApplicabilityContext][] = [
    ['launched, populated', makeCtx({ versionStatus: 'launched' })],
    [
      'draft, empty',
      makeCtx({
        versionStatus: 'draft',
        sourceDocumentCount: 0,
        dataSlotCount: 0,
        roundItemCount: 0,
        goalProvenance: null,
      }),
    ],
    [
      'launched, fully configured',
      makeCtx({
        versionStatus: 'launched',
        sourceDocumentCount: 5,
        dataSlotCount: 5,
        roundItemCount: 5,
        goalProvenance: 'admin-supplied',
        config: {
          ...DEFAULT_QUESTIONNAIRE_CONFIG,
          previewInspectorEnabled: true,
          respondentReport: {
            ...DEFAULT_QUESTIONNAIRE_CONFIG.respondentReport,
            enabled: true,
            mode: 'narrative',
          },
          cohortReport: { ...DEFAULT_QUESTIONNAIRE_CONFIG.cohortReport, enabled: true },
        },
      }),
    ],
  ];

  it('every registered diagram returns a valid, non-empty WorkflowApplicability across representative contexts', () => {
    for (const diagram of WORKFLOW_DIAGRAMS) {
      for (const [label, ctx] of REPRESENTATIVE_CONTEXTS) {
        const result = diagram.applicability(ctx);
        expect(
          VALID_STATUSES.includes(result.status),
          `${diagram.slug} (${label}) → unexpected status "${result.status}"`
        ).toBe(true);
        expect(
          typeof result.reason === 'string' && result.reason.length > 0,
          `${diagram.slug} (${label}) → empty or missing reason`
        ).toBe(true);
      }
    }
  });
});
