/**
 * Shape-contract tests for `lib/app/questionnaire/views.ts`.
 *
 * This module exports only TypeScript interface declarations — no executable
 * JavaScript is emitted. V8 coverage therefore records 0 coverable statements
 * (100% by definition). These tests serve as compile-time + runtime contract
 * checks: they verify that the documented shapes can be constructed with
 * representative data (including every nullable/optional field in both states)
 * and that the interfaces remain internally consistent. Any breaking rename or
 * type change that makes these constructions fail to compile will be caught here.
 *
 * The pattern mirrors the team's approach for other pure-type modules: construct
 * typed values from Prisma-like input objects and assert their shape at runtime,
 * documenting the expected HTTP serialisation contract (dates as ISO strings,
 * nullables, enum passthrough, etc.).
 */

import { describe, it, expect } from 'vitest';

import type {
  TagView,
  QuestionnaireListItem,
  QuestionnaireVersionSummary,
  QuestionnaireDetail,
  QuestionSlotView,
  SectionView,
  ConfigView,
  VersionGraphView,
  EvaluationDimensionSummary,
  EvaluationFindingView,
  EvaluationSeed,
  EvaluationRunListItem,
  EvaluationRunDetail,
  TurnEvaluationListItem,
  TurnEvaluationDetail,
  RefLookupTurn,
  RefLookupResult,
} from '@/lib/app/questionnaire/views';

// ---------------------------------------------------------------------------
// Helpers — build representative instances of each interface shape.
// These helper functions are the "mappers under test": they simulate what a
// route serializer would do when projecting a Prisma row into the view shape.
// Each helper explicitly exercises nullable / optional fields in one of two
// states (null vs present) to cover both branches of the contract.
// ---------------------------------------------------------------------------

function makeTagView(overrides: Partial<TagView> = {}): TagView {
  return {
    id: 'tag-1',
    label: 'Housing',
    color: 'blue',
    ...overrides,
  };
}

/** Build a QuestionnaireListItem with all optional/nullable fields present. */
function makeQuestionnaireListItem(
  overrides: Partial<QuestionnaireListItem> = {}
): QuestionnaireListItem {
  return {
    id: 'q-1',
    title: 'Housing Survey',
    status: 'draft',
    versionCount: 3,
    latestVersion: {
      id: 'ver-3',
      versionNumber: 3,
      status: 'launched',
    },
    sectionCount: 4,
    questionCount: 12,
    dataSlotCount: 5,
    demoClient: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeQuestionnaireVersionSummary(
  overrides: Partial<QuestionnaireVersionSummary> = {}
): QuestionnaireVersionSummary {
  return {
    id: 'ver-1',
    versionNumber: 1,
    status: 'draft',
    goal: 'Understand housing affordability',
    audience: { ageRange: '25–45' } as unknown as QuestionnaireVersionSummary['audience'],
    sectionCount: 2,
    questionCount: 8,
    dataSlotCount: 3,
    changeCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeQuestionnaireDetail(
  overrides: Partial<QuestionnaireDetail> = {}
): QuestionnaireDetail {
  return {
    id: 'q-1',
    title: 'Housing Survey',
    status: 'draft',
    demoClient: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    versions: [makeQuestionnaireVersionSummary()],
    ...overrides,
  };
}

function makeQuestionSlotView(overrides: Partial<QuestionSlotView> = {}): QuestionSlotView {
  return {
    id: 'slot-1',
    ordinal: 0,
    key: 'housing_type',
    prompt: 'Do you own or rent?',
    guidelines: null,
    rationale: null,
    type: 'single_choice',
    typeConfig: { options: ['Own', 'Rent'] },
    required: true,
    weight: 1,
    extractionConfidence: null,
    tags: [],
    ...overrides,
  };
}

function makeSectionView(overrides: Partial<SectionView> = {}): SectionView {
  return {
    id: 'sec-1',
    ordinal: 0,
    title: 'Background',
    description: null,
    questions: [makeQuestionSlotView()],
    ...overrides,
  };
}

function makeConfigView(overrides: Partial<ConfigView> = {}): ConfigView {
  return {
    saved: true,
    selectionStrategy: 'sequential',
    minQuestionsAnswered: 3,
    coverageThreshold: 0.7,
    answerConfidenceFloor: 0.5,
    allowEarlyFinish: false,
    earlyFinishMinCoverage: 0.5,
    earlyFinishMinQuestions: 0,
    interviewerStrategy: {
      enabled: false,
      approach: 'funnel',
      probeDepth: false,
      reflect: false,
      batchRelated: false,
    },
    costBudgetUsd: null,
    maxQuestionsPerSession: null,
    voiceEnabled: false,
    attachmentsEnabled: false,
    contradictionMode: 'off',
    contradictionWindowN: 5,
    contradictionEveryNTurns: 3,
    answerFitMode: 'fallback',
    extractionPrefilter: true,
    anonymousMode: false,
    accessMode: 'invitation_only',
    inviteeFields: [],
    abuseThreshold: 3,
    maxDataSlotAttempts: 3,
    sensitivityAwareness: false,
    supportMessage: '',
    supportResourceUrl: '',
    profileFields: [],
    answerSlotPanelScope: 'full_progress',
    presentationMode: 'chat',
    inlineCorrectionEnabled: true,
    reasoningStreamEnabled: false,
    reasoningStreamPlacement: 'overlay',
    reasoningStreamDwellMs: 2000,
    reasoningStreamPerItemMs: 330,
    reasoningStreamPersist: false,
    previewInspectorEnabled: false,
    tone: {
      empathy: { enabled: false, level: 3 },
      mirroring: { enabled: false, level: 3 },
      formality: { enabled: false, level: 3 },
      mimicry: { enabled: false, level: 3 },
      verbosity: { enabled: false, level: 3 },
      warmth: { enabled: false, level: 3 },
      curiosity: { enabled: false, level: 3 },
      readingComplexity: { enabled: false, level: 3 },
      humour: { enabled: false, level: 3 },
      persona: { enabled: false, text: '' },
    },
    personas: [],
    personaSelection: { enabled: false, defaultPersonaKey: 'neutral-coach' },
    respondentReport: {
      enabled: false,
      mode: 'raw',
      rawIncludes: { dataSlots: false, questionsAsPresented: true },
      generation: {
        narrativeStyle: 'flowing',
        instructions: '',
        structure: '',
        backgroundContext: '',
        useClientKnowledge: false,
      },
      delivery: { onScreen: true, download: true },
    },
    cohortReport: {
      enabled: false,
      generation: {
        length: 'standard',
        detailLevel: 'standard',
        formality: 'business',
        instructions: '',
        structure: '',
        backgroundContext: '',
        useClientKnowledge: false,
        useRoundContext: true,
        useCohortContext: true,
        scoringEnabled: false,
      },
    },
    intro: { enabled: false, background: '', buttonLabel: '', videoUrl: '' },
    ...overrides,
  };
}

function makeVersionGraphView(overrides: Partial<VersionGraphView> = {}): VersionGraphView {
  return {
    id: 'ver-1',
    questionnaireId: 'q-1',
    versionNumber: 1,
    status: 'draft',
    goal: null,
    audience: null,
    goalProvenance: null,
    audienceProvenance: null,
    sections: [makeSectionView()],
    tags: [makeTagView()],
    config: makeConfigView(),
    ...overrides,
  };
}

function makeEvaluationDimensionSummary(
  overrides: Partial<EvaluationDimensionSummary> = {}
): EvaluationDimensionSummary {
  return {
    dimension: 'clarity',
    score: 0.85,
    findingCount: 2,
    diagnostic: null,
    ...overrides,
  };
}

function makeEvaluationFindingView(
  overrides: Partial<EvaluationFindingView> = {}
): EvaluationFindingView {
  return {
    id: 'finding-1',
    dimension: 'clarity',
    ordinal: 0,
    targetKey: 'housing_type',
    severity: 'minor',
    proposedChange: 'Rephrase to be more neutral',
    rationale: 'The wording implies a preferred answer',
    sourceQuote: null,
    status: 'pending',
    proposedEdit: null,
    editedOverride: null,
    decidedByUserId: null,
    decidedAt: null,
    appliedAt: null,
    appliedToVersionId: null,
    stale: false,
    applicable: 'manual',
    ...overrides,
  };
}

function makeEvaluationSeed(overrides: Partial<EvaluationSeed> = {}): EvaluationSeed {
  return {
    runId: 'run-1',
    findingId: 'finding-2',
    prompt: 'What is your household income?',
    type: 'free_text',
    guidelines: null,
    sectionKey: null,
    ...overrides,
  };
}

function makeEvaluationRunListItem(
  overrides: Partial<EvaluationRunListItem> = {}
): EvaluationRunListItem {
  return {
    id: 'run-1',
    status: 'completed',
    dimensionsRequested: 7,
    dimensionsRun: 7,
    dimensionsFailed: 0,
    totalFindings: 4,
    dimensionSummary: [makeEvaluationDimensionSummary()],
    triggeredByUserId: 'admin-1',
    startedAt: '2026-06-01T10:00:00.000Z',
    completedAt: '2026-06-01T10:02:00.000Z',
    createdAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeEvaluationRunDetail(
  overrides: Partial<EvaluationRunDetail> = {}
): EvaluationRunDetail {
  return {
    ...makeEvaluationRunListItem(),
    versionId: 'ver-1',
    questionnaireId: 'q-1',
    error: null,
    findings: [makeEvaluationFindingView()],
    ...overrides,
  };
}

function makeTurnEvaluationListItem(
  overrides: Partial<TurnEvaluationListItem> = {}
): TurnEvaluationListItem {
  return {
    id: 'eval-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    turnOrdinal: 2,
    overallScore: 82,
    effectiveness: 'Good',
    evaluatorModel: 'claude-sonnet-4-5',
    evaluatorProvider: 'anthropic',
    rubricVersion: '1.0.0',
    questionnaireVersionId: 'ver-1',
    questionnaireTitle: 'Housing Survey',
    questionnaireId: 'q-1',
    versionNumber: 3,
    flagStatus: 'none',
    commentPreview: null,
    datasetCaseId: null,
    costUsd: 0.004,
    createdAt: '2026-06-17T00:00:00.000Z',
    ...overrides,
  };
}

function makeTurnEvaluationDetail(
  overrides: Partial<TurnEvaluationDetail> = {}
): TurnEvaluationDetail {
  return {
    ...makeTurnEvaluationListItem(),
    appVersion: '1.2.3',
    evaluatorAgentId: 'agent-1',
    evaluatedByUserId: 'admin-1',
    verdict: { overallScore: 82, dimensions: [] },
    evaluatedInput: { turn: { turnIndex: 2, calls: [] }, context: [] },
    comment: null,
    commentByUserId: null,
    commentAt: null,
    flagReviewerId: null,
    flagUpdatedAt: null,
    datasetId: null,
    updatedAt: '2026-06-17T00:00:00.000Z',
    ...overrides,
  };
}

function makeRefLookupTurn(overrides: Partial<RefLookupTurn> = {}): RefLookupTurn {
  return {
    ordinal: 1,
    userMessagePreview: 'I rent a flat in Central London',
    agentResponsePreview: 'Whereabouts in Central London?',
    callCount: 2,
    hasTraces: true,
    evaluationCount: 1,
    createdAt: '2026-06-17T00:00:00.000Z',
    ...overrides,
  };
}

function makeRefLookupResult(overrides: Partial<RefLookupResult> = {}): RefLookupResult {
  return {
    session: {
      id: 'sess-1',
      ref: '7F3K9M2P',
      status: 'completed',
      isPreview: false,
      questionnaireTitle: 'Housing Survey',
      questionnaireId: 'q-1',
      versionId: 'ver-3',
      versionNumber: 3,
      createdAt: '2026-06-17T00:00:00.000Z',
    },
    turns: [makeRefLookupTurn()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TagView', () => {
  it('accepts a coloured tag', () => {
    const tag = makeTagView({ color: 'blue' });
    expect(tag.id).toBe('tag-1');
    expect(tag.color).toBe('blue');
  });

  it('accepts a tag with null color (uncoloured)', () => {
    const tag = makeTagView({ color: null });
    expect(tag.color).toBeNull();
  });
});

describe('QuestionnaireListItem', () => {
  it('carries all counts and ISO date strings', () => {
    const item = makeQuestionnaireListItem();
    expect(item.versionCount).toBe(3);
    expect(item.sectionCount).toBe(4);
    expect(item.questionCount).toBe(12);
    expect(item.dataSlotCount).toBe(5);
    // Dates must be ISO strings (cross-HTTP boundary serialisation rule).
    expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('accepts latestVersion: null when no version exists yet', () => {
    const item = makeQuestionnaireListItem({ latestVersion: null, versionCount: 0 });
    expect(item.latestVersion).toBeNull();
    expect(item.versionCount).toBe(0);
  });

  it('accepts latestVersion with all fields when a version is present', () => {
    const item = makeQuestionnaireListItem({
      latestVersion: { id: 'ver-3', versionNumber: 3, status: 'launched' },
    });
    expect(item.latestVersion?.versionNumber).toBe(3);
    expect(item.latestVersion?.status).toBe('launched');
  });

  it('accepts demoClient: null (generic / non-demo questionnaire)', () => {
    const item = makeQuestionnaireListItem({ demoClient: null });
    expect(item.demoClient).toBeNull();
  });

  it('passes status enum values through unchanged (draft | launched | archived)', () => {
    const statuses = ['draft', 'launched', 'archived'] as const;
    for (const status of statuses) {
      const item = makeQuestionnaireListItem({ status });
      expect(item.status).toBe(status);
    }
  });
});

describe('QuestionnaireVersionSummary', () => {
  it('carries goal and audience when present', () => {
    const summary = makeQuestionnaireVersionSummary({
      goal: 'Understand affordability',
      audience: { ageRange: '25–45' } as unknown as QuestionnaireVersionSummary['audience'],
    });
    expect(summary.goal).toBe('Understand affordability');
    expect(summary.audience).toMatchObject({ ageRange: '25–45' });
  });

  it('accepts null goal and audience (version with no goal/audience yet)', () => {
    const summary = makeQuestionnaireVersionSummary({ goal: null, audience: null });
    expect(summary.goal).toBeNull();
    expect(summary.audience).toBeNull();
  });

  it('carries ISO timestamps', () => {
    const summary = makeQuestionnaireVersionSummary();
    expect(summary.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(summary.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('QuestionnaireDetail', () => {
  it('embeds version summaries in newest-first order contract', () => {
    const versions = [
      makeQuestionnaireVersionSummary({ id: 'ver-2', versionNumber: 2 }),
      makeQuestionnaireVersionSummary({ id: 'ver-1', versionNumber: 1 }),
    ];
    const detail = makeQuestionnaireDetail({ versions });
    // The caller is responsible for ordering; the view shape carries whatever order is given.
    expect(detail.versions[0].versionNumber).toBe(2);
    expect(detail.versions[1].versionNumber).toBe(1);
  });

  it('accepts an empty versions array (brand-new questionnaire)', () => {
    const detail = makeQuestionnaireDetail({ versions: [] });
    expect(detail.versions).toHaveLength(0);
  });
});

describe('QuestionSlotView', () => {
  it('carries all core fields with null optionals', () => {
    const slot = makeQuestionSlotView();
    expect(slot.key).toBe('housing_type');
    expect(slot.type).toBe('single_choice');
    expect(slot.guidelines).toBeNull();
    expect(slot.rationale).toBeNull();
    expect(slot.extractionConfidence).toBeNull();
    expect(slot.tags).toHaveLength(0);
  });

  it('accepts extractionConfidence when present', () => {
    const slot = makeQuestionSlotView({ extractionConfidence: 0.93 });
    expect(slot.extractionConfidence).toBe(0.93);
  });

  it('accepts non-empty tags array', () => {
    const slot = makeQuestionSlotView({
      tags: [makeTagView(), makeTagView({ id: 'tag-2', label: 'Income' })],
    });
    expect(slot.tags).toHaveLength(2);
    expect(slot.tags[1].label).toBe('Income');
  });

  it('accepts guidelines and rationale when present', () => {
    const slot = makeQuestionSlotView({
      guidelines: 'Accept only UK postcodes',
      rationale: 'Needed for regional analysis',
    });
    expect(slot.guidelines).toBe('Accept only UK postcodes');
    expect(slot.rationale).toBe('Needed for regional analysis');
  });
});

describe('SectionView', () => {
  it('accepts null description', () => {
    const section = makeSectionView({ description: null });
    expect(section.description).toBeNull();
  });

  it('accepts a description when present', () => {
    const section = makeSectionView({ description: 'Background questions' });
    expect(section.description).toBe('Background questions');
  });

  it('carries its questions array', () => {
    const section = makeSectionView({
      questions: [makeQuestionSlotView(), makeQuestionSlotView({ id: 'slot-2', ordinal: 1 })],
    });
    expect(section.questions).toHaveLength(2);
    expect(section.questions[1].ordinal).toBe(1);
  });

  it('accepts an empty questions array', () => {
    const section = makeSectionView({ questions: [] });
    expect(section.questions).toHaveLength(0);
  });
});

describe('ConfigView', () => {
  it('carries saved: true when a config row exists', () => {
    const cfg = makeConfigView({ saved: true });
    expect(cfg.saved).toBe(true);
  });

  it('carries saved: false when the version has never had its config saved', () => {
    const cfg = makeConfigView({ saved: false });
    expect(cfg.saved).toBe(false);
  });

  it('accepts null costBudgetUsd and maxQuestionsPerSession (optional caps)', () => {
    const cfg = makeConfigView({ costBudgetUsd: null, maxQuestionsPerSession: null });
    expect(cfg.costBudgetUsd).toBeNull();
    expect(cfg.maxQuestionsPerSession).toBeNull();
  });

  it('accepts non-null costBudgetUsd and maxQuestionsPerSession', () => {
    const cfg = makeConfigView({ costBudgetUsd: 5.0, maxQuestionsPerSession: 20 });
    expect(cfg.costBudgetUsd).toBe(5.0);
    expect(cfg.maxQuestionsPerSession).toBe(20);
  });
});

describe('VersionGraphView', () => {
  it('accepts null goal, audience, and provenance fields (freshly created version)', () => {
    const graph = makeVersionGraphView({
      goal: null,
      audience: null,
      goalProvenance: null,
      audienceProvenance: null,
    });
    expect(graph.goal).toBeNull();
    expect(graph.audience).toBeNull();
    expect(graph.goalProvenance).toBeNull();
    expect(graph.audienceProvenance).toBeNull();
  });

  it('accepts goal and provenance when present', () => {
    const graph = makeVersionGraphView({
      goal: 'Understand affordability',
      goalProvenance: 'admin-supplied',
    });
    expect(graph.goal).toBe('Understand affordability');
    expect(graph.goalProvenance).toBe('admin-supplied');
  });

  it('carries the tag vocabulary and section tree', () => {
    const graph = makeVersionGraphView({
      tags: [makeTagView(), makeTagView({ id: 'tag-2', label: 'Income', color: null })],
      sections: [makeSectionView(), makeSectionView({ id: 'sec-2', ordinal: 1, title: 'Finance' })],
    });
    expect(graph.tags).toHaveLength(2);
    expect(graph.tags[1].label).toBe('Income');
    expect(graph.sections).toHaveLength(2);
    expect(graph.sections[1].title).toBe('Finance');
  });

  it('passes status enum values through unchanged', () => {
    const statuses = ['draft', 'launched', 'archived'] as const;
    for (const status of statuses) {
      const graph = makeVersionGraphView({ status });
      expect(graph.status).toBe(status);
    }
  });
});

describe('EvaluationDimensionSummary', () => {
  it('carries score and null diagnostic on a successful judge run', () => {
    const summary = makeEvaluationDimensionSummary({ score: 0.9, diagnostic: null });
    expect(summary.score).toBe(0.9);
    expect(summary.diagnostic).toBeNull();
  });

  it('carries null score and a diagnostic code when the judge failed', () => {
    const summary = makeEvaluationDimensionSummary({ score: null, diagnostic: 'TIMEOUT' });
    expect(summary.score).toBeNull();
    expect(summary.diagnostic).toBe('TIMEOUT');
  });

  it('passes all seven dimension values through unchanged', () => {
    const dims = [
      'clarity',
      'coverage',
      'duplicates',
      'type_fit',
      'ordering',
      'audience_match',
      'goal_match',
    ] as const;
    for (const dimension of dims) {
      const summary = makeEvaluationDimensionSummary({ dimension });
      expect(summary.dimension).toBe(dimension);
    }
  });
});

describe('EvaluationFindingView', () => {
  it('carries all null optional fields in the pending state', () => {
    const finding = makeEvaluationFindingView();
    expect(finding.sourceQuote).toBeNull();
    expect(finding.proposedEdit).toBeNull();
    expect(finding.editedOverride).toBeNull();
    expect(finding.decidedByUserId).toBeNull();
    expect(finding.decidedAt).toBeNull();
    expect(finding.appliedAt).toBeNull();
    expect(finding.appliedToVersionId).toBeNull();
  });

  it('carries proposedEdit and decidedByUserId when a decision was made', () => {
    const finding = makeEvaluationFindingView({
      proposedEdit: { op: 'replace_prompt', prompt: 'What tenure do you have?' },
      decidedByUserId: 'admin-1',
      decidedAt: '2026-06-17T12:00:00.000Z',
      status: 'accepted',
    });
    expect(finding.proposedEdit).toMatchObject({ op: 'replace_prompt' });
    expect(finding.decidedByUserId).toBe('admin-1');
    expect(finding.status).toBe('accepted');
  });

  it('carries appliedAt and appliedToVersionId when applied', () => {
    const finding = makeEvaluationFindingView({
      status: 'applied',
      appliedAt: '2026-06-17T13:00:00.000Z',
      appliedToVersionId: 'ver-2',
    });
    expect(finding.status).toBe('applied');
    expect(finding.appliedAt).toBe('2026-06-17T13:00:00.000Z');
    expect(finding.appliedToVersionId).toBe('ver-2');
  });

  it('carries editedOverride when the admin modified the proposed op', () => {
    const finding = makeEvaluationFindingView({
      editedOverride: { op: 'edit_guidelines', guidelines: 'Be concise' },
    });
    expect(finding.editedOverride).toMatchObject({ op: 'edit_guidelines' });
  });

  it('passes all severity values through unchanged', () => {
    for (const severity of ['info', 'minor', 'major'] as const) {
      expect(makeEvaluationFindingView({ severity }).severity).toBe(severity);
    }
  });

  it('passes all FindingReviewStatus values through unchanged', () => {
    for (const status of ['pending', 'accepted', 'declined', 'applied'] as const) {
      expect(makeEvaluationFindingView({ status }).status).toBe(status);
    }
  });

  it('passes all FindingApplicability values through unchanged', () => {
    for (const applicable of ['apply', 'deep-link', 'manual'] as const) {
      expect(makeEvaluationFindingView({ applicable }).applicable).toBe(applicable);
    }
  });

  it('carries stale: true when the finding is no longer actionable', () => {
    const finding = makeEvaluationFindingView({ stale: true });
    expect(finding.stale).toBe(true);
  });
});

describe('EvaluationSeed', () => {
  it('carries null guidelines and sectionKey for a fully-guided seed', () => {
    const seed = makeEvaluationSeed({ guidelines: null, sectionKey: null });
    expect(seed.guidelines).toBeNull();
    expect(seed.sectionKey).toBeNull();
  });

  it('carries guidelines and sectionKey when supplied by the judge', () => {
    const seed = makeEvaluationSeed({
      guidelines: 'Accept only 5-digit US ZIP codes',
      sectionKey: 'Demographics',
    });
    expect(seed.guidelines).toBe('Accept only 5-digit US ZIP codes');
    expect(seed.sectionKey).toBe('Demographics');
  });

  it('carries runId and findingId so the composer can stamp the finding applied', () => {
    const seed = makeEvaluationSeed({ runId: 'run-42', findingId: 'find-99' });
    expect(seed.runId).toBe('run-42');
    expect(seed.findingId).toBe('find-99');
  });
});

describe('EvaluationRunListItem', () => {
  it('carries ISO date strings (cross-HTTP boundary rule)', () => {
    const run = makeEvaluationRunListItem();
    expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(run.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts null completedAt when the run is still in progress', () => {
    const run = makeEvaluationRunListItem({ completedAt: null });
    expect(run.completedAt).toBeNull();
  });

  it('accepts null triggeredByUserId for unattributed runs', () => {
    const run = makeEvaluationRunListItem({ triggeredByUserId: null });
    expect(run.triggeredByUserId).toBeNull();
  });

  it('carries dimension failed/run/requested counts', () => {
    const run = makeEvaluationRunListItem({
      dimensionsRequested: 7,
      dimensionsRun: 6,
      dimensionsFailed: 1,
    });
    expect(run.dimensionsFailed).toBe(1);
  });

  it('carries a dimensionSummary array in dispatch order', () => {
    const run = makeEvaluationRunListItem({
      dimensionSummary: [
        makeEvaluationDimensionSummary({ dimension: 'clarity' }),
        makeEvaluationDimensionSummary({
          dimension: 'coverage',
          score: null,
          diagnostic: 'TIMEOUT',
        }),
      ],
    });
    expect(run.dimensionSummary).toHaveLength(2);
    expect(run.dimensionSummary[1].diagnostic).toBe('TIMEOUT');
  });

  it('accepts an empty dimensionSummary array', () => {
    const run = makeEvaluationRunListItem({ dimensionSummary: [] });
    expect(run.dimensionSummary).toHaveLength(0);
  });
});

describe('EvaluationRunDetail', () => {
  it('extends the list item with versionId, questionnaireId, error, and findings', () => {
    const detail = makeEvaluationRunDetail();
    expect(detail.versionId).toBe('ver-1');
    expect(detail.questionnaireId).toBe('q-1');
    expect(detail.error).toBeNull();
    expect(detail.findings).toHaveLength(1);
    // Inherited list-item fields should still be present.
    expect(detail.status).toBe('completed');
    expect(detail.totalFindings).toBe(4);
  });

  it('accepts an error string when the run failed', () => {
    const detail = makeEvaluationRunDetail({
      status: 'failed',
      error: 'LLM timeout after 30 s',
    });
    expect(detail.status).toBe('failed');
    expect(detail.error).toBe('LLM timeout after 30 s');
  });

  it('accepts an empty findings array', () => {
    const detail = makeEvaluationRunDetail({ findings: [] });
    expect(detail.findings).toHaveLength(0);
  });
});

describe('TurnEvaluationListItem', () => {
  it('carries ISO createdAt date string', () => {
    const item = makeTurnEvaluationListItem();
    expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts null turnId (evaluation without a linked turn row)', () => {
    const item = makeTurnEvaluationListItem({ turnId: null });
    expect(item.turnId).toBeNull();
  });

  it('accepts null enrichment fields when the version no longer resolves', () => {
    const item = makeTurnEvaluationListItem({
      questionnaireTitle: null,
      questionnaireId: null,
      versionNumber: null,
    });
    expect(item.questionnaireTitle).toBeNull();
    expect(item.questionnaireId).toBeNull();
    expect(item.versionNumber).toBeNull();
  });

  it('accepts null commentPreview when no comment exists', () => {
    const item = makeTurnEvaluationListItem({ commentPreview: null });
    expect(item.commentPreview).toBeNull();
  });

  it('carries a trimmed commentPreview when a comment exists', () => {
    const preview = 'The agent correctly identified the intent but…';
    const item = makeTurnEvaluationListItem({ commentPreview: preview });
    expect(item.commentPreview).toBe(preview);
  });

  it('accepts null datasetCaseId when not actioned into a dataset', () => {
    const item = makeTurnEvaluationListItem({ datasetCaseId: null });
    expect(item.datasetCaseId).toBeNull();
  });

  it('carries datasetCaseId when flagStatus is actioned', () => {
    const item = makeTurnEvaluationListItem({
      flagStatus: 'actioned',
      datasetCaseId: 'case-99',
    });
    expect(item.flagStatus).toBe('actioned');
    expect(item.datasetCaseId).toBe('case-99');
  });

  it('accepts null costUsd', () => {
    const item = makeTurnEvaluationListItem({ costUsd: null });
    expect(item.costUsd).toBeNull();
  });

  it('passes all flagStatus values through unchanged', () => {
    for (const flagStatus of ['none', 'flagged', 'reviewed', 'actioned', 'dismissed'] as const) {
      const item = makeTurnEvaluationListItem({ flagStatus });
      expect(item.flagStatus).toBe(flagStatus);
    }
  });
});

describe('TurnEvaluationDetail', () => {
  it('extends TurnEvaluationListItem with verdict and evaluatedInput as opaque JSON', () => {
    const detail = makeTurnEvaluationDetail({
      verdict: { overallScore: 82, breakdown: [] },
      evaluatedInput: { turn: { turnIndex: 2 }, context: ['prev turn'] },
    });
    expect(detail.verdict).toMatchObject({ overallScore: 82 });
    expect(detail.evaluatedInput).toMatchObject({ turn: { turnIndex: 2 } });
  });

  it('accepts null evaluatorAgentId (unattributed evaluator)', () => {
    const detail = makeTurnEvaluationDetail({ evaluatorAgentId: null });
    expect(detail.evaluatorAgentId).toBeNull();
  });

  it('accepts null comment fields when no comment has been left', () => {
    const detail = makeTurnEvaluationDetail({
      comment: null,
      commentByUserId: null,
      commentAt: null,
    });
    expect(detail.comment).toBeNull();
    expect(detail.commentByUserId).toBeNull();
    expect(detail.commentAt).toBeNull();
  });

  it('carries comment and ISO commentAt when a comment was added', () => {
    const detail = makeTurnEvaluationDetail({
      comment: 'Well handled ambiguous user intent',
      commentByUserId: 'admin-1',
      commentAt: '2026-06-17T09:00:00.000Z',
    });
    expect(detail.comment).toBe('Well handled ambiguous user intent');
    expect(detail.commentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('carries null flag fields before any flag action', () => {
    const detail = makeTurnEvaluationDetail({ flagReviewerId: null, flagUpdatedAt: null });
    expect(detail.flagReviewerId).toBeNull();
    expect(detail.flagUpdatedAt).toBeNull();
  });

  it('carries flagReviewerId and ISO flagUpdatedAt after a flag review', () => {
    const detail = makeTurnEvaluationDetail({
      flagStatus: 'reviewed',
      flagReviewerId: 'admin-2',
      flagUpdatedAt: '2026-06-18T08:00:00.000Z',
    });
    expect(detail.flagReviewerId).toBe('admin-2');
    expect(detail.flagUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('carries null datasetId and datasetCaseId when not linked to a dataset', () => {
    const detail = makeTurnEvaluationDetail({ datasetId: null, datasetCaseId: null });
    expect(detail.datasetId).toBeNull();
    expect(detail.datasetCaseId).toBeNull();
  });

  it('carries ISO updatedAt date string', () => {
    const detail = makeTurnEvaluationDetail();
    expect(detail.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('RefLookupTurn', () => {
  it('carries hasTraces: true when callCount > 0', () => {
    const turn = makeRefLookupTurn({ callCount: 3, hasTraces: true });
    expect(turn.hasTraces).toBe(true);
    expect(turn.callCount).toBe(3);
  });

  it('carries hasTraces: false and evaluationCount: 0 for a plain turn', () => {
    const turn = makeRefLookupTurn({ callCount: 0, hasTraces: false, evaluationCount: 0 });
    expect(turn.hasTraces).toBe(false);
    expect(turn.evaluationCount).toBe(0);
  });

  it('carries ISO createdAt date string', () => {
    const turn = makeRefLookupTurn();
    expect(turn.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('carries truncated message previews', () => {
    const turn = makeRefLookupTurn({
      userMessagePreview: 'a'.repeat(200) + '…',
      agentResponsePreview: 'b'.repeat(200) + '…',
    });
    expect(turn.userMessagePreview).toHaveLength(201);
    expect(turn.agentResponsePreview.endsWith('…')).toBe(true);
  });
});

describe('RefLookupResult', () => {
  it('carries a session with ISO createdAt', () => {
    const result = makeRefLookupResult();
    expect(result.session.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.session.ref).toBe('7F3K9M2P');
    // versionId is a required non-empty string on the session contract.
    expect(result.session.versionId).toBe('ver-3');
  });

  it('accepts null questionnaireTitle and questionnaireId when the version does not resolve', () => {
    const result = makeRefLookupResult({
      session: {
        id: 'sess-2',
        ref: 'AAAA1111',
        status: 'active',
        isPreview: true,
        questionnaireTitle: null,
        questionnaireId: null,
        versionId: 'ver-orphan',
        versionNumber: null,
        createdAt: '2026-06-17T00:00:00.000Z',
      },
    });
    expect(result.session.questionnaireTitle).toBeNull();
    expect(result.session.questionnaireId).toBeNull();
    expect(result.session.versionNumber).toBeNull();
  });

  it('carries the session isPreview flag', () => {
    const result = makeRefLookupResult({
      session: { ...makeRefLookupResult().session, isPreview: true },
    });
    expect(result.session.isPreview).toBe(true);
  });

  it('carries the turns array (may be empty)', () => {
    const result = makeRefLookupResult({ turns: [] });
    expect(result.turns).toHaveLength(0);
  });

  it('carries multiple turns with their respective data', () => {
    const result = makeRefLookupResult({
      turns: [
        makeRefLookupTurn({ ordinal: 1, evaluationCount: 2 }),
        makeRefLookupTurn({ ordinal: 2, callCount: 0, hasTraces: false }),
      ],
    });
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0].evaluationCount).toBe(2);
    expect(result.turns[1].hasTraces).toBe(false);
  });
});
