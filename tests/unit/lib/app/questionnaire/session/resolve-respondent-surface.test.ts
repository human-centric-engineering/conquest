/**
 * `resolveRespondentSurfaceConfig` — the session-keyed bundle that lets a CLIENT-BOOTED respondent
 * surface (the facilitated-meeting participant) paint a session with its author's configuration
 * instead of the workspace's prop defaults.
 *
 * The headline suite here is PARITY: every field is asserted to equal what the corresponding
 * per-field resolver in `chat/anonymity.ts` produces from the identical config row. That is the
 * whole point of the test — the bundle is a second implementation of ten fallbacks that already
 * existed, and two implementations of a default is the shape that drifts. Rather than restating
 * the expected defaults as literals (which would drift in lockstep and prove nothing), each case
 * runs both code paths over one fixture and compares them.
 *
 * `reasoningPlacement` gets its own case because it is the one field whose fallback is asymmetric:
 * a MISSING config row means the default placement, while a present row with the feature off means
 * null. A naive `?? 'overlay'` passes the first and silently breaks the second.
 *
 * @see lib/app/questionnaire/session/resolve-respondent-surface.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionFindUnique = vi.fn();
const versionFindUnique = vi.fn();
const demoClientFindUnique = vi.fn();
const roundFindUnique = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireSession: { findUnique: (...a: unknown[]) => sessionFindUnique(...a) },
    appQuestionnaireVersion: { findUnique: (...a: unknown[]) => versionFindUnique(...a) },
    appDemoClient: { findUnique: (...a: unknown[]) => demoClientFindUnique(...a) },
    appQuestionnaireRound: { findUnique: (...a: unknown[]) => roundFindUnique(...a) },
  },
}));

vi.mock('@/lib/app/questionnaire/glossary/resolve', () => ({
  resolveGlossaryForHints: vi.fn(async () => [
    { termId: 't1', term: 'ego', surfaces: ['ego'], definitions: ['the self as actor'] },
  ]),
  resolveGlossaryAppendixForVersion: vi.fn(async () => ({
    heading: 'Definitions',
    entries: [{ term: 'ego', definitions: ['the self as actor'] }],
  })),
}));

import { resolveRespondentSurfaceConfig } from '@/lib/app/questionnaire/session/resolve-respondent-surface';
import {
  resolveAnonymousForVersion,
  resolveChatTextScaleIndexForVersion,
  resolveAnswerPanelScopeForVersion,
  resolveAttachmentsEnabledForVersion,
  resolveInlineCorrectionForVersion,
  resolvePresentationModeForVersion,
  resolveReasoningDwellForVersion,
  resolveReasoningPlacementForVersion,
  resolveShowProgressPercentTextForVersion,
  resolveVoiceEnabledForVersion,
} from '@/lib/app/questionnaire/chat/anonymity';

/** Every config column the bundle reads, defaulted to a value that is NOT the platform default. */
const FULL_CONFIG = {
  voiceEnabled: false,
  attachmentsEnabled: true,
  presentationMode: 'chat',
  answerSlotPanelScope: 'hidden',
  reasoningStreamEnabled: true,
  reasoningStreamPlacement: 'inline',
  reasoningStreamDwellMs: 4321,
  reasoningStreamPerItemMs: 765,
  inlineCorrectionEnabled: true,
  showProgressPercentText: false,
  anonymousMode: true,
  chatTextSize: 'largest',
};

/**
 * Point BOTH code paths at the same version row. Since the P16 perf pass they genuinely share one:
 * the bundle and the per-field resolvers both project off `loadVersionSurface`, so a single
 * `appQuestionnaireVersion.findUnique` mock feeds them both — which is what makes the comparison
 * below a real parity check rather than two fixtures that happen to agree.
 */
function primeConfig(config: Record<string, unknown> | null, demoClientId: string | null = null) {
  sessionFindUnique.mockResolvedValue({ versionId: 'ver-1', roundId: null });
  versionFindUnique.mockResolvedValue({
    questionnaireId: 'q-1',
    versionNumber: 1,
    status: 'launched',
    questionnaire: { title: 'Team health check', demoClientId },
    config,
  });
}

/** Run the ten per-field resolvers that the bundle duplicates. */
async function perFieldResolvers() {
  const [
    voiceInputEnabled,
    attachmentInputEnabled,
    presentationMode,
    answerPanelScope,
    reasoningPlacement,
    dwell,
    inlineCorrectionEnabled,
    showProgressPercentText,
    anonymous,
    chatTextScaleIndex,
  ] = await Promise.all([
    resolveVoiceEnabledForVersion('ver-1'),
    resolveAttachmentsEnabledForVersion('ver-1'),
    resolvePresentationModeForVersion('ver-1'),
    resolveAnswerPanelScopeForVersion('ver-1'),
    resolveReasoningPlacementForVersion('ver-1'),
    resolveReasoningDwellForVersion('ver-1'),
    resolveInlineCorrectionForVersion('ver-1'),
    resolveShowProgressPercentTextForVersion('ver-1'),
    resolveAnonymousForVersion('ver-1'),
    resolveChatTextScaleIndexForVersion('ver-1'),
  ]);
  return {
    voiceInputEnabled,
    attachmentInputEnabled,
    presentationMode,
    answerPanelScope,
    reasoningPlacement,
    reasoningDwellMs: dwell.dwellMs,
    reasoningPerItemMs: dwell.perItemMs,
    inlineCorrectionEnabled,
    showProgressPercentText,
    anonymous,
    chatTextScaleIndex,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  demoClientFindUnique.mockResolvedValue(null);
  roundFindUnique.mockResolvedValue(null);
});

describe('resolveRespondentSurfaceConfig — parity with the per-field resolvers', () => {
  it('matches field-for-field when the version has an explicit config row', async () => {
    primeConfig(FULL_CONFIG);

    const bundle = await resolveRespondentSurfaceConfig('sess-1');
    const expected = await perFieldResolvers();

    expect(bundle).toMatchObject(expected);
    // Guard the fixture itself: if these ever equalled the platform defaults, the whole suite
    // would pass while proving only that two defaults agree.
    expect(bundle?.presentationMode).toBe('chat');
    expect(bundle?.answerPanelScope).toBe('hidden');
    expect(bundle?.voiceInputEnabled).toBe(false);
    // The authored opening rung reaches a breakout the same as it reaches `/q`. Before the bundle
    // carried it, a participant whose questionnaire opened at Largest got the standard size the
    // moment they were moved into a breakout room — the exact class of silent drop this parity
    // test exists to catch.
    expect(bundle?.chatTextScaleIndex).toBe(3);
  });

  it('matches field-for-field when the version has NO config row (1:1 and lazy)', async () => {
    primeConfig(null);

    const bundle = await resolveRespondentSurfaceConfig('sess-1');
    const expected = await perFieldResolvers();

    expect(bundle).toMatchObject(expected);
    // `reasoningPlacement` defaults ON — a version with no config row still gets the stream, and
    // the meeting surface was silently dropping it before this bundle existed.
    expect(bundle?.reasoningPlacement).toBe('overlay');
    // Voice is pinned separately and deliberately. `DEFAULT_QUESTIONNAIRE_CONFIG.voiceEnabled` is
    // `true`, but `resolveVoiceEnabledForVersion` — the resolver `/q` and `/x` actually run on —
    // falls back to `false`. The bundle mirrors the RESOLVER, so a breakout matches the same
    // questionnaire's standalone run. If that platform-level disagreement is ever settled, this
    // line and the resolver should move together.
    expect(bundle?.voiceInputEnabled).toBe(false);
  });

  it('matches on the asymmetric reasoning fallback: a present row with the stream off is null', async () => {
    primeConfig({ ...FULL_CONFIG, reasoningStreamEnabled: false });

    const bundle = await resolveRespondentSurfaceConfig('sess-1');
    const expected = await perFieldResolvers();

    expect(bundle?.reasoningPlacement).toBe(expected.reasoningPlacement);
    expect(bundle?.reasoningPlacement).toBeNull();
  });

  it('falls back per field when the row carries an unrecognised enum value', async () => {
    primeConfig({
      ...FULL_CONFIG,
      presentationMode: 'telepathy',
      answerSlotPanelScope: 'psychic',
      chatTextSize: 'enormous',
    });

    const bundle = await resolveRespondentSurfaceConfig('sess-1');
    const expected = await perFieldResolvers();

    expect(bundle).toMatchObject(expected);
    expect(bundle?.presentationMode).toBe('both');
    expect(bundle?.answerPanelScope).toBe('full_progress');
    // Standard, not "whatever indexOf returned" — an unknown rung must not resolve to -1 and reach
    // the transcript's calc() as a NaN, which would drop its font-size declaration entirely.
    expect(bundle?.chatTextScaleIndex).toBe(1);
  });
});

describe('resolveRespondentSurfaceConfig — theme, header and glossary', () => {
  it('returns null for a session that does not resolve', async () => {
    sessionFindUnique.mockResolvedValue(null);
    expect(await resolveRespondentSurfaceConfig('gone')).toBeNull();
  });

  it('resolves the questionnaire’s demo-client brand', async () => {
    primeConfig(FULL_CONFIG, 'client-9');
    demoClientFindUnique.mockResolvedValue({
      ctaColor: '#123456',
      accentColor: '#654321',
      logoUrl: 'https://example.test/logo.png',
      bannerUrl: null,
      welcomeCopy: 'Welcome to Acme',
      surfaceColor: null,
      ctaColorEnd: null,
      logoBackgroundColor: null,
      logoBackgroundEnabled: false,
    });

    const bundle = await resolveRespondentSurfaceConfig('sess-1');

    expect(demoClientFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'client-9' } })
    );
    expect(bundle?.theme.ctaColor).toBe('#123456');
    expect(bundle?.theme.welcomeCopy).toBe('Welcome to Acme');
    // A client that supplied a colour and a logo owns the surface — the ConQuest fallback is off.
    expect(bundle?.theme.hasBrandIdentity).toBe(true);
  });

  it('skips the demo-client read entirely for an unattributed questionnaire', async () => {
    primeConfig(FULL_CONFIG);

    const bundle = await resolveRespondentSurfaceConfig('sess-1');

    expect(demoClientFindUnique).not.toHaveBeenCalled();
    // No client brand at all → ConQuest owns the chrome.
    expect(bundle?.theme.hasBrandIdentity).toBe(false);
  });

  it('carries the questionnaire title, and no round for an open-ended session', async () => {
    primeConfig(FULL_CONFIG);

    const bundle = await resolveRespondentSurfaceConfig('sess-1');

    expect(bundle?.header).toEqual({ title: 'Team health check', round: null });
    expect(roundFindUnique).not.toHaveBeenCalled();
  });

  it('reads the round in a second query, since roundId is a plain String not a relation', async () => {
    primeConfig(FULL_CONFIG);
    sessionFindUnique.mockResolvedValue({ versionId: 'ver-1', roundId: 'round-3' });
    const opensAt = new Date('2026-03-01T09:00:00Z');
    roundFindUnique.mockResolvedValue({
      name: 'Round 3',
      status: 'open',
      opensAt,
      closesAt: null,
      closedAt: null,
    });

    const bundle = await resolveRespondentSurfaceConfig('sess-1');

    expect(roundFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'round-3' } })
    );
    expect(bundle?.header?.round).toEqual({
      name: 'Round 3',
      status: 'open',
      opensAt,
      closesAt: null,
      closedAt: null,
    });
  });

  it('resolves the glossary and appendix for the session’s OWN version', async () => {
    primeConfig(FULL_CONFIG);

    const bundle = await resolveRespondentSurfaceConfig('sess-1');

    expect(bundle?.glossary).toEqual([
      { termId: 't1', term: 'ego', surfaces: ['ego'], definitions: ['the self as actor'] },
    ]);
    expect(bundle?.glossaryAppendix?.heading).toBe('Definitions');
  });
});
