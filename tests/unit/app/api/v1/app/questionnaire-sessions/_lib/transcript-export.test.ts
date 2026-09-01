/**
 * Unit test: chat-transcript export DB seam (`loadTranscriptExport`, `assembleTranscriptExportModel`).
 *
 * `Prisma`, `fetchLogoDataUri`, and `logger` are mocked; the real pure
 * `buildTranscriptExportModel` runs, so `assembleTranscriptExportModel`'s output reflects real
 * builder behaviour rather than a stub's say-so. Pins the seam's own responsibilities that the
 * route tests (`transcript-export-routes.test.ts`) mock away entirely:
 *
 *  - {@link loadTranscriptExport}: null on a missing session; the anonymous identity skip (never
 *    queries `user`); the `completedAt` resolution ladder; the P21 section-label resolution
 *    (two extra queries only when a turn carries a `sectionKey`, topics winning over document
 *    sections on a shared key, an unresolvable key falling back to itself); the demoClient →
 *    RawTheme mapping.
 *  - {@link assembleTranscriptExportModel}: the best-effort logo fetch and its warn-on-miss, and
 *    that the logo slot is always overwritten with the fetch result (or null) regardless of what
 *    was loaded.
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/transcript-export.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    appQuestionnaireTopic: { findMany: vi.fn() },
    appQuestionnaireSection: { findMany: vi.fn() },
  },
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  fetchLogoDataUri: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/logging', () => ({ logger: mocks.logger }));
vi.mock('@/app/api/v1/app/questionnaire-sessions/_lib/fetch-logo-data-uri', () => ({
  fetchLogoDataUri: mocks.fetchLogoDataUri,
}));

import {
  loadTranscriptExport,
  assembleTranscriptExportModel,
  type LoadedTranscriptExport,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript-export';

type Mock = ReturnType<typeof vi.fn>;
const findSession = mocks.prisma.appQuestionnaireSession.findUnique as Mock;
const findUser = mocks.prisma.user.findUnique as Mock;
const findTopics = mocks.prisma.appQuestionnaireTopic.findMany as Mock;
const findDocSections = mocks.prisma.appQuestionnaireSection.findMany as Mock;

/** A findUnique row matching the seam's `select`, with overridable parts. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    status: 'completed',
    respondentUserId: 'user-1',
    publicRef: 'GSP289HB',
    versionId: 'ver-1',
    createdAt: new Date('2026-06-01T09:00:00.000Z'),
    updatedAt: new Date('2026-06-02T09:00:00.000Z'),
    version: {
      versionNumber: 3,
      goal: 'Understand needs',
      audience: { description: 'New hires' },
      config: { anonymousMode: false },
      questionnaire: {
        id: 'q-1',
        title: 'Onboarding survey',
        demoClient: {
          ctaColor: '#111111',
          accentColor: '#abcdef',
          logoUrl: 'https://cdn.example.com/logo.png',
          welcomeCopy: 'Welcome',
        },
      },
    },
    turns: [
      {
        userMessage: 'Hi',
        agentResponse: 'Hello!',
        createdAt: new Date('2026-06-01T09:05:00.000Z'),
        sectionKey: null,
      },
    ],
    events: [{ createdAt: new Date('2026-06-02T10:30:00.000Z') }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findUser.mockResolvedValue({ name: 'Ada Lovelace' });
  findTopics.mockResolvedValue([]);
  findDocSections.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadTranscriptExport', () => {
  it('returns null when the session does not resolve', async () => {
    findSession.mockResolvedValue(null);
    await expect(loadTranscriptExport('missing')).resolves.toBeNull();
    expect(findUser).not.toHaveBeenCalled();
    expect(findTopics).not.toHaveBeenCalled();
  });

  it('maps the full row to the loaded export shape', async () => {
    findSession.mockResolvedValue(row());
    const loaded = await loadTranscriptExport('sess-1');

    expect(loaded?.session).toEqual({ id: 'sess-1', respondentUserId: 'user-1' });
    expect(loaded?.questionnaireId).toBe('q-1');
    expect(loaded?.questionnaireTitle).toBe('Onboarding survey');
    expect(loaded?.versionNumber).toBe(3);
    expect(loaded?.goal).toBe('Understand needs');
    expect(loaded?.audience).toEqual({ description: 'New hires' });
    expect(loaded?.refRaw).toBe('GSP289HB');
    expect(loaded?.anonymous).toBe(false);
    expect(loaded?.respondentName).toBe('Ada Lovelace');
    expect(loaded?.startedAt).toBe('2026-06-01T09:00:00.000Z');
    expect(loaded?.status).toBe('completed');
    expect(loaded?.theme).toEqual({
      ctaColor: '#111111',
      accentColor: '#abcdef',
      logoUrl: 'https://cdn.example.com/logo.png',
      welcomeCopy: 'Welcome',
    });
    expect(loaded?.turns).toEqual([
      { userMessage: 'Hi', agentResponse: 'Hello!', at: '2026-06-01T09:05:00.000Z' },
    ]);
    // No turn carries a sectionKey, so both section-label queries are skipped entirely.
    expect(findTopics).not.toHaveBeenCalled();
    expect(findDocSections).not.toHaveBeenCalled();
  });

  it('narrows an unrecognised stored status to "active"', async () => {
    findSession.mockResolvedValue(row({ status: 'not-a-real-status' }));
    const loaded = await loadTranscriptExport('sess-1');
    expect(loaded?.status).toBe('active');
  });

  it('resolves completedAt from the latest "completed" event when present', async () => {
    findSession.mockResolvedValue(row());
    const loaded = await loadTranscriptExport('sess-1');
    expect(loaded?.completedAt).toBe('2026-06-02T10:30:00.000Z');
  });

  it('falls back to updatedAt when completed but no completion event was recorded', async () => {
    findSession.mockResolvedValue(row({ events: [] }));
    const loaded = await loadTranscriptExport('sess-1');
    expect(loaded?.completedAt).toBe('2026-06-02T09:00:00.000Z');
  });

  it('leaves completedAt null for a non-completed session with no completion event', async () => {
    findSession.mockResolvedValue(row({ status: 'active', events: [] }));
    const loaded = await loadTranscriptExport('sess-1');
    expect(loaded?.completedAt).toBeNull();
  });

  it('defaults anonymousMode to false when the version has no config row at all', async () => {
    findSession.mockResolvedValue(row({ version: { ...row().version, config: null } }));
    const loaded = await loadTranscriptExport('sess-1');
    expect(loaded?.anonymous).toBe(false);
    // Not anonymous + a respondentUserId ⇒ identity is still looked up.
    expect(findUser).toHaveBeenCalled();
  });

  it('resolves a null audience to null rather than passing through a non-object', async () => {
    findSession.mockResolvedValue(row({ version: { ...row().version, audience: null } }));
    const loaded = await loadTranscriptExport('sess-1');
    expect(loaded?.audience).toBeNull();
  });

  it('produces an all-null theme when the questionnaire has no demoClient', async () => {
    findSession.mockResolvedValue(
      row({
        version: {
          ...row().version,
          questionnaire: { ...row().version.questionnaire, demoClient: null },
        },
      })
    );
    const loaded = await loadTranscriptExport('sess-1');
    expect(loaded?.theme).toEqual({
      ctaColor: null,
      accentColor: null,
      logoUrl: null,
      welcomeCopy: null,
    });
  });

  describe('anonymous mode', () => {
    it('never queries identity, and the respondent name stays null', async () => {
      findSession.mockResolvedValue(
        row({ version: { ...row().version, config: { anonymousMode: true } } })
      );
      const loaded = await loadTranscriptExport('sess-1');
      expect(findUser).not.toHaveBeenCalled();
      expect(loaded?.anonymous).toBe(true);
      expect(loaded?.respondentName).toBeNull();
    });

    it('also skips identity when the session has no respondentUserId, even if not anonymous', async () => {
      findSession.mockResolvedValue(row({ respondentUserId: null }));
      const loaded = await loadTranscriptExport('sess-1');
      expect(findUser).not.toHaveBeenCalled();
      expect(loaded?.respondentName).toBeNull();
    });

    it('falls back to null when the identified user has no name', async () => {
      findUser.mockResolvedValue({ name: null });
      findSession.mockResolvedValue(row());
      const loaded = await loadTranscriptExport('sess-1');
      expect(loaded?.respondentName).toBeNull();
    });
  });

  describe('P21 section-label resolution', () => {
    const sectionedRow = () =>
      row({
        turns: [
          {
            userMessage: 'Q1',
            agentResponse: 'A1',
            createdAt: new Date('2026-06-01T09:05:00.000Z'),
            sectionKey: 'topic-a',
          },
          {
            userMessage: 'Q2',
            agentResponse: 'A2',
            createdAt: new Date('2026-06-01T09:10:00.000Z'),
            sectionKey: 'doc-sec-b',
          },
          {
            userMessage: 'Q3',
            agentResponse: 'A3',
            createdAt: new Date('2026-06-01T09:15:00.000Z'),
            sectionKey: 'unknown-key',
          },
        ],
      });

    it('runs both label queries scoped to the version, only when a turn carries a sectionKey', async () => {
      findTopics.mockResolvedValue([{ key: 'topic-a', label: 'About You' }]);
      findDocSections.mockResolvedValue([{ id: 'doc-sec-b', title: 'Wrap-up' }]);
      findSession.mockResolvedValue(sectionedRow());

      const loaded = await loadTranscriptExport('sess-1');

      expect(findTopics).toHaveBeenCalledWith({
        where: { versionId: 'ver-1' },
        select: { key: true, label: true },
      });
      expect(findDocSections).toHaveBeenCalledWith({
        where: { versionId: 'ver-1' },
        select: { id: true, title: true },
      });
      expect(loaded?.turns).toEqual([
        expect.objectContaining({ sectionLabel: 'About You' }),
        expect.objectContaining({ sectionLabel: 'Wrap-up' }),
        // Unresolvable key falls back to the raw key rather than dropping the heading.
        expect.objectContaining({ sectionLabel: 'unknown-key' }),
      ]);
    });

    it('lets a topic win over a document section sharing the same key', async () => {
      findTopics.mockResolvedValue([{ key: 'shared-key', label: 'Topic label' }]);
      findDocSections.mockResolvedValue([{ id: 'shared-key', title: 'Doc section label' }]);
      findSession.mockResolvedValue(
        row({
          turns: [
            {
              userMessage: 'Q',
              agentResponse: 'A',
              createdAt: new Date('2026-06-01T09:05:00.000Z'),
              sectionKey: 'shared-key',
            },
          ],
        })
      );

      const loaded = await loadTranscriptExport('sess-1');
      expect(loaded?.turns[0]).toMatchObject({ sectionLabel: 'Topic label' });
    });

    it('a turn with no sectionKey at all carries no sectionLabel property', async () => {
      findSession.mockResolvedValue(row());
      const loaded = await loadTranscriptExport('sess-1');
      expect(loaded?.turns[0]).not.toHaveProperty('sectionLabel');
    });
  });
});

describe('assembleTranscriptExportModel', () => {
  function loaded(over: Partial<LoadedTranscriptExport> = {}): LoadedTranscriptExport {
    return {
      session: { id: 'sess-1', respondentUserId: 'user-1' },
      questionnaireId: 'q-1',
      questionnaireTitle: 'Onboarding survey',
      versionNumber: 3,
      goal: 'Understand needs',
      audience: null,
      refRaw: 'GSP289HB',
      anonymous: false,
      respondentName: 'Ada Lovelace',
      startedAt: '2026-06-01T09:00:00.000Z',
      completedAt: '2026-06-02T10:30:00.000Z',
      status: 'completed',
      theme: {
        ctaColor: '#111111',
        accentColor: '#abcdef',
        logoUrl: 'https://cdn.example.com/logo.png',
        welcomeCopy: 'Welcome',
      },
      turns: [{ userMessage: 'Hi', agentResponse: 'Hello!', at: '2026-06-01T09:05:00.000Z' }],
      ...over,
    };
  }

  it('embeds the fetched logo and passes the loaded fields through to the pure builder', async () => {
    mocks.fetchLogoDataUri.mockResolvedValue('data:image/png;base64,AAAA');
    const model = await assembleTranscriptExportModel(loaded(), { fetchLogo: true });

    expect(mocks.fetchLogoDataUri).toHaveBeenCalledWith('https://cdn.example.com/logo.png');
    expect(model.theme.logoUrl).toBe('data:image/png;base64,AAAA');
    expect(model.questionnaireTitle).toBe('Onboarding survey');
    expect(model.versionNumber).toBe(3);
    expect(model.respondentLabel).toBe('Ada Lovelace');
    // One turn carrying both a userMessage and an agentResponse flattens to 2 transcript lines.
    expect(model.turns).toHaveLength(2);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('warns and renders without a logo when the fetch fails for a set URL', async () => {
    mocks.fetchLogoDataUri.mockResolvedValue(null);
    const model = await assembleTranscriptExportModel(loaded(), { fetchLogo: true });

    expect(model.theme.logoUrl).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Transcript export: brand logo unavailable, rendering without it',
      { sessionId: 'sess-1' }
    );
  });

  it('does not warn when there was never a logo URL to fetch', async () => {
    mocks.fetchLogoDataUri.mockResolvedValue(null);
    const model = await assembleTranscriptExportModel(
      loaded({ theme: { ctaColor: null, accentColor: null, logoUrl: null, welcomeCopy: null } }),
      { fetchLogo: true }
    );
    expect(model.theme.logoUrl).toBeNull();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('skips the fetch entirely for the text export, and the logo slot stays empty regardless of what was loaded', async () => {
    const model = await assembleTranscriptExportModel(loaded(), { fetchLogo: false });

    expect(mocks.fetchLogoDataUri).not.toHaveBeenCalled();
    expect(model.theme.logoUrl).toBeNull();
  });

  it('carries anonymous mode through so the builder falls back to the generic respondent label', async () => {
    const model = await assembleTranscriptExportModel(
      loaded({ anonymous: true, respondentName: 'Ada Lovelace' }),
      { fetchLogo: false }
    );
    expect(model.respondentLabel).not.toBe('Ada Lovelace');
    expect(model.anonymous).toBe(true);
  });
});
