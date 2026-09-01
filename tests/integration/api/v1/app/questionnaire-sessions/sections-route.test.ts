/**
 * Integration test: sectioned interviews (P21) — the section strip route.
 *
 * Pins the route wiring: gate order (load → access → status), every early-return branch on
 * POST (not-active, validation, not-sectioned, section-not-found, locked-open,
 * not-the-active-section, blocked-on-required, not-ready), both successful moves (open, and
 * close via both `cap` and `respondent` closedBy reasons), and the handleAPIError catch path.
 * `buildTurnContext` is mocked (its own seam is tested elsewhere); `canOpenSection`,
 * `openSection`, `closeSection`, `sectionEntry` and `buildSectionStripView` all run for real,
 * so the response bodies and the persisted `sectionRun` reflect real domain logic, not a mock's
 * say-so.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({ resolveApiKey: vi.fn(() => Promise.resolve(null)) }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

const ctxMock = vi.hoisted(() => ({ buildTurnContext: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/turn-context', () => ctxMock);

const tokenMock = vi.hoisted(() => ({ verifySessionToken: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token', () => tokenMock);

const prismaMock = vi.hoisted(() => ({
  prisma: { appQuestionnaireSession: { update: vi.fn() } },
}));
vi.mock('@/lib/db/client', () => prismaMock);

import { GET, POST } from '@/app/api/v1/app/questionnaire-sessions/[id]/sections/route';
import { auth } from '@/lib/auth/config';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { DEFAULT_SECTIONED_INTERVIEW_SETTINGS } from '@/lib/app/questionnaire/sections/settings';
import type { SectionRun } from '@/lib/app/questionnaire/sections/run';
import type { SectionState } from '@/lib/app/questionnaire/sections/state';
import type { SectionCloseAssessment } from '@/lib/app/questionnaire/sections/close';
import type { InterviewSection } from '@/lib/app/questionnaire/sections/types';
import type { CompletionAssessment } from '@/lib/app/questionnaire/completion/types';

type Mock = ReturnType<typeof vi.fn>;
const USER = 'cmjbv4i3x00003wsloputgwul';
const URL = 'http://localhost:3000/api/v1/app/questionnaire-sessions/sess-1/sections';

function req(headers: Record<string, string> = {}, body?: unknown): NextRequest {
  return {
    url: URL,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ id: 'sess-1' }) };

function setAuth(s: ReturnType<typeof mockAuthenticatedUser> | null): void {
  (auth.api.getSession as unknown as Mock).mockResolvedValue(s);
}

/** Three sections: s1 closed, s2 the active one (in progress), s3 not started. */
const SECTIONS: InterviewSection[] = [
  {
    key: 's1',
    label: 'About you',
    ordinal: 0,
    source: 'topics',
    questionKeys: ['q1'],
    dataSlotKeys: [],
  },
  {
    key: 's2',
    label: 'Your needs',
    ordinal: 1,
    source: 'topics',
    questionKeys: ['q2'],
    dataSlotKeys: [],
  },
  {
    key: 's3',
    label: 'Wrap-up',
    ordinal: 2,
    source: 'topics',
    questionKeys: ['q3'],
    dataSlotKeys: [],
  },
];

function run(over: Partial<SectionRun> = {}): SectionRun {
  return {
    v: 1,
    activeKey: 's2',
    sections: [
      {
        key: 's1',
        status: 'closed',
        openedAtTurn: 0,
        closedAtTurn: 1,
        closeReason: 'respondent',
        reopenCount: 0,
        turnsSpent: 2,
      },
      {
        key: 's2',
        status: 'in_progress',
        openedAtTurn: 1,
        closedAtTurn: null,
        closeReason: null,
        reopenCount: 0,
        turnsSpent: 1,
      },
      {
        key: 's3',
        status: 'not_started',
        openedAtTurn: 0,
        closedAtTurn: null,
        closeReason: null,
        reopenCount: 0,
        turnsSpent: 0,
      },
    ],
    ...over,
  };
}

/** A fully-shaped assessment, with only the field the route reads (`capReached`) overridable. */
function assessment(capReached = false): CompletionAssessment {
  return {
    kind: 'offer',
    rationale: 'thresholds met',
    unmet: [],
    coverage: 1,
    displayCoverage: 1,
    answeredCount: 1,
    requiredUnansweredKeys: [],
    capReached,
    earlyFinishAvailable: false,
  };
}

function closeGate(over: Partial<SectionCloseAssessment> = {}): SectionCloseAssessment {
  return {
    assessment: assessment(),
    canClose: true,
    blockedOnRequired: false,
    ...over,
  };
}

function sectionState(over: Partial<SectionState> = {}): SectionState {
  const theRun = over.run !== undefined ? over.run : run();
  return {
    active: true,
    sections: SECTIONS,
    run: theRun,
    activeSection: theRun ? (SECTIONS.find((s) => s.key === theRun.activeKey) ?? null) : null,
    isSectionOpening: false,
    close: closeGate(),
    allClosed: false,
    ...over,
  };
}

const INERT_STATE: SectionState = {
  active: false,
  sections: [],
  run: null,
  activeSection: null,
  isSectionOpening: false,
  close: null,
  allClosed: false,
};

function loadedContext(
  over: {
    status?: string;
    respondentUserId?: string | null;
    state?: SectionState;
    navigation?: 'sequential' | 'free';
  } = {}
) {
  const {
    status = 'active',
    respondentUserId = USER,
    state = sectionState(),
    navigation = 'sequential',
  } = over;
  return {
    session: { id: 'sess-1', status, respondentUserId },
    base: {
      config: {
        sections: { ...DEFAULT_SECTIONED_INTERVIEW_SETTINGS, navigation },
      },
      selectionRound: 5,
    },
    sectionState: state,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth(mockAuthenticatedUser());
  ctxMock.buildTurnContext.mockResolvedValue(loadedContext());
  prismaMock.prisma.appQuestionnaireSession.update.mockResolvedValue({});
});

describe('GET /sections', () => {
  it('404s when the session does not exist', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('401s when access is refused (unauthenticated owner-bound session)', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('403s when the session belongs to another respondent', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ respondentUserId: 'someone-else' }));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error.code).toBe('string');
  });

  it('is not status-gated: a paused session still returns its strip', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ status: 'paused' }));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
  });

  it('returns the inert strip for an unsectioned session', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ state: INERT_STATE }));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      active: false,
      sections: [],
      activeKey: null,
      canClose: false,
      blockedOnRequired: false,
      allClosed: false,
      showLocked: true,
    });
  });

  it('projects the tab strip for a sectioned session, computed from the real run', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.active).toBe(true);
    expect(body.data.activeKey).toBe('s2');
    expect(body.data.canClose).toBe(true);
    expect(body.data.allClosed).toBe(false);
    expect(body.data.sections).toEqual([
      {
        key: 's1',
        label: 'About you',
        position: 1,
        status: 'closed',
        isActive: false,
        isAvailable: true,
        reopenCount: 0,
      },
      {
        key: 's2',
        label: 'Your needs',
        position: 2,
        status: 'in_progress',
        isActive: true,
        isAvailable: true,
        reopenCount: 0,
      },
      // Sequential navigation + s2 still open ⇒ s3 is locked (not the active/closed/next-open section).
      {
        key: 's3',
        label: 'Wrap-up',
        position: 3,
        status: 'not_started',
        isActive: false,
        isAvailable: false,
        reopenCount: 0,
      },
    ]);
  });

  it('respects showLockedSections=false by carrying it into the view', async () => {
    ctxMock.buildTurnContext.mockResolvedValue({
      ...loadedContext(),
      base: {
        config: {
          sections: { ...DEFAULT_SECTIONED_INTERVIEW_SETTINGS, showLockedSections: false },
        },
        selectionRound: 5,
      },
    });
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body.data.showLocked).toBe(false);
  });

  it('500s via handleAPIError when the loader throws unexpectedly', async () => {
    ctxMock.buildTurnContext.mockRejectedValue(new Error('db unavailable'));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

describe('POST /sections — gate order', () => {
  it('404s when the session does not exist', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(null);
    const res = await POST(req({}, { action: 'open', key: 's2' }), ctx);
    expect(res.status).toBe(404);
    expect(prismaMock.prisma.appQuestionnaireSession.update).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    setAuth(mockUnauthenticatedUser());
    const res = await POST(req({}, { action: 'open', key: 's2' }), ctx);
    expect(res.status).toBe(401);
  });

  it('403s for another respondent', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ respondentUserId: 'someone-else' }));
    const res = await POST(req({}, { action: 'open', key: 's2' }), ctx);
    expect(res.status).toBe(403);
  });

  it('200s a valid anonymous caller (session-token access)', async () => {
    setAuth(mockUnauthenticatedUser());
    tokenMock.verifySessionToken.mockReturnValue({ ok: true, sessionId: 'sess-1' });
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ respondentUserId: null }));
    // s1 is closed, so under sequential navigation reopening it (the reopen right) is allowed.
    const res = await POST(
      req({ 'x-session-token': 'tok.sig' }, { action: 'open', key: 's1' }),
      ctx
    );
    expect(res.status).toBe(200);
  });

  it('409s SESSION_NOT_ACTIVE for a paused session', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ status: 'paused' }));
    const res = await POST(req({}, { action: 'open', key: 's2' }), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SESSION_NOT_ACTIVE');
    expect(prismaMock.prisma.appQuestionnaireSession.update).not.toHaveBeenCalled();
  });

  it('400s an invalid body (bad action)', async () => {
    const res = await POST(req({}, { action: 'delete', key: 's2' }), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400s an invalid body (empty key)', async () => {
    const res = await POST(req({}, { action: 'open', key: '' }), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('409s NOT_SECTIONED when the interview is not run in sections', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ state: INERT_STATE }));
    const res = await POST(req({}, { action: 'open', key: 's2' }), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_SECTIONED');
  });

  it('404s SECTION_NOT_FOUND for a key that names no resolved section', async () => {
    const res = await POST(req({}, { action: 'open', key: 'nope' }), ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SECTION_NOT_FOUND');
  });
});

describe('POST /sections — open', () => {
  it('409s SECTION_LOCKED for a forward jump under sequential navigation', async () => {
    // s2 is still open, so s3 (which is neither active, closed, nor next-open) is locked.
    const res = await POST(req({}, { action: 'open', key: 's3' }), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SECTION_LOCKED');
    expect(prismaMock.prisma.appQuestionnaireSession.update).not.toHaveBeenCalled();
  });

  it('allows a forward jump when navigation is free', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(loadedContext({ navigation: 'free' }));
    const res = await POST(req({}, { action: 'open', key: 's3' }), ctx);
    expect(res.status).toBe(200);
  });
});

describe('POST /sections — open (persisted state)', () => {
  it('opens the reopen-eligible closed section s1 and persists the new run', async () => {
    const res = await POST(req({}, { action: 'open', key: 's1' }), ctx);
    expect(res.status).toBe(200);

    expect(prismaMock.prisma.appQuestionnaireSession.update).toHaveBeenCalledTimes(1);
    const call = prismaMock.prisma.appQuestionnaireSession.update.mock.calls[0][0] as {
      where: { id: string };
      data: { sectionRun: SectionRun };
    };
    expect(call.where).toEqual({ id: 'sess-1' });
    const persisted = call.data.sectionRun;
    expect(persisted.activeKey).toBe('s1');
    const s1Entry = persisted.sections.find((s) => s.key === 's1');
    expect(s1Entry).toMatchObject({
      status: 'in_progress',
      reopenCount: 1,
      closedAtTurn: null,
      closeReason: null,
    });

    const body = await res.json();
    expect(body.data.activeKey).toBe('s1');
    expect(body.data.sections.find((s: { key: string }) => s.key === 's1')).toMatchObject({
      status: 'in_progress',
      isActive: true,
    });
    // The close gate belongs to the section just left — dropped, not carried forward.
    expect(body.data.canClose).toBe(false);
  });
});

describe('POST /sections — close', () => {
  it('409s SECTION_NOT_ACTIVE when closing a section other than the one you are in', async () => {
    const res = await POST(req({}, { action: 'close', key: 's1' }), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SECTION_NOT_ACTIVE');
    expect(prismaMock.prisma.appQuestionnaireSession.update).not.toHaveBeenCalled();
  });

  it('409s SECTION_BLOCKED when the active section is blocked on a required question', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        state: sectionState({
          close: closeGate({ canClose: false, blockedOnRequired: true }),
        }),
      })
    );
    const res = await POST(req({}, { action: 'close', key: 's2' }), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SECTION_BLOCKED');
  });

  it('409s SECTION_NOT_READY when not yet finished for a reason other than a required gap', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        state: sectionState({
          close: closeGate({ canClose: false, blockedOnRequired: false }),
        }),
      })
    );
    const res = await POST(req({}, { action: 'close', key: 's2' }), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SECTION_NOT_READY');
  });

  it('200s and closes with reason "respondent" when the bars were genuinely met', async () => {
    const res = await POST(req({}, { action: 'close', key: 's2' }), ctx);
    expect(res.status).toBe(200);

    const call = prismaMock.prisma.appQuestionnaireSession.update.mock.calls[0][0] as {
      data: { sectionRun: SectionRun };
    };
    const s2Entry = call.data.sectionRun.sections.find((s) => s.key === 's2');
    expect(s2Entry).toMatchObject({ status: 'closed', closeReason: 'respondent' });
    // The run hands off to the next open section (s3), the only one left unclosed.
    expect(call.data.sectionRun.activeKey).toBe('s3');

    const body = await res.json();
    expect(body.data.activeKey).toBe('s3');
  });

  it('200s and closes with reason "cap" when the turn budget released it, not the bars', async () => {
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({
        state: sectionState({
          close: closeGate({
            assessment: assessment(true),
            canClose: true,
            blockedOnRequired: false,
          }),
        }),
      })
    );
    const res = await POST(req({}, { action: 'close', key: 's2' }), ctx);
    expect(res.status).toBe(200);

    const call = prismaMock.prisma.appQuestionnaireSession.update.mock.calls[0][0] as {
      data: { sectionRun: SectionRun };
    };
    const s2Entry = call.data.sectionRun.sections.find((s) => s.key === 's2');
    expect(s2Entry).toMatchObject({ status: 'closed', closeReason: 'cap' });
  });

  it('closing the last open section leaves the run with no active key, and no active tab', async () => {
    // s1 and s3 already closed; s2 is the only one still open.
    const allButS2Closed: SectionRun = run({
      sections: [
        {
          key: 's1',
          status: 'closed',
          openedAtTurn: 0,
          closedAtTurn: 1,
          closeReason: 'respondent',
          reopenCount: 0,
          turnsSpent: 2,
        },
        {
          key: 's2',
          status: 'in_progress',
          openedAtTurn: 1,
          closedAtTurn: null,
          closeReason: null,
          reopenCount: 0,
          turnsSpent: 1,
        },
        {
          key: 's3',
          status: 'closed',
          openedAtTurn: 2,
          closedAtTurn: 3,
          closeReason: 'respondent',
          reopenCount: 0,
          turnsSpent: 1,
        },
      ],
    });
    ctxMock.buildTurnContext.mockResolvedValue(
      loadedContext({ state: sectionState({ run: allButS2Closed }) })
    );
    const res = await POST(req({}, { action: 'close', key: 's2' }), ctx);
    expect(res.status).toBe(200);

    const call = prismaMock.prisma.appQuestionnaireSession.update.mock.calls[0][0] as {
      data: { sectionRun: SectionRun };
    };
    expect(call.data.sectionRun.activeKey).toBeNull();

    const body = await res.json();
    expect(body.data.activeKey).toBeNull();
    expect(body.data.sections.every((s: { isActive: boolean }) => !s.isActive)).toBe(true);
  });

  it('500s via handleAPIError when persistence fails', async () => {
    prismaMock.prisma.appQuestionnaireSession.update.mockRejectedValue(
      new Error('db write failed')
    );
    const res = await POST(req({}, { action: 'close', key: 's2' }), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
