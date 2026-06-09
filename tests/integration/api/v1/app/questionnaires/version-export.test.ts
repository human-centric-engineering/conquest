/**
 * Integration test: result-export route (F8.2).
 *
 * Pins the route shell — flag-gate → rate-limit → auth → version-scope → query-validation
 * → loader → format serialisation — for GET .../versions/:vid/export. The DB loader is
 * stubbed (unit-tested separately) but the REAL serialisers run, so the CSV/JSON bodies
 * and the download headers are exercised end to end:
 *   - 404 flag off (before auth); 401 unauth; 403 non-admin; 404 unknown version
 *   - 400 on a bad date query
 *   - default format = JSON; `?format=csv` → text/csv + attachment .csv
 *   - the resolved scope (version + parsed tags) reaches the loader
 *   - 429 from the export sub-cap, loader untouched
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────────

vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireVersion: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const loaderMock = vi.hoisted(() => ({ loadResultsExport: vi.fn() }));
vi.mock('@/lib/app/questionnaire/export/results-loader', () => loaderMock);

const limiterMock = vi.hoisted(() => ({
  check: vi.fn<() => { success: boolean; limit?: number; remaining?: number; reset?: number }>(
    () => ({ success: true })
  ),
}));
vi.mock('@/lib/security/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/rate-limit')>()),
  exportLimiter: limiterMock,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET } from '@/app/api/v1/app/questionnaires/[id]/versions/[vid]/export/route';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { auth } from '@/lib/auth/config';
import { APP_QUESTIONNAIRES_FLAG } from '@/lib/app/questionnaire/constants';
import type { ResultsExportModel } from '@/lib/app/questionnaire/export/results-types';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

type Mock = ReturnType<typeof vi.fn>;

const BASE = 'http://localhost:3000/api/v1/app/questionnaires/qn-1/versions/v1/export';
const PARAMS = { id: 'qn-1', vid: 'v1' };

function req(search = ''): NextRequest {
  return { url: `${BASE}${search}`, headers: new Headers() } as unknown as NextRequest;
}
function ctx() {
  return { params: Promise.resolve(PARAMS) };
}
function setAuth(session: ReturnType<typeof mockAdminUser> | null) {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(session);
}

const MODEL: ResultsExportModel = {
  versionId: 'v1',
  versionNumber: 2,
  questionnaireTitle: 'Onboarding Survey',
  range: { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
  anonymous: false,
  capped: false,
  questions: [
    {
      questionId: 'q1',
      key: 'role',
      prompt: 'Your role?',
      type: 'free_text',
      sectionTitle: 'About',
      required: true,
    },
  ],
  sessions: [
    {
      id: 's1',
      status: 'completed',
      createdAt: '2026-01-10T09:00:00.000Z',
      completedAt: '2026-01-10T09:30:00.000Z',
      respondentName: 'Ada',
      profile: null,
      answers: [
        {
          questionKey: 'role',
          value: 'Engineer',
          confidence: 0.9,
          provenanceLabel: 'direct',
          provenanceItems: null,
          rationale: null,
          refinementHistory: [],
          lastUpdatedTurnOrdinal: 1,
        },
      ],
      turns: [],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFeatureEnabled).mockImplementation((flag) =>
    Promise.resolve(flag === APP_QUESTIONNAIRES_FLAG)
  );
  setAuth(mockAdminUser());
  limiterMock.check.mockReturnValue({ success: true });
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: 'v1',
    questionnaireId: 'qn-1',
    versionNumber: 2,
    status: 'launched',
  });
  loaderMock.loadResultsExport.mockResolvedValue(MODEL);
});

describe('GET versions/:vid/export', () => {
  it('404s when the master flag is off, before auth', async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    setAuth(null);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
    expect(loaderMock.loadResultsExport).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    expect((await GET(req(), ctx())).status).toBe(401);
  });

  it('403s for a non-admin', async () => {
    setAuth(mockAuthenticatedUser());
    expect((await GET(req(), ctx())).status).toBe(403);
  });

  it('404s with the error envelope when the version does not resolve', async () => {
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('NOT_FOUND');
    expect(loaderMock.loadResultsExport).not.toHaveBeenCalled();
  });

  it('400s on an invalid date query', async () => {
    const res = await GET(req('?from=not-a-date'), ctx());
    expect(res.status).toBe(400);
    expect(loaderMock.loadResultsExport).not.toHaveBeenCalled();
  });

  it('defaults to a JSON download carrying the full model', async () => {
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Content-Disposition')).toMatch(
      /attachment; filename="results-onboarding-survey-v2-.*\.json"/
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.versionId).toBe('v1');
    expect(body.sessions[0].answers[0].value).toBe('Engineer');
  });

  it('serves a CSV download with the analytics header row when format=csv', async () => {
    const res = await GET(req('?format=csv'), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toMatch(
      /attachment; filename="results-onboarding-survey-v2-.*\.csv"/
    );
    const text = await res.text();
    const [header, firstRow] = text.split('\n');
    expect(header).toBe(
      'session_id,session_status,created_at,completed_at,respondent_name,respondent_profile,section_title,question_key,question_prompt,question_type,answer_value,confidence,provenance_label'
    );
    expect(firstRow).toContain('s1,completed,');
    expect(firstRow).toContain('Engineer');
  });

  it('passes the resolved scope (version + parsed tags) to the loader', async () => {
    await GET(req('?tagIds=t1,t2'), ctx());
    const scope = loaderMock.loadResultsExport.mock.calls[0][0];
    expect(scope.versionId).toBe('v1');
    expect(scope.tagIds).toEqual(['t1', 't2']);
    expect(scope.from).toBeInstanceOf(Date);
    expect(scope.to).toBeInstanceOf(Date);
  });

  it('429s from the export sub-cap without touching the loader', async () => {
    limiterMock.check.mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Math.floor(Date.UTC(2030, 0, 1) / 1000),
    });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(429);
    expect(loaderMock.loadResultsExport).not.toHaveBeenCalled();
  });
});
