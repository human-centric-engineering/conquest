/**
 * Integration test: the session-status DB read seam (F7.3).
 *
 * `buildTurnContext` (the DB load), the cost-enforcement flag, and the per-session spend
 * sum are mocked; the real pure {@link assessCompletion}, {@link classifyCostCap}, and
 * {@link buildSessionStatusView} run. Pins the seam's own responsibilities: the
 * null-context → null return, the `status` narrowing + default fallback, the anonymous
 * flag (`respondentUserId === null`), the assessment passthrough, and — the seam's core
 * branch — when the cost tier is graded vs. reported as `null`: only when a positive
 * budget is configured AND enforcement is enabled (otherwise the soft-cap hint would
 * mislead). Mirrors the sibling answer-panel seam test.
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/session-status.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildTurnContext: vi.fn(),
  isCostCapEnforcementEnabled: vi.fn(),
  sumSessionTurnCost: vi.fn(),
}));

vi.mock('@/app/api/v1/app/questionnaires/_lib/turn-context', () => ({
  buildTurnContext: mocks.buildTurnContext,
}));
vi.mock('@/lib/app/questionnaire/feature-flag', () => ({
  isCostCapEnforcementEnabled: mocks.isCostCapEnforcementEnabled,
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/turns', () => ({
  sumSessionTurnCost: mocks.sumSessionTurnCost,
}));

import { loadSessionStatus } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-status';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import type { LoadedTurnContext } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import type { QuestionnaireConfigShape } from '@/lib/app/questionnaire/types';

/**
 * Build a LoadedTurnContext matching what the seam reads from buildTurnContext. Defaults
 * to an owned, active session with one required question answered (so the assessment has a
 * non-zero answeredCount to pass through).
 */
function ctx(
  over: {
    status?: string;
    respondentUserId?: string | null;
    config?: Partial<QuestionnaireConfigShape>;
  } = {}
): LoadedTurnContext {
  return {
    session: {
      id: 'sess-1',
      status: over.status ?? 'active',
      versionId: 'ver-1',
      respondentUserId: over.respondentUserId === undefined ? 'user-1' : over.respondentUserId,
    },
    base: {
      sessionId: 'sess-1',
      config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, ...over.config },
      questions: [
        {
          id: 'q1',
          key: 'name',
          sectionId: 'sec-1',
          sectionOrdinal: 0,
          ordinal: 0,
          weight: 1,
          required: true,
          type: 'free_text',
          tagIds: [],
        },
      ],
      answered: [{ questionId: 'q1', confidence: 0.9 }],
      existingAnswers: [],
      recentMessages: [],
      selectionRound: 0,
    },
    // Unread by the status seam (carried for the live turn path); empty for the fixture.
    slots: [],
    activeQuestionKey: null,
    byId: new Map(),
    meta: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isCostCapEnforcementEnabled.mockResolvedValue(false);
  mocks.sumSessionTurnCost.mockResolvedValue(0);
});

describe('loadSessionStatus', () => {
  it('returns null when the session context does not resolve', async () => {
    mocks.buildTurnContext.mockResolvedValue(null);
    await expect(loadSessionStatus('missing')).resolves.toBeNull();
  });

  it('returns the access fields alongside the projected view', async () => {
    mocks.buildTurnContext.mockResolvedValue(ctx());
    const loaded = await loadSessionStatus('sess-1');

    expect(loaded?.session).toEqual({ id: 'sess-1', respondentUserId: 'user-1' });
    expect(loaded?.view.status).toBe('active');
    expect(loaded?.view.anonymous).toBe(false);
    // The real assessment ran and its answeredCount was projected through.
    expect(loaded?.view.completion.answeredCount).toBe(1);
  });

  it('narrows an unrecognised session status to active', async () => {
    mocks.buildTurnContext.mockResolvedValue(ctx({ status: 'bogus' }));
    const loaded = await loadSessionStatus('sess-1');
    expect(loaded?.view.status).toBe('active');
  });

  it('flags an anonymous session when respondentUserId is null', async () => {
    mocks.buildTurnContext.mockResolvedValue(ctx({ respondentUserId: null }));
    const loaded = await loadSessionStatus('sess-1');
    expect(loaded?.view.anonymous).toBe(true);
    expect(loaded?.session.respondentUserId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Cost-cap grading — the seam's core branch
  // -------------------------------------------------------------------------

  it('reports cost null when no budget is configured (spend is never read)', async () => {
    mocks.buildTurnContext.mockResolvedValue(ctx({ config: { costBudgetUsd: null } }));
    mocks.isCostCapEnforcementEnabled.mockResolvedValue(true);

    const loaded = await loadSessionStatus('sess-1');

    expect(loaded?.view.cost).toBeNull();
    expect(mocks.sumSessionTurnCost).not.toHaveBeenCalled();
  });

  it('reports cost null when a budget is set but enforcement is disabled', async () => {
    mocks.buildTurnContext.mockResolvedValue(ctx({ config: { costBudgetUsd: 5 } }));
    mocks.isCostCapEnforcementEnabled.mockResolvedValue(false);

    const loaded = await loadSessionStatus('sess-1');

    expect(loaded?.view.cost).toBeNull();
    expect(mocks.sumSessionTurnCost).not.toHaveBeenCalled();
  });

  it('reports cost null when the configured budget is not positive', async () => {
    mocks.buildTurnContext.mockResolvedValue(ctx({ config: { costBudgetUsd: 0 } }));
    mocks.isCostCapEnforcementEnabled.mockResolvedValue(true);

    const loaded = await loadSessionStatus('sess-1');

    expect(loaded?.view.cost).toBeNull();
    expect(mocks.sumSessionTurnCost).not.toHaveBeenCalled();
  });

  it('grades the cost tier when a positive budget is set AND enforcement is enabled', async () => {
    mocks.buildTurnContext.mockResolvedValue(ctx({ config: { costBudgetUsd: 5 } }));
    mocks.isCostCapEnforcementEnabled.mockResolvedValue(true);
    mocks.sumSessionTurnCost.mockResolvedValue(10); // spent >= cap → hard

    const loaded = await loadSessionStatus('sess-1');

    expect(loaded?.view.cost).toEqual({ tier: 'hard' });
    expect(mocks.sumSessionTurnCost).toHaveBeenCalledWith('sess-1');
  });

  it('reports cost { tier: none } when spend is under threshold (budget set, enforcement on)', async () => {
    mocks.buildTurnContext.mockResolvedValue(ctx({ config: { costBudgetUsd: 5 } }));
    mocks.isCostCapEnforcementEnabled.mockResolvedValue(true);
    mocks.sumSessionTurnCost.mockResolvedValue(0); // under soft threshold

    const loaded = await loadSessionStatus('sess-1');

    // Distinct from the uncapped case: cost is an object (tier none), not null.
    expect(loaded?.view.cost).toEqual({ tier: 'none' });
  });
});
