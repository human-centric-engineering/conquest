/**
 * Token-authed session boot reads — the fail-soft wire boundary every no-login respondent surface
 * shares.
 *
 * The component tests that consume these (`anonymous-session-boot`, `run-session-boot`,
 * `meeting-participant-boot`) mock this module at its boundary and say its "own retry/Zod behaviour
 * is tested elsewhere" — this file is that elsewhere. What matters here is the contract those
 * mocks stand in for, and it is load-bearing rather than incidental: none of these reads is an
 * enforcing boundary (the server routes are), so every one of them must degrade to a plainer
 * surface rather than throw. A respondent who cannot answer is the failure mode being designed out.
 *
 * Three things are pinned per fetcher: the token actually travels as `X-Session-Token`, a non-ok
 * response degrades rather than throws, and a body that does not match the schema degrades too —
 * plus the network-throw path, which is the one a real outage takes.
 *
 * {@link fetchSurfaceConfig} gets extra attention on ONE behaviour its siblings do not have: its
 * fields `.catch()` individually, so a single unrecognised value degrades that one affordance
 * instead of dropping the respondent back to every default at once. That is the whole point of
 * writing the schema that way, and it is invisible to a test that only checks the happy path.
 *
 * @see lib/app/questionnaire/session/boot-fetchers.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  fetchTranscript,
  fetchIntro,
  fetchPersonas,
  fetchCapture,
  fetchSurfaceConfig,
} from '@/lib/app/questionnaire/session/boot-fetchers';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A `Response`-alike carrying `body` as JSON. Only `ok` and `json()` are read by the module. */
function jsonRes(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

/** Stub `fetch` and hand back the mock so the request can be asserted. */
function stubFetch(response: Response | Error) {
  const mock =
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', mock);
  return mock;
}

const THEME = {
  ctaColor: '#111111',
  accentColor: '#222222',
  logoUrl: null,
  bannerUrl: null,
  welcomeCopy: 'Welcome',
  surfaceColor: null,
  ctaColorEnd: null,
  logoBackgroundColor: null,
  hasBrandIdentity: false,
  canvasColor: null,
  onCanvas: null,
  canvasIsDark: false,
  canvasColorDark: null,
  onCanvasDark: null,
  accentColorEnd: null,
  logoMarkUrl: null,
  logoDarkUrl: null,
  bandLogoUrl: null,
  bandLogoDarkUrl: null,
  fontPairing: 'neutral',
};

/** A fully valid surface payload; spread-and-override to corrupt one field at a time. */
const VALID_SURFACE = {
  voiceInputEnabled: true,
  attachmentInputEnabled: true,
  presentationMode: 'chat',
  answerPanelScope: 'hidden',
  reasoningPlacement: 'inline',
  reasoningDwellMs: 1234,
  reasoningPerItemMs: 567,
  inlineCorrectionEnabled: true,
  showProgressPercentText: false,
  anonymous: true,
  theme: THEME,
  header: { title: 'Board review', round: null },
  glossary: [{ termId: 't1', term: 'ARR', surfaces: ['arr'], definitions: ['Annual…'] }],
  glossaryAppendix: {
    heading: 'Definitions',
    entries: [{ term: 'ARR', definitions: ['Annual…'] }],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The shared fail-soft contract
// ---------------------------------------------------------------------------

/**
 * Each fetcher paired with the value it must degrade to. Driving the shared contract from a table
 * is what makes it a CONTRACT — a sixth fetcher added without these three paths is a visible
 * omission here rather than a silently untested one.
 */
const FETCHERS = [
  {
    name: 'fetchTranscript',
    call: fetchTranscript,
    path: '/transcript',
    degraded: { turns: [], inspectorTurns: [] },
  },
  { name: 'fetchIntro', call: fetchIntro, path: '/intro', degraded: null },
  { name: 'fetchPersonas', call: fetchPersonas, path: '/persona', degraded: null },
  { name: 'fetchCapture', call: fetchCapture, path: '/profile', degraded: null },
  { name: 'fetchSurfaceConfig', call: fetchSurfaceConfig, path: '/surface', degraded: null },
] as const;

describe.each(FETCHERS)('$name — fail-soft boot read', ({ call, path, degraded }) => {
  it('sends the session token as X-Session-Token to the session-scoped route', async () => {
    const mock = stubFetch(jsonRes({ success: true }));

    await call('sess_1', 'tok_abc');

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/app/questionnaire-sessions/sess_1');
    expect(url).toContain(path);
    expect(init.headers).toEqual({ 'X-Session-Token': 'tok_abc' });
  });

  it('degrades instead of throwing when the response is not ok', async () => {
    // 401/404/500 all land here — the surface must still open, just plainer.
    stubFetch(jsonRes({ success: false }, false));
    await expect(call('sess_1', 'tok_abc')).resolves.toEqual(degraded);
  });

  it('degrades instead of throwing when the body does not match the schema', async () => {
    stubFetch(
      jsonRes({ success: true, data: { surface: 'not-an-object', intro: 42, persona: 7 } })
    );
    await expect(call('sess_1', 'tok_abc')).resolves.toEqual(degraded);
  });

  it('degrades instead of throwing when the network call rejects', async () => {
    // The real-outage path: no response object at all.
    stubFetch(new Error('network down'));
    await expect(call('sess_1', 'tok_abc')).resolves.toEqual(degraded);
  });

  it('degrades when the envelope succeeds but carries no data', async () => {
    stubFetch(jsonRes({ success: true }));
    await expect(call('sess_1', 'tok_abc')).resolves.toEqual(degraded);
  });
});

// ---------------------------------------------------------------------------
// fetchSurfaceConfig — the per-field degradation that makes the schema worth writing
// ---------------------------------------------------------------------------

describe('fetchSurfaceConfig', () => {
  it('returns the resolved bundle when the payload is valid', async () => {
    stubFetch(jsonRes({ success: true, data: { surface: VALID_SURFACE } }));

    const surface = await fetchSurfaceConfig('sess_1', 'tok_abc');

    // Asserted field-for-field rather than by identity: this is a wire boundary, and a schema that
    // silently dropped a field would still satisfy a shallow truthiness check.
    expect(surface).toMatchObject({
      voiceInputEnabled: true,
      attachmentInputEnabled: true,
      presentationMode: 'chat',
      answerPanelScope: 'hidden',
      reasoningPlacement: 'inline',
      reasoningDwellMs: 1234,
      reasoningPerItemMs: 567,
      inlineCorrectionEnabled: true,
      showProgressPercentText: false,
      anonymous: true,
      theme: THEME,
    });
    expect(surface?.header).toEqual({ title: 'Board review', round: null });
    expect(surface?.glossary).toHaveLength(1);
    expect(surface?.glossaryAppendix?.heading).toBe('Definitions');
  });

  it('coerces the round window back to Dates so the band can do date arithmetic on it', async () => {
    // Dates cross the wire as ISO strings; the schedule helpers the band uses call Date methods.
    stubFetch(
      jsonRes({
        success: true,
        data: {
          surface: {
            ...VALID_SURFACE,
            header: {
              title: 'Board review',
              round: {
                name: 'Round 1',
                status: 'open',
                opensAt: '2026-08-01T09:00:00.000Z',
                closesAt: '2026-08-08T17:00:00.000Z',
                closedAt: null,
              },
            },
          },
        },
      })
    );

    const surface = await fetchSurfaceConfig('sess_1', 'tok_abc');

    expect(surface?.header?.round?.opensAt).toBeInstanceOf(Date);
    expect(surface?.header?.round?.opensAt?.toISOString()).toBe('2026-08-01T09:00:00.000Z');
    expect(surface?.header?.round?.closedAt).toBeNull();
  });

  it.each([
    ['presentationMode', 'holographic', DEFAULT_QUESTIONNAIRE_CONFIG.presentationMode],
    ['answerPanelScope', 'telepathic', DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope],
    ['voiceInputEnabled', 'yes-please', DEFAULT_QUESTIONNAIRE_CONFIG.voiceEnabled],
    ['reasoningDwellMs', 'soon', DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamDwellMs],
    ['showProgressPercentText', null, DEFAULT_QUESTIONNAIRE_CONFIG.showProgressPercentText],
  ])(
    'degrades only %s to its default when that one field is unrecognised',
    async (field, bogus, fallback) => {
      // A newer deploy widening an enum must cost the respondent ONE affordance, not all of them.
      stubFetch(
        jsonRes({ success: true, data: { surface: { ...VALID_SURFACE, [field]: bogus } } })
      );

      const surface = await fetchSurfaceConfig('sess_1', 'tok_abc');

      expect(surface).not.toBeNull();
      expect(surface?.[field as keyof typeof surface]).toBe(fallback);
      // Every neighbouring field survives — the whole reason each one `.catch()`es separately.
      expect(surface?.anonymous).toBe(true);
      expect(surface?.theme).toEqual(THEME);
      expect(surface?.glossary).toHaveLength(1);
    }
  );

  it('drops a malformed glossary to empty rather than failing the whole bundle', async () => {
    stubFetch(
      jsonRes({
        success: true,
        data: { surface: { ...VALID_SURFACE, glossary: 'not-an-array', glossaryAppendix: 12 } },
      })
    );

    const surface = await fetchSurfaceConfig('sess_1', 'tok_abc');

    expect(surface?.glossary).toEqual([]);
    expect(surface?.glossaryAppendix).toBeNull();
    // The affordances are untouched — a broken glossary must not turn the mic off.
    expect(surface?.voiceInputEnabled).toBe(true);
    expect(surface?.presentationMode).toBe('chat');
  });

  it('fails the parse when the theme is missing, because there is no safe theme to invent', async () => {
    // `theme` is the one field with no `.catch()`: a half-branded surface is worse than the
    // caller's own defaults, so the whole read degrades to null and the caller keeps its props.
    const { theme: _theme, ...withoutTheme } = VALID_SURFACE;
    stubFetch(jsonRes({ success: true, data: { surface: withoutTheme } }));

    await expect(fetchSurfaceConfig('sess_1', 'tok_abc')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchTranscript — the one fetcher with a partial-degradation rule of its own
// ---------------------------------------------------------------------------

describe('fetchTranscript', () => {
  it('returns the replayed turns with their reasoning intact', async () => {
    stubFetch(
      jsonRes({
        success: true,
        data: {
          turns: [
            { role: 'assistant', content: 'Hello' },
            {
              role: 'user',
              content: 'Hi',
              warnings: [{ code: 'milestone', message: "You're 50% of the way through." }],
            },
          ],
        },
      })
    );

    const { turns } = await fetchTranscript('sess_1', 'tok_abc');

    expect(turns).toHaveLength(2);
    expect(turns[1]?.warnings?.[0]?.code).toBe('milestone');
  });

  it('keeps the respondent transcript when only the admin-only inspector trace is malformed', async () => {
    // `.catch([])` on `inspectorTurns`: debug data must never wipe what the respondent sees.
    stubFetch(
      jsonRes({
        success: true,
        data: {
          turns: [{ role: 'assistant', content: 'Hello' }],
          inspectorTurns: 'corrupt',
        },
      })
    );

    const { turns, inspectorTurns } = await fetchTranscript('sess_1', 'tok_abc');

    expect(turns).toHaveLength(1);
    expect(inspectorTurns).toEqual([]);
  });

  it('drops the whole transcript when a respondent-facing turn is malformed', async () => {
    // The inverse of the rule above — `turns` has no `.catch()`, so a bad turn degrades to the
    // pre-replay behaviour (fresh greeting) rather than replaying a half-transcript.
    stubFetch(
      jsonRes({ success: true, data: { turns: [{ role: 'narrator', content: 'Hello' }] } })
    );

    await expect(fetchTranscript('sess_1', 'tok_abc')).resolves.toEqual({
      turns: [],
      inspectorTurns: [],
    });
  });
});
