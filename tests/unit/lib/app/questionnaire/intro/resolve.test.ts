/**
 * resolveSessionIntro — Prisma seam resolving the effective intro for a session, incl. the
 * cohort background override (session → cohortMember → cohort, replace semantics).
 *
 * Mocks `@/lib/db/client`; `buildIntroCopy` runs for real (its own matrix is covered in copy.test).
 *
 * @see lib/app/questionnaire/intro/resolve.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn() },
    appCohortMember: { findUnique: vi.fn() },
  },
}));

import { resolveSessionIntro } from '@/lib/app/questionnaire/intro/resolve';
import { prisma } from '@/lib/db/client';

const mockSession = vi.mocked(prisma.appQuestionnaireSession.findUnique);
const mockMember = vi.mocked(prisma.appCohortMember.findUnique);

/** A session row as the resolver selects it. */
function sessionRow(over: {
  cohortMemberId?: string | null;
  intro?: unknown;
  presentationMode?: string;
}) {
  return {
    cohortMemberId: over.cohortMemberId ?? null,
    version: {
      questionnaire: { title: 'Team Health Check' },
      config: {
        intro: over.intro ?? { enabled: true, background: 'Version background', buttonLabel: '' },
        presentationMode: over.presentationMode ?? 'chat',
        respondentReport: {},
        anonymousMode: false,
        voiceEnabled: false,
      },
    },
  };
}

describe('resolveSessionIntro', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the session does not exist', async () => {
    mockSession.mockResolvedValue(null);
    expect(await resolveSessionIntro('missing')).toBeNull();
  });

  it('reflects the per-version enabled toggle and title, with derived copy', async () => {
    mockSession.mockResolvedValue(
      sessionRow({ intro: { enabled: false, background: '', buttonLabel: '' } }) as never
    );
    const intro = await resolveSessionIntro('s1');
    expect(intro).not.toBeNull();
    expect(intro!.enabled).toBe(false);
    expect(intro!.questionnaireTitle).toBe('Team Health Check');
    expect(intro!.copy.howItWorks.body).toMatch(/conversation/i);
  });

  it('uses the version background when the session has no cohort', async () => {
    mockSession.mockResolvedValue(sessionRow({ cohortMemberId: null }) as never);
    const intro = await resolveSessionIntro('s1');
    expect(intro!.background).toBe('Version background');
    expect(mockMember).not.toHaveBeenCalled();
  });

  it('skips the cohort background lookup entirely when the intro is disabled', async () => {
    // The splash never renders when disabled, so the (possibly cohort-overridden) background is
    // unused — resolving it would be a wasted per-session DB round-trip.
    mockSession.mockResolvedValue(
      sessionRow({
        cohortMemberId: 'm1',
        intro: { enabled: false, background: 'Version background', buttonLabel: '' },
      }) as never
    );
    const intro = await resolveSessionIntro('s1');
    expect(intro!.enabled).toBe(false);
    expect(intro!.background).toBe('');
    expect(mockMember).not.toHaveBeenCalled();
  });

  it('replaces the background with a non-empty cohort override', async () => {
    mockSession.mockResolvedValue(sessionRow({ cohortMemberId: 'm1' }) as never);
    mockMember.mockResolvedValue({
      cohort: { introBackground: 'Cohort-specific background' },
    } as never);
    const intro = await resolveSessionIntro('s1');
    expect(intro!.background).toBe('Cohort-specific background');
    expect(mockMember).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'm1' } }));
  });

  it('inherits the version background when the cohort override is blank/whitespace', async () => {
    mockSession.mockResolvedValue(sessionRow({ cohortMemberId: 'm1' }) as never);
    mockMember.mockResolvedValue({ cohort: { introBackground: '   ' } } as never);
    const intro = await resolveSessionIntro('s1');
    expect(intro!.background).toBe('Version background');
  });

  it('inherits the version background when the cohort override is null', async () => {
    mockSession.mockResolvedValue(sessionRow({ cohortMemberId: 'm1' }) as never);
    mockMember.mockResolvedValue({ cohort: { introBackground: null } } as never);
    const intro = await resolveSessionIntro('s1');
    expect(intro!.background).toBe('Version background');
  });

  it('derives copy from the resolved presentation mode', async () => {
    mockSession.mockResolvedValue(sessionRow({ presentationMode: 'form' }) as never);
    const intro = await resolveSessionIntro('s1');
    expect(intro!.copy.howItWorks.body).toMatch(/grouped into sections/i);
    expect(intro!.copy.buttonLabel).toBe('Start the questionnaire');
  });
});
