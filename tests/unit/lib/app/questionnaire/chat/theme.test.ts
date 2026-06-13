/**
 * resolveThemeForVersion / resolveThemeForSession — Prisma seam for the respondent chat
 * surface brand theme (F7.1, DEMO-ONLY).
 *
 * Mocks `@/lib/db/client` (Prisma) and `@/lib/app/questionnaire/theming` (resolveTheme)
 * so we can assert: the correct Prisma queries are issued, the demoClientId is forwarded
 * to resolveTheme, and the resolved theme propagates back to the caller.
 *
 * @see lib/app/questionnaire/chat/theme.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireVersion: {
      findUnique: vi.fn(),
    },
    appQuestionnaireSession: {
      findUnique: vi.fn(),
    },
    appDemoClient: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/app/questionnaire/theming', () => ({
  resolveTheme: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after vi.mock() hoisting.
// ---------------------------------------------------------------------------

import { resolveThemeForVersion, resolveThemeForSession } from '@/lib/app/questionnaire/chat/theme';
import { prisma } from '@/lib/db/client';
import { resolveTheme } from '@/lib/app/questionnaire/theming';
import type { ResolvedTheme } from '@/lib/app/questionnaire/theming';

const mockVersionFindUnique = vi.mocked(prisma.appQuestionnaireVersion.findUnique);
const mockSessionFindUnique = vi.mocked(prisma.appQuestionnaireSession.findUnique);
const mockDemoClientFindUnique = vi.mocked(prisma.appDemoClient.findUnique);
const mockResolveTheme = vi.mocked(resolveTheme);

/** A sentinel ResolvedTheme so we can assert it propagates without caring about its fields. */
const SENTINEL_THEME: ResolvedTheme = {
  ctaColor: '#sentinel',
  accentColor: '#sentinel',
  logoUrl: null,
  welcomeCopy: 'sentinel',
  surfaceColor: null,
  ctaColorEnd: null,
  logoBackgroundColor: null,
};

// ---------------------------------------------------------------------------
// Tests — resolveThemeForVersion
// ---------------------------------------------------------------------------

describe('resolveThemeForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTheme.mockReturnValue(SENTINEL_THEME);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queries appQuestionnaireVersion with the given versionId', async () => {
    // Arrange
    mockVersionFindUnique.mockResolvedValue({
      questionnaire: { demoClientId: null },
    } as never);

    // Act
    await resolveThemeForVersion('ver-001');

    // Assert: the correct record is fetched (not a different model or missing where clause).
    expect(mockVersionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ver-001' },
      })
    );
  });

  it('selects the demoClientId via the questionnaire relation', async () => {
    // Arrange
    mockVersionFindUnique.mockResolvedValue({
      questionnaire: { demoClientId: null },
    } as never);

    // Act
    await resolveThemeForVersion('ver-001');

    // Assert: the select shape reaches into the relation (a shallow select would miss it).
    expect(mockVersionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { questionnaire: { select: { demoClientId: true } } },
      })
    );
  });

  it('calls resolveTheme(null) when the version has no demoClientId', async () => {
    // Arrange
    mockVersionFindUnique.mockResolvedValue({
      questionnaire: { demoClientId: null },
    } as never);

    // Act
    await resolveThemeForVersion('ver-002');

    // Assert: no client fetch; resolveTheme receives null (platform defaults).
    expect(mockDemoClientFindUnique).not.toHaveBeenCalled();
    expect(mockResolveTheme).toHaveBeenCalledWith(null);
  });

  it('loads the demo client and calls resolveTheme(clientRow) when demoClientId is set', async () => {
    // Arrange
    const clientRow = {
      ctaColor: '#aabbcc',
      accentColor: '#112233',
      logoUrl: 'https://example.com/logo.png',
      welcomeCopy: 'Branded copy',
    };
    mockVersionFindUnique.mockResolvedValue({
      questionnaire: { demoClientId: 'client-99' },
    } as never);
    mockDemoClientFindUnique.mockResolvedValue(clientRow as never);

    // Act
    await resolveThemeForVersion('ver-003');

    // Assert: the client is fetched for the attributed id, then passed to resolveTheme.
    expect(mockDemoClientFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'client-99' } })
    );
    expect(mockResolveTheme).toHaveBeenCalledWith(clientRow);
  });

  it('fetches appDemoClient with the expected theme column selection', async () => {
    // Arrange
    mockVersionFindUnique.mockResolvedValue({
      questionnaire: { demoClientId: 'client-99' },
    } as never);
    mockDemoClientFindUnique.mockResolvedValue({
      ctaColor: null,
      accentColor: null,
      logoUrl: null,
      welcomeCopy: null,
    } as never);

    // Act
    await resolveThemeForVersion('ver-003');

    // Assert: the select matches what the source code requests.
    expect(mockDemoClientFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          ctaColor: true,
          accentColor: true,
          logoUrl: true,
          welcomeCopy: true,
          surfaceColor: true,
          ctaColorEnd: true,
          logoBackgroundColor: true,
          logoBackgroundEnabled: true,
        },
      })
    );
  });

  it('returns the ResolvedTheme from resolveTheme', async () => {
    // Arrange
    mockVersionFindUnique.mockResolvedValue({
      questionnaire: { demoClientId: null },
    } as never);

    // Act
    const result = await resolveThemeForVersion('ver-004');

    // Assert: the sentinel propagates — the function doesn't wrap or drop the value.
    expect(result).toBe(SENTINEL_THEME);
  });

  it('calls resolveTheme(null) when the version record is not found (null)', async () => {
    // Arrange: version does not exist in the database.
    mockVersionFindUnique.mockResolvedValue(null);

    // Act
    await resolveThemeForVersion('ver-missing');

    // Assert: the null-coalesce in the source produces resolveTheme(null).
    expect(mockResolveTheme).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// Tests — resolveThemeForSession
// ---------------------------------------------------------------------------

describe('resolveThemeForSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTheme.mockReturnValue(SENTINEL_THEME);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queries appQuestionnaireSession with the given sessionId', async () => {
    // Arrange
    mockSessionFindUnique.mockResolvedValue({
      version: { questionnaire: { demoClientId: null } },
    } as never);

    // Act
    await resolveThemeForSession('sess-001');

    // Assert: the correct session id is used in the where clause.
    expect(mockSessionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sess-001' },
      })
    );
  });

  it('selects demoClientId via the nested version.questionnaire relation', async () => {
    // Arrange
    mockSessionFindUnique.mockResolvedValue({
      version: { questionnaire: { demoClientId: null } },
    } as never);

    // Act
    await resolveThemeForSession('sess-001');

    // Assert: the nested select shape matches the source.
    expect(mockSessionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          version: { select: { questionnaire: { select: { demoClientId: true } } } },
        },
      })
    );
  });

  it('calls resolveTheme(null) when the session has no demoClientId', async () => {
    // Arrange
    mockSessionFindUnique.mockResolvedValue({
      version: { questionnaire: { demoClientId: null } },
    } as never);

    // Act
    await resolveThemeForSession('sess-002');

    // Assert: no demo-client fetch; platform defaults are used.
    expect(mockDemoClientFindUnique).not.toHaveBeenCalled();
    expect(mockResolveTheme).toHaveBeenCalledWith(null);
  });

  it('loads the demo client and calls resolveTheme(clientRow) when demoClientId is set', async () => {
    // Arrange
    const clientRow = {
      ctaColor: '#ff0000',
      accentColor: '#00ff00',
      logoUrl: null,
      welcomeCopy: null,
    };
    mockSessionFindUnique.mockResolvedValue({
      version: { questionnaire: { demoClientId: 'client-session-77' } },
    } as never);
    mockDemoClientFindUnique.mockResolvedValue(clientRow as never);

    // Act
    await resolveThemeForSession('sess-003');

    // Assert: the attributed client id is queried and its row forwarded to resolveTheme.
    expect(mockDemoClientFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'client-session-77' } })
    );
    expect(mockResolveTheme).toHaveBeenCalledWith(clientRow);
  });

  it('returns the ResolvedTheme produced by resolveTheme', async () => {
    // Arrange
    mockSessionFindUnique.mockResolvedValue({
      version: { questionnaire: { demoClientId: null } },
    } as never);

    // Act
    const result = await resolveThemeForSession('sess-004');

    // Assert: the resolved value propagates to the caller unchanged.
    expect(result).toBe(SENTINEL_THEME);
  });

  it('calls resolveTheme(null) when the session record is not found (null)', async () => {
    // Arrange: session does not exist.
    mockSessionFindUnique.mockResolvedValue(null);

    // Act
    await resolveThemeForSession('sess-missing');

    // Assert: null-coalesce in the source means resolveTheme(null) is called.
    expect(mockResolveTheme).toHaveBeenCalledWith(null);
  });
});
