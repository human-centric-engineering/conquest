/**
 * Integration test: interviewer opening-questions suggest route.
 *
 * Exercises the gate order (auth → rate-limit → scope the version → suggest), the success envelope,
 * the 404 on a version that isn't in this questionnaire, the 502 on an assistant failure, and the
 * two properties that make this route safe to expose: it **writes nothing**, and it records an
 * `AppAiRun` either way. The suggestion pass itself is unit-tested separately and mocked here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '203.0.113.7') }));
vi.mock('@/lib/app/questionnaire/opening-examples/suggest', () => ({
  suggestOpeningExamples: vi.fn(),
  // The route imports these to bound its own query — a mock without them silently passes
  // `undefined` as the Prisma `take`, exactly the drift a whole-module mock invites.
  MAX_QUESTIONS_IN_PROMPT: 40,
  MAX_SECTIONS_IN_PROMPT: 15,
}));
vi.mock('@/lib/app/questionnaire/ai-run/store', () => ({ recordAiRun: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
  appQuestionnaireConfig: { update: vi.fn(), upsert: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/opening-examples/suggest/route';
import { auth } from '@/lib/auth/config';
import { suggestOpeningExamples } from '@/lib/app/questionnaire/opening-examples/suggest';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import {
  OPENING_EXAMPLES_SUGGEST_RATE_LIMIT_MAX,
  openingExamplesSuggestLimiter,
} from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

/** The id `mockAdminUser()` issues — the rate-limit key and the run's attribution. */
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function req(): NextRequest {
  return {
    url: 'http://localhost/api/v1/app/questionnaires/qn-1/versions/v1/opening-examples/suggest',
    headers: new Headers(),
    json: async () => ({}),
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'qn-1', vid: 'v1' }) };

const VERSION = {
  id: 'v1',
  goal: 'Understand how supported people feel.',
  audience: { role: 'Team members', expertiseLevel: 'novice' },
  questionnaire: { title: 'Employee experience review' },
  config: {
    sensitivityAwareness: true,
    interviewerStrategy: {
      enabled: true,
      approach: 'funnel',
      pace: 'balanced',
      openingMode: 'examples',
      openingExamples: ['Tell me about your week.'],
      probeDepth: true,
      reflect: false,
      batchRelated: true,
    },
  },
  sections: [
    { title: 'Day to day', questions: [{ prompt: 'How supported do you feel?' }] },
    { title: '  ', questions: [{ prompt: 'What would help most?' }] },
  ],
  glossaryTerms: [{ term: 'line manager' }],
};

const SUGGESTIONS = [{ text: 'Tell me about your experience here.', why: 'Easy to answer.' }];

beforeEach(() => {
  vi.clearAllMocks();
  openingExamplesSuggestLimiter.reset?.(ADMIN_ID);
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(VERSION);
  (suggestOpeningExamples as unknown as Mock).mockResolvedValue({
    suggestions: SUGGESTIONS,
    costUsd: 0.001,
    provider: 'openai',
    model: 'gpt-5.4',
  });
});

describe('POST …/opening-examples/suggest', () => {
  it('401s when unauthenticated, before loading anything', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockUnauthenticatedUser());
    expect((await POST(req(), ctx)).status).toBe(401);
    expect(prismaMock.appQuestionnaireVersion.findFirst).not.toHaveBeenCalled();
    expect(suggestOpeningExamples).not.toHaveBeenCalled();
  });

  it('returns the suggestions on success', async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.suggestions).toEqual(SUGGESTIONS);
    // Only the proposals — the service result also carries costUsd/provider/model, and those are
    // internal attribution that has no business reaching an admin's browser.
    expect(Object.keys(body.data)).toEqual(['suggestions']);
  });

  it('404s a version that does not belong to this questionnaire', async () => {
    // The `questionnaireId: id` scoping is what stops a crafted request reading another
    // questionnaire's content into a prompt.
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
    expect(suggestOpeningExamples).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'v1', questionnaireId: 'qn-1' } })
    );
  });

  it('passes the version’s own subject, coverage and settings into the suggestion pass', async () => {
    await POST(req(), ctx);
    expect(suggestOpeningExamples).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: 'v1',
        context: expect.objectContaining({
          title: 'Employee experience review',
          goal: 'Understand how supported people feel.',
          questions: ['How supported do you feel?', 'What would help most?'],
          glossaryTerms: ['line manager'],
          sensitivityAwareness: true,
          // Existing openers go in so the assistant proposes alternatives, not restatements.
          existingExamples: ['Tell me about your week.'],
        }),
      })
    );
  });

  it('drops a blank section title rather than sending an empty bullet', async () => {
    await POST(req(), ctx);
    const call = (suggestOpeningExamples as unknown as Mock).mock.calls[0][0];
    expect(call.context.sectionTitles).toEqual(['Day to day']);
  });

  /**
   * Narrowed, not read raw: the assistant is told about the same openers the runtime would use, so
   * a whitespace row left in stored JSON is not something it has to avoid restating.
   */
  it('narrows the stored strategy before reading the existing openers', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...VERSION,
      config: {
        sensitivityAwareness: false,
        interviewerStrategy: {
          ...VERSION.config.interviewerStrategy,
          openingExamples: ['  ', 'Tell me about your week.', 42],
        },
      },
    });

    await POST(req(), ctx);
    const call = (suggestOpeningExamples as unknown as Mock).mock.calls[0][0];
    expect(call.context.existingExamples).toEqual(['Tell me about your week.']);
  });

  it('still runs on a version with no config row yet, defaulting the settings safely', async () => {
    // A version whose Settings tab has never been saved has no config row at all.
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...VERSION,
      goal: null,
      audience: null,
      config: null,
      glossaryTerms: [],
    });

    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(suggestOpeningExamples).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          goal: '',
          audience: {},
          sensitivityAwareness: false,
          existingExamples: [],
        }),
      })
    );
  });

  it('reads only the audience fields it understands, ignoring junk', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...VERSION,
      audience: { role: '  Managers  ', expertiseLevel: 42, unrelated: 'ignored' },
    });

    await POST(req(), ctx);
    expect(suggestOpeningExamples).toHaveBeenCalledWith(
      expect.objectContaining({
        // Trimmed, non-strings dropped, unknown keys never forwarded into a prompt.
        context: expect.objectContaining({ audience: { role: 'Managers' } }),
      })
    );
  });

  it('writes nothing — the admin accepts proposals through the ordinary config save', async () => {
    await POST(req(), ctx);
    // No apply endpoint by design: the opening is the first thing a real respondent is asked.
    expect(prismaMock.appQuestionnaireConfig.update).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireConfig.upsert).not.toHaveBeenCalled();
  });

  it('records the run with its resolved binding and cost', async () => {
    await POST(req(), ctx);
    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'opening_examples_suggest',
        subjectKind: 'version',
        subjectId: 'v1',
        versionId: 'v1',
        provider: 'openai',
        model: 'gpt-5.4',
        costUsd: 0.001,
        triggeredByUserId: ADMIN_ID,
        detail: expect.objectContaining({ count: 1, existingCount: 1, approach: 'funnel' }),
      })
    );
  });

  it('502s and records a failed run when the assistant fails', async () => {
    (suggestOpeningExamples as unknown as Mock).mockRejectedValue(new Error('provider exploded'));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(502);
    // The provider's own words stay in the log and the AppAiRun row, never in the response.
    const body = await res.json();
    expect(body.error.message).not.toContain('provider exploded');
    expect(body.error.code).toBe('OPENING_EXAMPLES_SUGGEST_FAILED');
    // "We ran it and it errored" is a real answer worth keeping — a failed run is still a run.
    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'opening_examples_suggest', status: 'failed' })
    );
  });

  it('429s once the per-admin sub-cap is exhausted, without calling the assistant', async () => {
    // The section 100/min cap is applied by the proxy; this is the per-flow cap for a paid call.
    for (let i = 0; i < OPENING_EXAMPLES_SUGGEST_RATE_LIMIT_MAX; i += 1) await POST(req(), ctx);
    (suggestOpeningExamples as unknown as Mock).mockClear();

    const res = await POST(req(), ctx);
    expect(res.status).toBe(429);
    expect(suggestOpeningExamples).not.toHaveBeenCalled();
  });

  /**
   * Its own bucket, not one shared with the house-rules assistant: two assistants on the same
   * Settings tab sharing a cap would let a burst of one lock out the other, which the admin would
   * experience as an unrelated feature breaking.
   */
  it('does not share its rate-limit bucket with the house-rules assistant', async () => {
    const { houseRulesSuggestLimiter } =
      await import('@/app/api/v1/app/questionnaires/_lib/rate-limit');
    houseRulesSuggestLimiter.reset?.(ADMIN_ID);
    for (let i = 0; i < OPENING_EXAMPLES_SUGGEST_RATE_LIMIT_MAX; i += 1) await POST(req(), ctx);
    expect((await POST(req(), ctx)).status).toBe(429);
    expect(houseRulesSuggestLimiter.check(ADMIN_ID).success).toBe(true);
  });
});
