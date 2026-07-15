/**
 * Integration test: the live turn invokers (F6.1, PR4).
 *
 * Prisma (agent bindings), the capability dispatcher, and the adaptive-deps builder are
 * mocked; the real F4.1 selection strategy runs. Pins each invoker's arg mapping
 * (TurnState → capability args), the entityContext binding, fail-soft on dispatch failure,
 * and the unconfigured-agent / no-active-question short-circuits.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({ aiAgent: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const dispatcherMock = vi.hoisted(() => ({ dispatch: vi.fn(), register: vi.fn() }));
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: dispatcherMock,
}));

const adaptiveMock = vi.hoisted(() => ({ buildAdaptiveDeps: vi.fn(() => ({})) }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/adaptive-deps', () => adaptiveMock);

const dataSlotSelectionMock = vi.hoisted(() => ({ selectNextDataSlot: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/data-slot-selection', () => ({
  selectNextDataSlot: dataSlotSelectionMock.selectNextDataSlot,
}));

// Mocks for assessSeriousness: provider resolution, getProvider, structured completion, and
// logCost (fire-and-forget — a no-op here so the test doesn't hit Prisma/SDK).
const resolverMock = vi.hoisted(() => ({ resolveAgentProviderAndModel: vi.fn() }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => resolverMock);

const providerManagerMock = vi.hoisted(() => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/provider-manager', () => providerManagerMock);

const structuredMock = vi.hoisted(() => ({
  runStructuredCompletion: vi.fn(),
  tryParseJson: vi.fn(),
}));
vi.mock('@/lib/orchestration/evaluations/parse-structured', () => structuredMock);
// runStructuredCompletion moved to its own module (Sunrise #417); mock it there
// with the same hoisted fn so the assertions below keep observing calls.
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: structuredMock.runStructuredCompletion,
}));

const logCostMock = vi.hoisted(() => ({
  logCost: vi.fn().mockResolvedValue(null),
  calculateCost: vi.fn().mockReturnValue({ totalCostUsd: 0 }),
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => logCostMock);

const loggerMock = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: loggerMock }));

import { buildTurnInvokers } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-invokers';
import {
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  REFINE_ANSWER_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  DEFAULT_RESPONDENT_REPORT_SETTINGS,
  DEFAULT_COHORT_REPORT_SETTINGS,
  DEFAULT_INTRO_SETTINGS,
  DEFAULT_TONE_SETTINGS,
  DEFAULT_INTERVIEWER_STRATEGY,
} from '@/lib/app/questionnaire/types';
import type { TurnState } from '@/lib/app/questionnaire/orchestrator';
import type { CapabilitySlotView } from '@/app/api/v1/app/questionnaires/_lib/turn-context';

type Mock = ReturnType<typeof vi.fn>;

const SLOTS: CapabilitySlotView[] = [
  {
    id: 'q1',
    key: 'role',
    sectionId: 's1',
    prompt: 'Role?',
    type: 'free_text',
    required: true,
    guidelines: 'be specific',
  },
  {
    id: 'q2',
    key: 'team',
    sectionId: 's1',
    prompt: 'Team?',
    type: 'numeric',
    required: false,
    typeConfig: { min: 0 },
  },
];

function state(over: Partial<TurnState> = {}): TurnState {
  return {
    sessionId: 'sess-1',
    userMessage: 'I do marketing',
    config: {
      selectionStrategy: 'sequential',
      minQuestionsAnswered: 0,
      coverageThreshold: 1,
      answerConfidenceFloor: 0.5,
      allowEarlyFinish: false,
      earlyFinishMinCoverage: 0.5,
      earlyFinishMinQuestions: 0,
      interviewerStrategy: DEFAULT_INTERVIEWER_STRATEGY,
      costBudgetUsd: null,
      maxQuestionsPerSession: null,
      voiceEnabled: false,
      attachmentsEnabled: false,
      contradictionMode: 'flag',
      contradictionWindowN: 3,
      contradictionEveryNTurns: 1,
      answerFitMode: 'fallback',
      extractionPrefilter: false,
      anonymousMode: false,
      accessMode: 'invitation_only',
      inviteeFields: [],
      abuseThreshold: 4,
      maxDataSlotAttempts: 2,
      sensitivityAwareness: false,
      supportMessage: '',
      supportResourceUrl: '',
      profileFields: [],
      answerSlotPanelScope: 'full_progress',
      presentationMode: 'chat',
      captureMode: 'form',
      inlineCorrectionEnabled: true,
      reasoningStreamEnabled: true,
      reasoningStreamPlacement: 'overlay',
      reasoningStreamDwellMs: 2000,
      reasoningStreamPerItemMs: 330,
      reasoningStreamPersist: true,
      previewInspectorEnabled: false,
      tone: DEFAULT_TONE_SETTINGS,
      personas: [],
      personaSelection: {
        enabled: false,
        defaultPersonaKey: 'neutral-coach',
        allowRespondentSwitch: false,
        switcher: 'page',
      },
      respondentReport: DEFAULT_RESPONDENT_REPORT_SETTINGS,
      cohortReport: DEFAULT_COHORT_REPORT_SETTINGS,
      intro: DEFAULT_INTRO_SETTINGS,
    },
    questions: [
      {
        id: 'q1',
        key: 'role',
        sectionId: 's1',
        sectionOrdinal: 0,
        ordinal: 0,
        weight: 1,
        required: true,
        type: 'free_text',
        tagIds: [],
        prompt: 'Role?',
      },
      {
        id: 'q2',
        key: 'team',
        sectionId: 's1',
        sectionOrdinal: 0,
        ordinal: 1,
        weight: 1,
        required: false,
        type: 'numeric',
        tagIds: [],
        prompt: 'Team?',
      },
    ],
    answered: [],
    existingAnswers: [
      {
        slotKey: 'role',
        value: 'marketing',
        provenance: 'direct',
        confidence: 0.9,
        rationale: 'said',
      },
    ],
    recentMessages: ['hi', 'Role?'],
    selectionRound: 1,
    abuseStrikes: 0,
    flags: {
      extraction: true,
      contradiction: true,
      refinement: true,
      completion: true,
      seriousnessGate: false,
      sensitivityAwareness: false,
    },
    ...over,
  };
}

const binding = { id: 'agent-x', provider: 'openai', model: 'gpt', fallbackProviders: [] };

async function invokers(opts: Partial<Parameters<typeof buildTurnInvokers>[0]> = {}) {
  return buildTurnInvokers({
    userId: 'user-1',
    slots: SLOTS,
    activeQuestionKey: 'role',
    adaptiveEnabled: false,
    ...opts,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.aiAgent.findUnique.mockResolvedValue(binding);
  // Restore logCost to a no-op default so assessSeriousness happy-path tests aren't affected.
  logCostMock.logCost.mockResolvedValue(null);
});

describe('extractAnswers', () => {
  it('dispatches the extractor with mapped args + entityContext, returning intents', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { intents: [{ slotKey: 'role', value: 'x' }], droppedCount: 0, costUsd: 0 },
    });
    const inv = await invokers();
    const out = await inv.extractAnswers(state());

    expect(out.intents).toHaveLength(1);
    const [slug, args, ctx] = (dispatcherMock.dispatch as Mock).mock.calls[0];
    expect(slug).toBe(EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG);
    expect(args).toMatchObject({
      userMessage: 'I do marketing',
      activeQuestionKey: 'role',
      answered: [{ slotKey: 'role', confidence: 0.9 }],
      recentMessages: ['hi', 'Role?'],
      sessionId: 'sess-1',
    });
    expect(args.candidateSlots[0]).toMatchObject({ key: 'role', guidelines: 'be specific' });
    expect(ctx.entityContext.answerExtractorAgent).toEqual({
      provider: 'openai',
      model: 'gpt',
      fallbackProviders: [],
    });
  });

  it('records the extraction trace, plus a separate Answer-fit resolver trace when that pass ran', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: {
        intents: [{ slotKey: 'role', value: 'x' }],
        droppedCount: 0,
        costUsd: 0.01,
        answerFitCall: {
          model: 'gpt-4o',
          provider: 'openai',
          costUsd: 0.004,
          tokensIn: 300,
          tokensOut: 12,
          prompt: [{ role: 'user', content: 'resolve these choice answers' }],
          response: '{"answers":[{"slotKey":"team","value":"sales"}]}',
        },
      },
    });
    const recordInspectorCall = vi.fn();
    const inv = await invokers({ recordInspectorCall });
    await inv.extractAnswers(state());

    const labels = recordInspectorCall.mock.calls.map((c) => c[0].label);
    expect(labels).toEqual(['Answer extraction', 'Answer-fit resolver']);
    const fit = recordInspectorCall.mock.calls[1][0];
    expect(fit.costUsd).toBe(0.004);
    expect(fit.tokensIn).toBe(300);
    expect(fit.response).toContain('"slotKey":"team"');
  });

  it('records only the extraction trace when the answer-fit pass did not run', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { intents: [], droppedCount: 0, costUsd: 0.01 }, // no answerFitCall
    });
    const recordInspectorCall = vi.fn();
    const inv = await invokers({ recordInspectorCall });
    await inv.extractAnswers(state());

    expect(recordInspectorCall.mock.calls.map((c) => c[0].label)).toEqual(['Answer extraction']);
  });

  it('short-circuits with a diagnostic when there is no active question AND no data slots', async () => {
    const inv = await invokers({ activeQuestionKey: null });
    const out = await inv.extractAnswers(state());
    expect(out).toMatchObject({ intents: [], diagnostic: 'no_active_question' });
    expect(dispatcherMock.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches in data-slot mode (no active question), omitting activeQuestionKey', async () => {
    // The bug: data-slot mode has no active question (the target is a data slot), so the old guard
    // returned `no_active_question` every turn and nothing was ever captured. With data slots
    // present the call must dispatch — extracting background question answers AND data-slot fills —
    // and must NOT send an activeQuestionKey (there is none).
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: {
        intents: [{ slotKey: 'role', value: 'x', isActiveQuestion: false }],
        dataSlotFills: [
          {
            dataSlotKey: 'strategy',
            value: 'aware',
            paraphrase: 'p',
            confidence: 0.9,
            provenance: 'direct',
          },
        ],
        droppedCount: 0,
        costUsd: 0,
      },
    });
    const inv = await invokers({
      activeQuestionKey: null,
      dataSlotCandidates: [
        {
          key: 'strategy',
          name: 'Strategy Awareness',
          description: 'd',
          theme: 'Strategy',
          // Existing fill → the extractor must see it so a correction updates rather than re-derives.
          current: { value: 'aware', paraphrase: 'Aware of the strategy.', confidence: 0.8 },
        },
      ],
    });
    const out = await inv.extractAnswers(state());

    expect(out.diagnostic).toBeUndefined();
    expect(out.intents).toHaveLength(1);
    expect(out.dataSlotFills).toHaveLength(1);
    const [, args] = (dispatcherMock.dispatch as Mock).mock.calls[0];
    expect(args).not.toHaveProperty('activeQuestionKey');
    expect(args.dataSlotCandidates).toHaveLength(1);
    expect(args.dataSlotCandidates[0].current).toMatchObject({
      paraphrase: 'Aware of the strategy.',
    });
  });

  it('short-circuits when the extractor agent is unconfigured', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    const inv = await invokers();
    const out = await inv.extractAnswers(state());
    expect(out).toMatchObject({ intents: [], diagnostic: 'extractor_unconfigured' });
  });

  it('fail-soft maps a dispatch failure to an empty outcome + diagnostic', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'extraction_failed' },
    });
    const inv = await invokers();
    const out = await inv.extractAnswers(state());
    expect(out).toMatchObject({ intents: [], diagnostic: 'extraction_failed' });
  });
});

describe('detectContradictions', () => {
  it('dispatches the detector with the config mode + window and the answers', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: {
        findings: [{ slotKeys: ['role'], explanation: 'x', severity: 'low', confidence: 0.5 }],
        droppedCount: 0,
        costUsd: 0,
      },
    });
    const inv = await invokers();
    const out = await inv.detectContradictions(state());

    expect(out.findings).toHaveLength(1);
    const [slug, args] = (dispatcherMock.dispatch as Mock).mock.calls[0];
    expect(slug).toBe(DETECT_CONTRADICTIONS_CAPABILITY_SLUG);
    expect(args).toMatchObject({ mode: 'flag', windowN: 3, sessionId: 'sess-1' });
    expect(args.answers[0]).toMatchObject({
      slotKey: 'role',
      value: 'marketing',
      provenance: 'direct',
    });
  });

  it('fail-soft on dispatch failure', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'detection_failed' },
    });
    const inv = await invokers();
    expect(await inv.detectContradictions(state())).toMatchObject({
      findings: [],
      diagnostic: 'detection_failed',
    });
  });
});

describe('refineAnswer', () => {
  it('dispatches the refiner with the triggering contradiction + existing answers', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { decisions: [{ slotKey: 'role', action: 'refine' }], droppedCount: 0, costUsd: 0 },
    });
    const inv = await invokers();
    const out = await inv.refineAnswer(state(), {
      contradiction: {
        slotKeys: ['role', 'team'],
        explanation: 'conflict',
        severity: 'medium',
        confidence: 0.7,
        suggestedProbe: 'which?',
      },
    });

    expect(out.decisions).toHaveLength(1);
    const [slug, args] = (dispatcherMock.dispatch as Mock).mock.calls[0];
    expect(slug).toBe(REFINE_ANSWER_CAPABILITY_SLUG);
    expect(args.triggeringContradiction).toMatchObject({
      slotKeys: ['role', 'team'],
      suggestedProbe: 'which?',
    });
    expect(args.existingAnswers[0]).toMatchObject({ slotKey: 'role', value: 'marketing' });
  });

  it('fail-soft on dispatch failure', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: false,
      error: { code: 'refinement_failed' },
    });
    const inv = await invokers();
    expect(await inv.refineAnswer(state(), {})).toMatchObject({
      decisions: [],
      diagnostic: 'refinement_failed',
    });
  });
});

describe('optional-field branches (the false sides of the arg spreads)', () => {
  // A minimal state: no transcript, an answer with no confidence/rationale, empty message.
  const minimal = () =>
    state({
      userMessage: '',
      recentMessages: [],
      existingAnswers: [{ slotKey: 'role', value: 'marketing', provenance: 'direct' }],
    });

  it('omits recentMessages + answer confidence/rationale when absent (extract + detect + refine)', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { intents: [], findings: [], decisions: [], droppedCount: 0 },
    });
    const inv = await invokers();

    await inv.extractAnswers(minimal());
    expect((dispatcherMock.dispatch as Mock).mock.calls[0][1]).not.toHaveProperty('recentMessages');
    expect((dispatcherMock.dispatch as Mock).mock.calls[0][1].answered[0]).toEqual({
      slotKey: 'role',
      confidence: null,
      // Enriched for the confirmation-refresh path (value/provenance/type travel with each answer).
      value: 'marketing',
      provenance: 'direct',
      questionType: 'free_text',
    });

    await inv.detectContradictions(minimal());
    const detectArgs = (dispatcherMock.dispatch as Mock).mock.calls[1][1];
    expect(detectArgs.answers[0]).not.toHaveProperty('confidence');

    // Refine with a trigger that has no suggestedProbe, and a blank user message.
    await inv.refineAnswer(minimal(), {
      contradiction: { slotKeys: ['role'], explanation: 'x', severity: 'low', confidence: 0.3 },
    });
    const refineArgs = (dispatcherMock.dispatch as Mock).mock.calls[2][1];
    expect(refineArgs).not.toHaveProperty('userMessage');
    expect(refineArgs).not.toHaveProperty('recentMessages');
    expect(refineArgs.triggeringContradiction).not.toHaveProperty('suggestedProbe');
    expect(refineArgs.existingAnswers[0]).not.toHaveProperty('rationale');
    expect(refineArgs.existingAnswers[0]).not.toHaveProperty('confidence');
  });

  it('omits the detector when unconfigured, and the refiner when unconfigured', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    const inv = await invokers();
    expect(await inv.detectContradictions(minimal())).toMatchObject({
      diagnostic: 'detector_unconfigured',
    });
    expect(await inv.refineAnswer(minimal(), {})).toMatchObject({
      diagnostic: 'refiner_unconfigured',
    });
  });
});

describe('cost surfacing (F6.3)', () => {
  it('maps costUsd from the capability data field — not an identity passthrough', async () => {
    // Arrange two different invokers producing different cost values to confirm the FIELD is
    // read (data.costUsd) and the result is placed on the outcome's costUsd property —
    // not just that a number passes through unchanged.
    (dispatcherMock.dispatch as Mock)
      .mockResolvedValueOnce({
        success: true,
        data: { intents: [], droppedCount: 0, costUsd: 0.0123 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { findings: [], droppedCount: 0, costUsd: 0.004 },
      });
    const inv = await invokers();

    const extractOut = await inv.extractAnswers(state());
    const detectOut = await inv.detectContradictions(state());

    // The invoker reads data.costUsd (not e.g. data.cost or data.totalCost) and surfaces it
    // unchanged on the outcome — verify both invokers map from the correct source field.
    expect(extractOut.costUsd).toBe(0.0123);
    expect(detectOut.costUsd).toBe(0.004);
  });

  it('falls back to 0 when the capability data omits costUsd', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { intents: [], droppedCount: 0 },
    });
    const inv = await invokers();
    expect((await inv.extractAnswers(state())).costUsd).toBe(0);
  });
});

describe('assessSeriousness', () => {
  // Happy-path provider stub — resolves to a concrete provider slug + model.
  const resolvedBinding = { providerSlug: 'openai', model: 'gpt-4o', fallbacks: [] };
  // A minimal provider stub: only the shape the invoker hands to runStructuredCompletion.
  const providerStub = { chat: vi.fn() };

  beforeEach(() => {
    resolverMock.resolveAgentProviderAndModel.mockResolvedValue(resolvedBinding);
    providerManagerMock.getProvider.mockResolvedValue(providerStub);
  });

  it('happy path: returns verdict.serious + costUsd from the structured completion', async () => {
    // Arrange: the structured completion returns a genuine verdict with token usage.
    structuredMock.runStructuredCompletion.mockResolvedValue({
      value: { serious: true, reason: 'Plausible answer' },
      tokenUsage: { input: 50, output: 20 },
      costUsd: 0.0042,
    });
    const inv = await invokers();

    // Act
    const out = await inv.assessSeriousness(state());

    // Assert: the invoker maps the completion's value onto the SeriousnessVerdict shape and
    // surfaces the completion's costUsd — neither field is the raw mock return value echoed
    // directly; the invoker constructs { verdict: { serious, reason }, costUsd } from it.
    expect(out.diagnostic).toBeUndefined();
    expect(out.verdict).toMatchObject({ serious: true, reason: 'Plausible answer' });
    // costUsd comes from completion.costUsd — not from tokenUsage or any other field.
    expect(out.costUsd).toBe(0.0042);
  });

  it('defaults reason to an empty string when the completion omits it', async () => {
    // L430 `reason: completion.value.reason ?? ''` — guards a verdict whose `reason` is absent
    // (distinct from a defined empty string, which takes the left arm of `??`).
    structuredMock.runStructuredCompletion.mockResolvedValue({
      value: { serious: true },
      tokenUsage: { input: 10, output: 5 },
      costUsd: 0.001,
    });
    const inv = await invokers();
    const out = await inv.assessSeriousness(state());

    expect(out.verdict).toEqual({ serious: true, reason: '' });
    expect(out.diagnostic).toBeUndefined();
  });

  it('no_provider_configured: resolveAgentProviderAndModel throws → safe null verdict', async () => {
    // Simulate a misconfigured environment where no provider can be resolved.
    resolverMock.resolveAgentProviderAndModel.mockRejectedValue(new Error('no provider'));
    const inv = await invokers();
    const out = await inv.assessSeriousness(state());

    // The invoker must not propagate the error; it returns a null verdict + the diagnostic code.
    expect(out.verdict).toBeNull();
    expect(out.costUsd).toBe(0);
    expect(out.diagnostic).toBe('no_provider_configured');
  });

  it('provider_unavailable: getProvider throws → safe null verdict', async () => {
    // Provider slug resolved fine but the provider itself is unreachable.
    providerManagerMock.getProvider.mockRejectedValue(new Error('provider down'));
    const inv = await invokers();
    const out = await inv.assessSeriousness(state());

    expect(out.verdict).toBeNull();
    expect(out.costUsd).toBe(0);
    expect(out.diagnostic).toBe('provider_unavailable');
  });

  it('seriousness_judge_failed: runStructuredCompletion throws → safe null verdict', async () => {
    // Both provider steps succeed but the LLM call / parse fails (e.g. both retry attempts
    // produce malformed JSON and onFinalFailure fires).
    structuredMock.runStructuredCompletion.mockRejectedValue(
      new Error('Seriousness verdict was not valid against the schema after one retry')
    );
    const inv = await invokers();
    const out = await inv.assessSeriousness(state());

    expect(out.verdict).toBeNull();
    expect(out.costUsd).toBe(0);
    expect(out.diagnostic).toBe('seriousness_judge_failed');
  });

  it('no context (no active question or data slot): keeps the answer WITHOUT an LLM call', async () => {
    // The bug this guards: judging blind — with "(no specific question)" — made a terse-but-genuine
    // answer read as non-genuine. With nothing to anchor on, the gate must keep the answer and skip
    // the paid call rather than risk a false positive.
    const inv = await invokers({ activeQuestionKey: null });
    const out = await inv.assessSeriousness(state({ activeDataSlotKey: null }));

    expect(out.verdict).toEqual({ serious: true, reason: '' });
    expect(out.costUsd).toBe(0);
    expect(out.diagnostic).toBeUndefined();
    expect(structuredMock.runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('data-slot mode (no active question): judges against the active data slot, not blind', async () => {
    // In data-slot mode there is no active question; the judge must use the active data slot's
    // name + description as the "question asked" so a terse answer is judged in context.
    structuredMock.runStructuredCompletion.mockResolvedValue({
      value: { serious: true, reason: '' },
      tokenUsage: { input: 30, output: 10 },
      costUsd: 0.001,
    });
    const inv = await invokers({ activeQuestionKey: null });
    const out = await inv.assessSeriousness(
      state({
        userMessage: '5 year, engineering',
        activeDataSlotKey: 'demographics',
        dataSlots: [
          {
            id: 'd1',
            key: 'demographics',
            name: 'Employee Demographics',
            description: 'Tenure with the company and department',
            theme: 'About you',
            ordinal: 0,
            weight: 1,
          },
        ],
      })
    );

    expect(out.verdict).toMatchObject({ serious: true });
    expect(structuredMock.runStructuredCompletion).toHaveBeenCalledTimes(1);
    // The data-slot context reached the judge prompt (not "(no specific question)").
    const messages = structuredMock.runStructuredCompletion.mock.calls[0][0].messages;
    const userMsg = messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('Employee Demographics');
  });

  it('parse callback: invokes tryParseJson with the raw string and the validator', async () => {
    // The `parse` option (lines 399-403) calls tryParseJson(raw, validator) then
    // validateSeriousnessVerdict on the parsed result. We exercise this path by making
    // runStructuredCompletion invoke the parse option and then checking that tryParseJson
    // was called with the raw string — proving the callback body ran.
    let capturedParseRaw: string | undefined;
    structuredMock.tryParseJson.mockImplementation((raw: string, fn: (p: unknown) => unknown) => {
      capturedParseRaw = raw;
      // Simulate a valid parsed verdict so the validator can run.
      return fn({ serious: true, reason: 'Good answer' });
    });
    structuredMock.runStructuredCompletion.mockImplementation(
      async (opts: { parse: (raw: string) => unknown }) => {
        opts.parse('{"serious":true,"reason":"Good answer"}');
        return {
          value: { serious: true, reason: 'Good answer' },
          tokenUsage: { input: 5, output: 5 },
          costUsd: 0,
        };
      }
    );

    const inv = await invokers();
    await inv.assessSeriousness(state());

    // The parse callback was invoked and forwarded the raw string to tryParseJson.
    expect(capturedParseRaw).toBe('{"serious":true,"reason":"Good answer"}');
  });

  it('onFinalFailure callback: returns an Error describing the schema mismatch', async () => {
    // The `onFinalFailure` option callback (line 405) is called when runStructuredCompletion
    // exhausts its retries. Here we invoke it directly via the mock to assert its return value.
    let capturedOnFinalFailure: (() => Error) | undefined;
    structuredMock.runStructuredCompletion.mockImplementation(
      async (opts: { onFinalFailure: () => Error }) => {
        capturedOnFinalFailure = opts.onFinalFailure;
        // Simulate a successful completion so the invoker doesn't take the error path.
        return {
          value: { serious: true, reason: '' },
          tokenUsage: { input: 5, output: 5 },
          costUsd: 0,
        };
      }
    );

    const inv = await invokers();
    await inv.assessSeriousness(state());

    // Verify the onFinalFailure factory creates an Error with the expected message.
    expect(capturedOnFinalFailure).toBeDefined();
    const err = capturedOnFinalFailure!();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Seriousness verdict was not valid');
  });

  it('logCost rejection is swallowed and does not affect the returned verdict', async () => {
    // The logCost call is fire-and-forget; its .catch() handler must not propagate the error.
    // Arrange: completion succeeds; logCost rejects.
    structuredMock.runStructuredCompletion.mockResolvedValue({
      value: { serious: true, reason: 'Fine' },
      tokenUsage: { input: 10, output: 5 },
      costUsd: 0.001,
    });
    logCostMock.logCost.mockRejectedValue(new Error('logCost db boom'));

    const inv = await invokers();
    const out = await inv.assessSeriousness(state());

    // The invoker returns the verdict normally — the cost write failure must not propagate.
    expect(out.verdict).toMatchObject({ serious: true, reason: 'Fine' });
    expect(out.costUsd).toBe(0.001);
    expect(out.diagnostic).toBeUndefined();

    // Allow the microtask to flush so the .catch() fires before we check the logger.
    await Promise.resolve();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'assess_seriousness: logCost rejected',
      expect.objectContaining({ sessionId: 'sess-1' })
    );
  });

  it('omits agentId from logCost call when the extractor binding is null', async () => {
    // When no extractor is seeded, the logCost call should not include agentId.
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    structuredMock.runStructuredCompletion.mockResolvedValue({
      value: { serious: false, reason: 'Joke answer' },
      tokenUsage: { input: 10, output: 5 },
      costUsd: 0.001,
    });

    // Build invokers with activeQuestionKey so the seriousness judge runs (no short-circuit).
    const inv = await invokers({ activeQuestionKey: 'role' });
    await inv.assessSeriousness(state());

    // Allow the microtask to flush so the fire-and-forget logCost runs.
    await Promise.resolve();

    // The logCost call must not include agentId when the extractor binding is absent.
    expect(logCostMock.logCost).toHaveBeenCalledWith(
      expect.not.objectContaining({ agentId: expect.anything() })
    );
  });
});

describe('detectContradictions — inspector trace', () => {
  const resolvedBinding = { providerSlug: 'openai', model: 'gpt-4o', fallbacks: [] };

  beforeEach(() => {
    resolverMock.resolveAgentProviderAndModel.mockResolvedValue(resolvedBinding);
  });

  it('records a contradiction-detection trace when recordInspectorCall is wired in', async () => {
    // Lines 385-395: the `if (recordInspectorCall)` branch in detectContradictions.
    // Arrange: a successful dispatch that returns findings.
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: {
        findings: [
          { slotKeys: ['role'], explanation: 'conflict', severity: 'low', confidence: 0.6 },
        ],
        droppedCount: 0,
        costUsd: 0.005,
      },
    });
    const recordInspectorCall = vi.fn();
    const inv = await invokers({ recordInspectorCall });

    await inv.detectContradictions(state());

    // The invoker must call recordInspectorCall with the detection trace — asserting it was
    // called with the constructed shape (label, costUsd read from data.costUsd) proves the
    // `if (recordInspectorCall)` branch ran and the trace was built from dispatch data, not mocks.
    expect(recordInspectorCall).toHaveBeenCalledTimes(1);
    const trace = recordInspectorCall.mock.calls[0][0];
    expect(trace.label).toBe('Contradiction detection');
    // costUsd comes from data.costUsd — verify the field is read, not a passthrough from dispatch
    expect(trace.costUsd).toBe(0.005);
    // response must be the serialised findings, not the raw dispatch object
    expect(trace.response).toContain('"conflict"');
    expect(trace.prompt).toEqual([{ role: 'input', content: expect.stringContaining('mode') }]);
  });
});

describe('refineAnswer — inspector trace', () => {
  const resolvedBinding = { providerSlug: 'openai', model: 'gpt-4o', fallbacks: [] };

  beforeEach(() => {
    resolverMock.resolveAgentProviderAndModel.mockResolvedValue(resolvedBinding);
  });

  it('records a refinement trace when recordInspectorCall is wired in', async () => {
    // Lines 452-463: the `if (recordInspectorCall)` branch in refineAnswer.
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: {
        decisions: [{ slotKey: 'role', action: 'accept' }],
        droppedCount: 0,
        costUsd: 0.007,
      },
    });
    const recordInspectorCall = vi.fn();
    const inv = await invokers({ recordInspectorCall });

    await inv.refineAnswer(state(), {
      contradiction: { slotKeys: ['role'], explanation: 'x', severity: 'low', confidence: 0.3 },
    });

    expect(recordInspectorCall).toHaveBeenCalledTimes(1);
    const trace = recordInspectorCall.mock.calls[0][0];
    expect(trace.label).toBe('Answer refinement');
    // costUsd is read from data.costUsd — different from any other number in the flow
    expect(trace.costUsd).toBe(0.007);
    // response contains the serialised decisions array — verifies the code builds it, not echoes mock
    expect(trace.response).toContain('"accept"');
  });
});

describe('selectDataSlot — disabled path', () => {
  it('returns null immediately when dataSlotAdaptiveEnabled is false (no selectNextDataSlot call)', async () => {
    // Line 497: the `if (!dataSlotAdaptiveEnabled) return null` early-out.
    dataSlotSelectionMock.selectNextDataSlot.mockResolvedValue({
      dataSlotKey: 'x',
      rationale: 'r',
      costUsd: 0,
    });
    const inv = await invokers({ dataSlotAdaptiveEnabled: false });

    const result = await inv.selectDataSlot!(
      state(),
      [{ id: 'd1', key: 'k', name: 'n', description: 'd', theme: 't', ordinal: 0, weight: 1 }],
      { activeTheme: null, parkedTheme: null }
    );

    expect(result).toBeNull();
    // The inner selectNextDataSlot must NOT have been called — the return null fired first.
    expect(dataSlotSelectionMock.selectNextDataSlot).not.toHaveBeenCalled();
  });
});

describe('assessSeriousness — inspector trace', () => {
  const resolvedBinding = { providerSlug: 'openai', model: 'gpt-4o', fallbacks: [] };
  const providerStub = { chat: vi.fn() };

  beforeEach(() => {
    resolverMock.resolveAgentProviderAndModel.mockResolvedValue(resolvedBinding);
    providerManagerMock.getProvider.mockResolvedValue(providerStub);
  });

  it('records a seriousness-judge trace when recordInspectorCall is wired in', async () => {
    // Lines 637-648: the `if (recordInspectorCall)` block inside assessSeriousness.
    // The trace must carry the verdict text in `response` (serialised JSON) and the
    // LLM messages in `prompt` — verifying the invoker builds the trace from the completion,
    // not from the mock return value.
    structuredMock.runStructuredCompletion.mockResolvedValue({
      value: { serious: false, reason: 'Typed gibberish' },
      tokenUsage: { input: 80, output: 25 },
      costUsd: 0.006,
    });
    const recordInspectorCall = vi.fn();
    const inv = await invokers({ recordInspectorCall });

    await inv.assessSeriousness(state());

    expect(recordInspectorCall).toHaveBeenCalledTimes(1);
    const trace = recordInspectorCall.mock.calls[0][0];
    expect(trace.label).toBe('Seriousness judge');
    expect(trace.model).toBe('gpt-4o');
    expect(trace.provider).toBe('openai');
    expect(trace.costUsd).toBe(0.006);
    expect(trace.tokensIn).toBe(80);
    expect(trace.tokensOut).toBe(25);
    // response is JSON.stringify({ serious: false, reason: ... }) — verifies the code serialises
    // the verdict it constructed, not the raw mock
    expect(trace.response).toContain('"serious"');
    expect(trace.response).toContain('false');
    // prompt carries the LLM messages (system + user) mapped through getTextContent
    expect(Array.isArray(trace.prompt)).toBe(true);
    expect(trace.prompt.length).toBe(2);
  });

  it('wires anonymous + recordInspectorCall into the adaptive deps for selectNext', async () => {
    // Line 485-487: the `...(anonymous ? { anonymous } : {})` and
    // `...(recordInspectorCall ? { recordInspectorCall } : {})` spreads in selectNext.
    const recordInspectorCall = vi.fn();
    const inv = await invokers({
      adaptiveEnabled: true,
      anonymous: true,
      recordInspectorCall,
    });
    await inv.selectNext(state({ config: { ...state().config, selectionStrategy: 'adaptive' } }));
    expect(adaptiveMock.buildAdaptiveDeps).toHaveBeenCalledWith(
      expect.objectContaining({ anonymous: true, recordInspectorCall })
    );
  });
});

describe('detectSensitivity', () => {
  const resolvedBinding = { providerSlug: 'openai', model: 'gpt-4o', fallbacks: [] };
  const providerStub = { chat: vi.fn() };

  beforeEach(() => {
    resolverMock.resolveAgentProviderAndModel.mockResolvedValue(resolvedBinding);
    providerManagerMock.getProvider.mockResolvedValue(providerStub);
  });

  it('happy path: normalises a detected verdict into an assessment + surfaces costUsd', async () => {
    structuredMock.runStructuredCompletion.mockResolvedValue({
      value: {
        detected: true,
        severity: 'high',
        category: 'workplace abuse',
        summary: 'Mistreated.',
      },
      tokenUsage: { input: 40, output: 15 },
      costUsd: 0.0031,
    });
    const inv = await invokers();

    const out = await inv.detectSensitivity(state({ userMessage: 'my boss abuses me' }));

    expect(out.diagnostic).toBeUndefined();
    expect(out.assessment).toEqual({
      detected: true,
      severity: 'high',
      category: 'workplace abuse',
      summary: 'Mistreated.',
    });
    expect(out.costUsd).toBe(0.0031);
  });

  it('returns assessment: null when the detector finds nothing', async () => {
    structuredMock.runStructuredCompletion.mockResolvedValue({
      value: { detected: false },
      tokenUsage: { input: 20, output: 5 },
      costUsd: 0.001,
    });
    const inv = await invokers();

    const out = await inv.detectSensitivity(state({ userMessage: 'work is fine' }));

    expect(out.assessment).toBeNull();
    expect(out.diagnostic).toBeUndefined();
  });

  it('runs the LLM call EVEN with no question/data-slot context (a disclosure needs no question)', async () => {
    // Unlike the seriousness judge, the detector must NOT short-circuit on absent context — a
    // disclosure is genuine regardless of what was asked.
    structuredMock.runStructuredCompletion.mockResolvedValue({
      value: { detected: true, severity: 'high', category: 'self-harm', summary: 'Distress.' },
      tokenUsage: { input: 20, output: 10 },
      costUsd: 0.002,
    });
    const inv = await invokers({ activeQuestionKey: null });

    const out = await inv.detectSensitivity(state({ activeDataSlotKey: null }));

    expect(structuredMock.runStructuredCompletion).toHaveBeenCalledTimes(1);
    expect(out.assessment?.severity).toBe('high');
  });

  it('no_provider_configured: resolver throws → safe null assessment', async () => {
    resolverMock.resolveAgentProviderAndModel.mockRejectedValue(new Error('no provider'));
    const inv = await invokers();

    const out = await inv.detectSensitivity(state());

    expect(out.assessment).toBeNull();
    expect(out.costUsd).toBe(0);
    expect(out.diagnostic).toBe('no_provider_configured');
  });

  it('provider_unavailable: getProvider throws → safe null assessment', async () => {
    providerManagerMock.getProvider.mockRejectedValue(new Error('provider down'));
    const inv = await invokers();

    const out = await inv.detectSensitivity(state());

    expect(out.assessment).toBeNull();
    expect(out.diagnostic).toBe('provider_unavailable');
  });

  it('sensitivity_detect_failed: runStructuredCompletion throws → safe null assessment', async () => {
    structuredMock.runStructuredCompletion.mockRejectedValue(new Error('bad json after retry'));
    const inv = await invokers();

    const out = await inv.detectSensitivity(state());

    expect(out.assessment).toBeNull();
    expect(out.costUsd).toBe(0);
    expect(out.diagnostic).toBe('sensitivity_detect_failed');
  });

  it('data-slot mode: uses the active data-slot name + description as the question prompt', async () => {
    // Line 679-685: the activeDataSlot branch inside detectSensitivity. When there is no active
    // question (data-slot mode), the code looks up the data-slot by activeDataSlotKey — the
    // resulting questionPrompt feeds the sensitivity detector so oblique disclosures are read in
    // context. Verifying the prompt reaches runStructuredCompletion proves the branch ran.
    structuredMock.runStructuredCompletion.mockResolvedValue({
      value: { detected: false },
      tokenUsage: { input: 25, output: 5 },
      costUsd: 0.001,
    });
    const inv = await invokers({ activeQuestionKey: null });

    await inv.detectSensitivity(
      state({
        userMessage: 'I feel very stressed',
        activeDataSlotKey: 'wellbeing',
        dataSlots: [
          {
            id: 'ds1',
            key: 'wellbeing',
            name: 'Employee Wellbeing',
            description: 'Overall health and stress levels',
            theme: 'Health',
            ordinal: 0,
            weight: 1,
          },
        ],
      })
    );

    expect(structuredMock.runStructuredCompletion).toHaveBeenCalledTimes(1);
    const messages = structuredMock.runStructuredCompletion.mock.calls[0][0].messages;
    const userMsg = messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';
    // The data-slot context must appear in the prompt, not a blank questionPrompt.
    expect(userMsg).toContain('Employee Wellbeing');
  });

  it('parse callback: invokes tryParseJson with the raw string and the sensitivity validator', async () => {
    // Lines 745-748: the `parse` option in detectSensitivity calls tryParseJson then
    // validateSensitivityDetectVerdict. Exercises this path the same way as the seriousness test.
    let capturedParseRaw: string | undefined;
    structuredMock.tryParseJson.mockImplementation((raw: string, fn: (p: unknown) => unknown) => {
      capturedParseRaw = raw;
      return fn({ detected: false, severity: 'none', category: 'none', summary: '' });
    });
    structuredMock.runStructuredCompletion.mockImplementation(
      async (opts: { parse: (raw: string) => unknown }) => {
        opts.parse('{"detected":false}');
        return {
          value: { detected: false },
          tokenUsage: { input: 5, output: 5 },
          costUsd: 0,
        };
      }
    );

    const inv = await invokers();
    await inv.detectSensitivity(state());

    expect(capturedParseRaw).toBe('{"detected":false}');
  });

  it('onFinalFailure callback: returns an Error describing the sensitivity schema mismatch', async () => {
    // Line 752-753: the `onFinalFailure` factory in detectSensitivity.
    let capturedOnFinalFailure: (() => Error) | undefined;
    structuredMock.runStructuredCompletion.mockImplementation(
      async (opts: { onFinalFailure: () => Error }) => {
        capturedOnFinalFailure = opts.onFinalFailure;
        return {
          value: { detected: false },
          tokenUsage: { input: 5, output: 5 },
          costUsd: 0,
        };
      }
    );

    const inv = await invokers();
    await inv.detectSensitivity(state());

    expect(capturedOnFinalFailure).toBeDefined();
    const err = capturedOnFinalFailure!();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Sensitivity verdict was not valid');
  });

  it('logCost rejection is swallowed and error is logged', async () => {
    // Line 768: the .catch() handler on the fire-and-forget logCost call inside detectSensitivity.
    structuredMock.runStructuredCompletion.mockResolvedValue({
      value: { detected: false },
      tokenUsage: { input: 10, output: 5 },
      costUsd: 0.001,
    });
    logCostMock.logCost.mockRejectedValue(new Error('logCost boom'));

    const inv = await invokers();
    const out = await inv.detectSensitivity(state());

    // The invoker must not propagate the logCost failure.
    expect(out.assessment).toBeNull();
    expect(out.diagnostic).toBeUndefined();

    // Allow the microtask to flush so the .catch() fires.
    await Promise.resolve();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'detect_sensitivity: logCost rejected',
      expect.objectContaining({ sessionId: 'sess-1' })
    );
  });

  it('records a sensitivity-detection inspector trace when recordInspectorCall is wired in', async () => {
    // Lines 776-787: the `if (recordInspectorCall)` block inside detectSensitivity.
    structuredMock.runStructuredCompletion.mockResolvedValue({
      value: {
        detected: true,
        severity: 'high',
        category: 'self-harm',
        summary: 'Expressed distress.',
      },
      tokenUsage: { input: 60, output: 20 },
      costUsd: 0.004,
    });
    const recordInspectorCall = vi.fn();
    const inv = await invokers({ recordInspectorCall });

    await inv.detectSensitivity(state({ userMessage: 'I feel like giving up' }));

    expect(recordInspectorCall).toHaveBeenCalledTimes(1);
    const trace = recordInspectorCall.mock.calls[0][0];
    expect(trace.label).toBe('Sensitivity detection');
    expect(trace.model).toBe('gpt-4o');
    expect(trace.provider).toBe('openai');
    expect(trace.costUsd).toBe(0.004);
    expect(trace.tokensIn).toBe(60);
    expect(trace.tokensOut).toBe(20);
    // response is the serialised normalizeSensitivityVerdict output — proves the code used the
    // normalised assessment, not the raw mock
    expect(trace.response).toContain('"detected"');
    // prompt carries the LLM messages mapped through getTextContent
    expect(Array.isArray(trace.prompt)).toBe(true);
    expect(trace.prompt.length).toBe(2);
  });
});

describe('extractAnswers — sensitivity-aware branch', () => {
  it('passes sensitivityAware: true to the extractor when the invoker was built with that flag', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: {
        intents: [],
        droppedCount: 0,
        costUsd: 0,
        // Sensitivity outcome — the extractor detected a sensitive disclosure.
        sensitivity: { detected: true, severity: 'medium', category: 'distress', summary: 's' },
      },
    });
    const inv = await invokers({ sensitivityAware: true });
    const out = await inv.extractAnswers(state());

    // The invoker must pass sensitivityAware to the capability and surface the result.
    const [, args] = (dispatcherMock.dispatch as Mock).mock.calls[0];
    expect(args.sensitivityAware).toBe(true);
    expect(out.sensitivity).toMatchObject({ detected: true, severity: 'medium' });
  });

  it('omits sensitivityAware from the capability args when the flag is false (default)', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { intents: [], droppedCount: 0, costUsd: 0 },
    });
    const inv = await invokers({ sensitivityAware: false });
    await inv.extractAnswers(state());

    const [, args] = (dispatcherMock.dispatch as Mock).mock.calls[0];
    expect(args).not.toHaveProperty('sensitivityAware');
  });
});

describe('extractAnswers — answer-fit resolver threading', () => {
  it('passes answerFitMode to the extractor when the invoker was built with a non-off mode', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { intents: [], droppedCount: 0, costUsd: 0 },
    });
    const inv = await invokers({ answerFitMode: 'always' });
    await inv.extractAnswers(state());

    const [, args] = (dispatcherMock.dispatch as Mock).mock.calls[0];
    expect(args.answerFitMode).toBe('always');
  });

  it('omits answerFitMode from the capability args when the mode is off', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { intents: [], droppedCount: 0, costUsd: 0 },
    });
    const inv = await invokers({ answerFitMode: 'off' });
    await inv.extractAnswers(state());

    const [, args] = (dispatcherMock.dispatch as Mock).mock.calls[0];
    expect(args).not.toHaveProperty('answerFitMode');
  });

  it('omits answerFitMode when the option is absent (default)', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { intents: [], droppedCount: 0, costUsd: 0 },
    });
    const inv = await invokers();
    await inv.extractAnswers(state());

    const [, args] = (dispatcherMock.dispatch as Mock).mock.calls[0];
    expect(args).not.toHaveProperty('answerFitMode');
  });
});

describe('selectNext', () => {
  it('runs the deterministic strategy and returns a decision', async () => {
    const inv = await invokers();
    const out = await inv.selectNext(state({ answered: [] }));
    // sequential picks the first unanswered (required-first) → q1.
    expect(out.decision.kind).toBe('ask');
    expect(adaptiveMock.buildAdaptiveDeps).not.toHaveBeenCalled();
  });

  it('wires adaptive deps when the strategy is adaptive and the flag is on', async () => {
    const inv = await invokers({ adaptiveEnabled: true });
    await inv.selectNext(state({ config: { ...state().config, selectionStrategy: 'adaptive' } }));
    expect(adaptiveMock.buildAdaptiveDeps).toHaveBeenCalledWith({ userId: 'user-1' });
  });
});

describe('selectDataSlot — ranks by the current answer, not the prior question', () => {
  it("appends the respondent's current message to the transcript handed to the data-slot selector", async () => {
    dataSlotSelectionMock.selectNextDataSlot.mockResolvedValue(null);
    const inv = await invokers({ dataSlotAdaptiveEnabled: true });

    await inv.selectDataSlot!(
      state({
        // Persisted transcript ends with the interviewer's question; the answer is in userMessage.
        recentMessages: ['Tell me about your pipeline.'],
        userMessage: 'our pipeline is very poor and we have no sales methodology',
      }),
      [
        {
          id: 'd1',
          key: 'pipeline',
          name: 'Pipeline',
          description: '',
          theme: 'Sales',
          ordinal: 0,
          weight: 1,
        },
      ],
      { activeTheme: 'Sales', parkedTheme: null }
    );

    expect(dataSlotSelectionMock.selectNextDataSlot).toHaveBeenCalledTimes(1);
    const passed = dataSlotSelectionMock.selectNextDataSlot.mock.calls[0][0];
    // The current answer is the LAST transcript entry → it seeds the similarity query.
    expect(passed.recentMessages).toEqual([
      'Tell me about your pipeline.',
      'our pipeline is very poor and we have no sales methodology',
    ]);
  });

  it('leaves the transcript unchanged on a kickoff (empty userMessage)', async () => {
    dataSlotSelectionMock.selectNextDataSlot.mockResolvedValue(null);
    const inv = await invokers({ dataSlotAdaptiveEnabled: true });

    await inv.selectDataSlot!(
      state({ recentMessages: ['Welcome!'], userMessage: '' }),
      [
        {
          id: 'd1',
          key: 'pipeline',
          name: 'Pipeline',
          description: '',
          theme: 'Sales',
          ordinal: 0,
          weight: 1,
        },
      ],
      { activeTheme: null, parkedTheme: null }
    );

    const passed = dataSlotSelectionMock.selectNextDataSlot.mock.calls[0][0];
    expect(passed.recentMessages).toEqual(['Welcome!']);
  });
});
