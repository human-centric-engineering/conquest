/**
 * Unit test: respondent session-status view builder (F7.3).
 *
 * Pins the pure projection from completion assessment (F4.5) + cost tier (F6.3) + status
 * (F4.6) into the client-safe view, and the `canSubmitSession` derivation the UI and the
 * submit route both rely on. No Prisma/Next — data-in/data-out.
 */

import { describe, it, expect } from 'vitest';

import {
  buildSessionStatusView,
  canSubmitSession,
  type SessionStatusInput,
} from '@/lib/app/questionnaire/session/status-view';
import type {
  CompletionAssessment,
  CompletionKind,
} from '@/lib/app/questionnaire/completion/types';

function assessment(over: Partial<CompletionAssessment> = {}): CompletionAssessment {
  return {
    kind: 'offer',
    rationale: 'ready',
    unmet: [],
    coverage: 0.8,
    displayCoverage: 0.8,
    answeredCount: 4,
    requiredUnansweredKeys: [],
    capReached: false,
    earlyFinishAvailable: false,
    ...over,
  };
}

function input(over: Partial<SessionStatusInput> = {}): SessionStatusInput {
  return {
    status: 'active',
    assessment: assessment(),
    costTier: 'none',
    capped: false,
    anonymous: false,
    ref: null,
    ...over,
  };
}

describe('buildSessionStatusView', () => {
  it('passes the support reference through (null when absent)', () => {
    expect(buildSessionStatusView(input({ ref: '7F3K9M2P' })).ref).toBe('7F3K9M2P');
    expect(buildSessionStatusView(input({ ref: null })).ref).toBeNull();
  });

  it('projects the completion slice from the assessment', () => {
    const view = buildSessionStatusView(
      input({
        assessment: assessment({
          kind: 'not_ready',
          coverage: 0.5,
          // Distinct from coverage to prove the projection carries the graded figure independently.
          displayCoverage: 0.65,
          answeredCount: 2,
          requiredUnansweredKeys: ['role'],
          capReached: false,
        }),
      })
    );
    expect(view.completion).toEqual({
      kind: 'not_ready',
      coverage: 0.5,
      displayCoverage: 0.65,
      answeredCount: 2,
      requiredUnansweredKeys: ['role'],
      capReached: false,
      earlyFinishAvailable: false,
    });
  });

  it('returns null cost when uncapped', () => {
    const view = buildSessionStatusView(input({ capped: false, costTier: 'soft' }));
    expect(view.cost).toBeNull();
  });

  it('returns only the coarse tier (never spend) when capped', () => {
    const view = buildSessionStatusView(input({ capped: true, costTier: 'soft' }));
    expect(view.cost).toEqual({ tier: 'soft' });
    // No raw USD figure leaks into the view.
    expect(JSON.stringify(view)).not.toMatch(/spentUsd|capUsd/);
  });

  it('carries status and anonymous through verbatim', () => {
    const view = buildSessionStatusView(input({ status: 'paused', anonymous: true }));
    expect(view.status).toBe('paused');
    expect(view.anonymous).toBe(true);
  });

  it('marks a hard tier on a paused session (budget pause vs. respondent pause)', () => {
    const view = buildSessionStatusView(
      input({ status: 'paused', capped: true, costTier: 'hard' })
    );
    expect(view.status).toBe('paused');
    expect(view.cost).toEqual({ tier: 'hard' });
  });
});

describe('canSubmitSession', () => {
  const cases: Array<[string, ReturnType<typeof buildSessionStatusView>, boolean]> = [
    ['active + offer', buildSessionStatusView(input()), true],
    [
      'active + not_ready',
      buildSessionStatusView(input({ assessment: assessment({ kind: 'not_ready' }) })),
      false,
    ],
    ['paused + offer', buildSessionStatusView(input({ status: 'paused' })), false],
    ['completed + offer', buildSessionStatusView(input({ status: 'completed' })), false],
  ];

  it.each(cases)('%s → %s', (_label, view, expected) => {
    expect(canSubmitSession(view)).toBe(expected);
  });

  it('projects earlyFinishAvailable through to the completion view', () => {
    const view = buildSessionStatusView(
      input({ assessment: assessment({ kind: 'not_ready', earlyFinishAvailable: true }) })
    );
    expect(view.completion.earlyFinishAvailable).toBe(true);
  });

  it('allows submit on a cap-reached offer even with a required key outstanding', () => {
    // The existing F4.5 behaviour: a capped session can always submit.
    const view = buildSessionStatusView(
      input({
        assessment: assessment({
          kind: 'offer' as CompletionKind,
          capReached: true,
          requiredUnansweredKeys: ['late_required'],
        }),
      })
    );
    expect(canSubmitSession(view)).toBe(true);
  });
});
