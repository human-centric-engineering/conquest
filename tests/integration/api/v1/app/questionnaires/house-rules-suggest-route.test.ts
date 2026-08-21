/**
 * Integration test: interviewer house-rules suggest route.
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
vi.mock('@/lib/app/questionnaire/house-rules/suggest', () => ({
  suggestHouseRules: vi.fn(),
  // The route imports this to bound its own query — a mock without it silently passes `undefined`
  // as the Prisma `take`, which is exactly the kind of drift a whole-module mock invites.
  MAX_QUESTIONS_IN_PROMPT: 40,
}));
vi.mock('@/lib/app/questionnaire/ai-run/store', () => ({ recordAiRun: vi.fn() }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
  appQuestionnaireConfig: { update: vi.fn(), upsert: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { POST } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/house-rules/suggest/route';
import { auth } from '@/lib/auth/config';
import { suggestHouseRules } from '@/lib/app/questionnaire/house-rules/suggest';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import {
  HOUSE_RULES_SUGGEST_RATE_LIMIT_MAX,
  houseRulesSuggestLimiter,
} from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

/** The id `mockAdminUser()` issues — the rate-limit key and the run's attribution. */
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function req(): NextRequest {
  return {
    url: 'http://localhost/api/v1/app/questionnaires/qn-1/versions/v1/house-rules/suggest',
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
    anonymousMode: true,
    sensitivityAwareness: false,
    supportMessage: '',
    houseRules: {
      enabled: true,
      rules: [{ id: 'a', kind: 'never', enabled: true, text: 'Advise.' }],
    },
  },
  sections: [{ questions: [{ prompt: 'How supported do you feel?' }] }],
  glossaryTerms: [{ term: 'line manager' }],
};

const SUGGESTIONS = [
  { kind: 'always', text: 'Ask for a concrete example.', why: 'Turns vague answers concrete.' },
];

beforeEach(() => {
  vi.clearAllMocks();
  houseRulesSuggestLimiter.reset?.(ADMIN_ID);
  (auth.api.getSession as unknown as Mock).mockResolvedValue(mockAdminUser());
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(VERSION);
  (suggestHouseRules as unknown as Mock).mockResolvedValue({
    suggestions: SUGGESTIONS,
    costUsd: 0.002,
    provider: 'openai',
    model: 'gpt-5.4',
  });
});

describe('POST …/house-rules/suggest', () => {
  it('401s when unauthenticated, before loading anything', async () => {
    (auth.api.getSession as unknown as Mock).mockResolvedValue(mockUnauthenticatedUser());
    expect((await POST(req(), ctx)).status).toBe(401);
    expect(prismaMock.appQuestionnaireVersion.findFirst).not.toHaveBeenCalled();
    expect(suggestHouseRules).not.toHaveBeenCalled();
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
    expect(suggestHouseRules).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'v1', questionnaireId: 'qn-1' } })
    );
  });

  it('passes the version’s own content and settings into the suggestion pass', async () => {
    await POST(req(), ctx);
    expect(suggestHouseRules).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: 'v1',
        context: expect.objectContaining({
          title: 'Employee experience review',
          goal: 'Understand how supported people feel.',
          questions: ['How supported do you feel?'],
          glossaryTerms: ['line manager'],
          anonymousMode: true,
          hasSupportMessage: false,
          // Existing rules go in so the assistant proposes additions, not restatements.
          existingRules: [{ kind: 'never', text: 'Advise.' }],
        }),
      })
    );
  });

  it('still runs on a version with no config row yet, defaulting the settings safely', async () => {
    // A version whose Settings tab has never been saved has no config row at all. Defaulting
    // anonymousMode to false is the safe direction: the assistant is then told NOT to promise
    // anonymity, which is the claim that would actually harm a respondent if it were wrong.
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
      ...VERSION,
      goal: null,
      audience: null,
      config: null,
      glossaryTerms: [],
    });

    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(suggestHouseRules).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          goal: '',
          audience: {},
          anonymousMode: false,
          sensitivityAwareness: false,
          hasSupportMessage: false,
          existingRules: [],
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
    expect(suggestHouseRules).toHaveBeenCalledWith(
      expect.objectContaining({
        // Trimmed, non-strings dropped, unknown keys never forwarded into a prompt.
        context: expect.objectContaining({ audience: { role: 'Managers' } }),
      })
    );
  });

  it('writes nothing — the admin accepts proposals through the ordinary config save', async () => {
    await POST(req(), ctx);
    // No apply endpoint by design: a rule the admin never read is what this feature prevents.
    expect(prismaMock.appQuestionnaireConfig.update).not.toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireConfig.upsert).not.toHaveBeenCalled();
  });

  it('records the run with its resolved binding and cost', async () => {
    await POST(req(), ctx);
    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'house_rules_suggest',
        subjectKind: 'version',
        subjectId: 'v1',
        versionId: 'v1',
        provider: 'openai',
        model: 'gpt-5.4',
        costUsd: 0.002,
        triggeredByUserId: ADMIN_ID,
      })
    );
  });

  it('502s and records a failed run when the assistant fails', async () => {
    (suggestHouseRules as unknown as Mock).mockRejectedValue(new Error('provider exploded'));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(502);
    // The provider's own words stay in the log and the AppAiRun row, never in the response.
    const body = await res.json();
    expect(body.error.message).not.toContain('provider exploded');
    // "We ran it and it errored" is a real answer worth keeping — a failed run is still a run.
    expect(recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'house_rules_suggest', status: 'failed' })
    );
  });

  it('429s once the per-admin sub-cap is exhausted, without calling the assistant', async () => {
    // The section 100/min cap is applied by the proxy; this is the per-flow cap for a paid call.
    for (let i = 0; i < HOUSE_RULES_SUGGEST_RATE_LIMIT_MAX; i += 1) await POST(req(), ctx);
    (suggestHouseRules as unknown as Mock).mockClear();

    const res = await POST(req(), ctx);
    expect(res.status).toBe(429);
    expect(suggestHouseRules).not.toHaveBeenCalled();
  });
});
