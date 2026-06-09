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

import { buildTurnInvokers } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-invokers';
import {
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  REFINE_ANSWER_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
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
      costBudgetUsd: null,
      maxQuestionsPerSession: null,
      voiceEnabled: false,
      contradictionMode: 'flag',
      contradictionWindowN: 3,
      contradictionEveryNTurns: 1,
      anonymousMode: false,
      profileFields: [],
      answerSlotPanelScope: 'full_progress',
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
    flags: { extraction: true, contradiction: true, refinement: true, completion: true },
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

  it('short-circuits with a diagnostic when there is no active question', async () => {
    const inv = await invokers({ activeQuestionKey: null });
    const out = await inv.extractAnswers(state());
    expect(out).toMatchObject({ intents: [], diagnostic: 'no_active_question' });
    expect(dispatcherMock.dispatch).not.toHaveBeenCalled();
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
  it('extractAnswers surfaces the capability data costUsd', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { intents: [], droppedCount: 0, costUsd: 0.0123 },
    });
    const inv = await invokers();
    expect((await inv.extractAnswers(state())).costUsd).toBe(0.0123);
  });

  it('detectContradictions surfaces the capability data costUsd', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { findings: [], droppedCount: 0, costUsd: 0.004 },
    });
    const inv = await invokers();
    expect((await inv.detectContradictions(state())).costUsd).toBe(0.004);
  });

  it('refineAnswer surfaces the capability data costUsd', async () => {
    (dispatcherMock.dispatch as Mock).mockResolvedValue({
      success: true,
      data: { decisions: [], droppedCount: 0, costUsd: 0.002 },
    });
    const inv = await invokers();
    expect((await inv.refineAnswer(state(), {})).costUsd).toBe(0.002);
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
