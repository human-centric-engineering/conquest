/**
 * Integration test: the session-export DB read seam + model assembly (F7.4).
 *
 * Prisma + `fetch` are mocked; the real pure builder (`buildSessionExportModel`,
 * `resolveTheme`, `buildAnswerPanelView`) runs. Pins the seam's own responsibilities that
 * the route tests mock away:
 *   - {@link loadSessionExport}: null-session → null; status narrowing; the anonymous
 *     identity skip (never queries the user table); the `completedAt` resolution ladder
 *     (latest `completed` event → row `updatedAt` when completed → null); turn-id →
 *     ordinal mapping; the row → builder-input mapping; `refinementHistory`/`audience`
 *     Json narrowing; theme columns → RawTheme.
 *   - {@link buildSessionExportPdfModel}: the best-effort brand-logo fetch (absent /
 *     non-https / non-ok / non-image / oversize / empty / network-error all → no logo,
 *     warn when a URL was set), and delegation to the pure builder.
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/session-export.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/logging', () => ({ logger: mocks.logger }));

import {
  loadSessionExport,
  buildSessionExportPdfModel,
  type LoadedSessionExport,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/session-export';

type Mock = ReturnType<typeof vi.fn>;
const findSession = mocks.prisma.appQuestionnaireSession.findUnique as Mock;
const findUser = mocks.prisma.user.findUnique as Mock;

/** A findUnique row matching the seam's `select`, with overridable parts. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    status: 'completed',
    respondentUserId: 'user-1',
    updatedAt: new Date('2026-06-02T09:00:00.000Z'),
    version: {
      versionNumber: 3,
      goal: 'Understand needs',
      audience: { description: 'New hires' },
      questionnaireId: 'q-1',
      config: { anonymousMode: false },
      questionnaire: {
        title: 'Onboarding survey',
        demoClient: {
          ctaColor: '#111111',
          accentColor: '#abcdef',
          logoUrl: 'https://cdn.example.com/logo.png',
          welcomeCopy: 'Welcome',
        },
      },
      sections: [
        {
          id: 'sec-1',
          title: 'About you',
          questions: [
            { key: 'name', prompt: 'Your name?', type: 'free_text', required: true },
            { key: 'colour', prompt: 'Favourite colour?', type: 'single_choice', required: false },
          ],
        },
      ],
    },
    answers: [
      {
        value: 'Ada',
        confidence: 0.9,
        provenanceLabel: 'direct',
        rationale: 'Stated directly.',
        lastUpdatedTurnId: 'turn-b',
        refinementHistory: [],
        questionSlot: { key: 'name' },
      },
    ],
    turns: [
      { id: 'turn-a', ordinal: 1 },
      { id: 'turn-b', ordinal: 2 },
    ],
    events: [{ createdAt: new Date('2026-06-02T10:30:00.000Z') }],
    ...over,
  };
}

/** Deep-override the nested `version` block without losing its other fields. */
function rowWithVersion(versionOver: Record<string, unknown>) {
  return row({ version: { ...row().version, ...versionOver } });
}

beforeEach(() => {
  vi.clearAllMocks();
  findUser.mockResolvedValue({ name: 'Ada Lovelace' });
});

describe('loadSessionExport', () => {
  it('returns null when the session does not resolve', async () => {
    findSession.mockResolvedValue(null);
    await expect(loadSessionExport('missing')).resolves.toBeNull();
    expect(findUser).not.toHaveBeenCalled();
  });

  it('maps the full row to the loaded export shape', async () => {
    findSession.mockResolvedValue(row());
    const loaded = await loadSessionExport('sess-1');

    expect(loaded?.session).toEqual({ id: 'sess-1', respondentUserId: 'user-1' });
    expect(loaded?.questionnaireId).toBe('q-1');
    expect(loaded?.questionnaireTitle).toBe('Onboarding survey');
    expect(loaded?.versionNumber).toBe(3);
    expect(loaded?.goal).toBe('Understand needs');
    expect(loaded?.audience).toEqual({ description: 'New hires' });
    expect(loaded?.anonymous).toBe(false);
    expect(loaded?.status).toBe('completed');
    expect(loaded?.theme).toEqual({
      ctaColor: '#111111',
      accentColor: '#abcdef',
      logoUrl: 'https://cdn.example.com/logo.png',
      welcomeCopy: 'Welcome',
    });
  });

  it('maps sections and answers, resolving the turn ordinal', async () => {
    findSession.mockResolvedValue(row());
    const loaded = await loadSessionExport('sess-1');

    expect(loaded?.sections).toEqual([
      {
        sectionId: 'sec-1',
        title: 'About you',
        slots: [
          { slotKey: 'name', prompt: 'Your name?', type: 'free_text', required: true },
          {
            slotKey: 'colour',
            prompt: 'Favourite colour?',
            type: 'single_choice',
            required: false,
          },
        ],
      },
    ]);
    expect(loaded?.answers).toHaveLength(1);
    expect(loaded?.answers[0]).toMatchObject({
      slotKey: 'name',
      value: 'Ada',
      provenance: 'direct',
      confidence: 0.9,
      rationale: 'Stated directly.',
      answeredAtTurnIndex: 2, // turn-b → ordinal 2
      refinementHistory: [],
    });
  });

  it('leaves answeredAtTurnIndex null when the turn id is absent', async () => {
    findSession.mockResolvedValue(
      row({
        answers: [
          {
            value: 'Ada',
            confidence: null,
            provenanceLabel: 'direct',
            rationale: null,
            lastUpdatedTurnId: null,
            refinementHistory: [],
            questionSlot: { key: 'name' },
          },
        ],
      })
    );
    const loaded = await loadSessionExport('sess-1');
    expect(loaded?.answers[0].answeredAtTurnIndex).toBeNull();
  });

  it('leaves answeredAtTurnIndex null when the turn id is set but unmapped', async () => {
    findSession.mockResolvedValue(
      row({
        answers: [
          {
            value: 'Ada',
            confidence: 0.5,
            provenanceLabel: 'direct',
            rationale: null,
            lastUpdatedTurnId: 'turn-orphan', // not present in row().turns
            refinementHistory: [],
            questionSlot: { key: 'name' },
          },
        ],
      })
    );
    const loaded = await loadSessionExport('sess-1');
    expect(loaded?.answers[0].answeredAtTurnIndex).toBeNull();
  });

  it('coerces a non-array refinementHistory Json to an empty array', async () => {
    findSession.mockResolvedValue(
      row({
        answers: [
          {
            value: 'Ada',
            confidence: 0.5,
            provenanceLabel: 'direct',
            rationale: null,
            lastUpdatedTurnId: 'turn-a',
            refinementHistory: { not: 'an array' }, // malformed Json column
            questionSlot: { key: 'name' },
          },
        ],
      })
    );
    const loaded = await loadSessionExport('sess-1');
    expect(loaded?.answers[0].refinementHistory).toEqual([]);
  });

  it('narrows a non-object audience Json to null', async () => {
    findSession.mockResolvedValue(rowWithVersion({ audience: 'just a string' }));
    const loaded = await loadSessionExport('sess-1');
    expect(loaded?.audience).toBeNull();
  });

  it('narrows an unrecognised session status to active', async () => {
    findSession.mockResolvedValue(row({ status: 'bogus' }));
    const loaded = await loadSessionExport('sess-1');
    expect(loaded?.status).toBe('active');
  });

  it('fills theme columns with nulls when the questionnaire is unattributed', async () => {
    findSession.mockResolvedValue(
      rowWithVersion({
        questionnaire: { title: 'Standalone', demoClient: null },
      })
    );
    const loaded = await loadSessionExport('sess-1');
    expect(loaded?.theme).toEqual({
      ctaColor: null,
      accentColor: null,
      logoUrl: null,
      welcomeCopy: null,
    });
  });

  describe('respondent identity', () => {
    it('looks up the respondent name when not anonymous', async () => {
      findSession.mockResolvedValue(row());
      const loaded = await loadSessionExport('sess-1');
      expect(findUser).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { name: true },
      });
      expect(loaded?.respondentName).toBe('Ada Lovelace');
    });

    it('never queries identity in anonymous mode', async () => {
      findSession.mockResolvedValue(rowWithVersion({ config: { anonymousMode: true } }));
      const loaded = await loadSessionExport('sess-1');
      expect(loaded?.anonymous).toBe(true);
      expect(loaded?.respondentName).toBeNull();
      expect(findUser).not.toHaveBeenCalled();
    });

    it('defaults anonymous to false when the version has no config row', async () => {
      findSession.mockResolvedValue(rowWithVersion({ config: null }));
      const loaded = await loadSessionExport('sess-1');
      expect(loaded?.anonymous).toBe(false);
    });

    it('leaves the name null for a non-anonymous session with no respondent user', async () => {
      findSession.mockResolvedValue(row({ respondentUserId: null }));
      const loaded = await loadSessionExport('sess-1');
      expect(loaded?.respondentName).toBeNull();
      expect(findUser).not.toHaveBeenCalled();
    });

    it('leaves the name null when the respondent user is missing', async () => {
      findUser.mockResolvedValue(null);
      findSession.mockResolvedValue(row());
      const loaded = await loadSessionExport('sess-1');
      expect(loaded?.respondentName).toBeNull();
    });
  });

  describe('completion timestamp', () => {
    it('uses the latest completed event when present', async () => {
      findSession.mockResolvedValue(row());
      const loaded = await loadSessionExport('sess-1');
      expect(loaded?.completedAt).toBe('2026-06-02T10:30:00.000Z');
    });

    it('falls back to updatedAt when completed with no event', async () => {
      findSession.mockResolvedValue(row({ events: [] }));
      const loaded = await loadSessionExport('sess-1');
      expect(loaded?.completedAt).toBe('2026-06-02T09:00:00.000Z');
    });

    it('is null for an in-progress session with no completion event', async () => {
      findSession.mockResolvedValue(row({ status: 'active', events: [] }));
      const loaded = await loadSessionExport('sess-1');
      expect(loaded?.completedAt).toBeNull();
    });
  });
});

describe('buildSessionExportPdfModel', () => {
  /** A loaded export with an overridable theme (logo fetch is the seam's only side effect). */
  function loaded(over: Partial<LoadedSessionExport> = {}): LoadedSessionExport {
    return {
      session: { id: 'sess-1', respondentUserId: 'user-1' },
      questionnaireId: 'q-1',
      questionnaireTitle: 'Onboarding survey',
      versionNumber: 3,
      goal: 'Understand needs',
      audience: { description: 'New hires' },
      anonymous: false,
      respondentName: 'Ada Lovelace',
      completedAt: '2026-06-02T10:30:00.000Z',
      theme: {
        ctaColor: '#111111',
        accentColor: '#abcdef',
        logoUrl: 'https://cdn.example.com/logo.png',
        welcomeCopy: 'Welcome',
      },
      status: 'completed',
      sections: [
        {
          sectionId: 'sec-1',
          title: 'About you',
          slots: [{ slotKey: 'name', prompt: 'Your name?', type: 'free_text', required: true }],
        },
      ],
      answers: [
        {
          slotKey: 'name',
          value: 'Ada',
          provenance: 'direct',
          confidence: 0.9,
          rationale: null,
          answeredAtTurnIndex: 1,
          refinementHistory: [],
        },
      ],
      ...over,
    };
  }

  /** Build a fake `fetch` Response with the given pieces (real `Headers` so the
   *  fake matches the `Response.headers` contract the source reads). */
  function fakeResponse(opts: { ok?: boolean; contentType?: string; bytes?: number }): Response {
    const { ok = true, contentType = 'image/png', bytes = 16 } = opts;
    return {
      ok,
      headers: new Headers({ 'content-type': contentType }),
      arrayBuffer: async () => new ArrayBuffer(bytes),
    } as unknown as Response;
  }

  function stubFetch(impl: (...args: unknown[]) => unknown) {
    vi.stubGlobal('fetch', vi.fn(impl));
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  // Drop any fetch stub after the last test in this block too, so it never leaks
  // into another test file sharing the Vitest worker (beforeEach only covers the next).
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('embeds the brand logo as a base64 data URI on a successful image fetch', async () => {
    stubFetch(async () => fakeResponse({ contentType: 'image/png', bytes: 8 }));
    const model = await buildSessionExportPdfModel(loaded());

    expect(model.theme.logoUrl).toMatch(/^data:image\/png;base64,/);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('delegates to the pure builder (counts, redaction, generatedAt stamped)', async () => {
    stubFetch(async () => fakeResponse({}));
    const model = await buildSessionExportPdfModel(loaded({ anonymous: true }));

    expect(model.questionnaireTitle).toBe('Onboarding survey');
    expect(model.answeredCount).toBe(1);
    expect(model.totalCount).toBe(1);
    expect(model.respondent).toBeNull(); // anonymous redaction applied by the builder
    expect(model.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('renders without a logo and does not fetch when no logo URL is set', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const model = await buildSessionExportPdfModel(
      loaded({ theme: { ctaColor: null, accentColor: null, logoUrl: null, welcomeCopy: null } })
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(model.theme.logoUrl).toBeNull();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('skips a non-https logo URL and warns', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const model = await buildSessionExportPdfModel(
      loaded({
        theme: {
          ctaColor: null,
          accentColor: null,
          logoUrl: 'http://insecure.example.com/logo.png',
          welcomeCopy: null,
        },
      })
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(model.theme.logoUrl).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
  });

  it('drops the logo and warns on a non-ok response', async () => {
    stubFetch(async () => fakeResponse({ ok: false }));
    const model = await buildSessionExportPdfModel(loaded());
    expect(model.theme.logoUrl).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
  });

  it('drops the logo when the content type is not an image', async () => {
    stubFetch(async () => fakeResponse({ contentType: 'text/html' }));
    const model = await buildSessionExportPdfModel(loaded());
    expect(model.theme.logoUrl).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
  });

  it('drops an oversize logo and warns', async () => {
    stubFetch(async () => fakeResponse({ bytes: 1_000_001 }));
    const model = await buildSessionExportPdfModel(loaded());
    expect(model.theme.logoUrl).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
  });

  it('drops an empty logo response and warns', async () => {
    stubFetch(async () => fakeResponse({ bytes: 0 }));
    const model = await buildSessionExportPdfModel(loaded());
    expect(model.theme.logoUrl).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
  });

  it('drops the logo and warns on a network error', async () => {
    stubFetch(async () => {
      throw new Error('network down');
    });
    const model = await buildSessionExportPdfModel(loaded());
    expect(model.theme.logoUrl).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
  });
});
