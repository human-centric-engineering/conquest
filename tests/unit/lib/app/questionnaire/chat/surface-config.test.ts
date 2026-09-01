/**
 * loadVersionSurface — unit tests.
 *
 * The single per-request read the respondent surfaces project off. What matters here is the
 * CONTRACT the projections depend on: the right version is queried, every switch a `resolve*`
 * helper reads is in the select, and a missing version comes back as `null` (each projection then
 * applies its own default) rather than throwing.
 *
 * @see lib/app/questionnaire/chat/surface-config.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireVersion: { findUnique: vi.fn() } },
}));

import { prisma } from '@/lib/db/client';
import {
  loadVersionSurface,
  SURFACE_CONFIG_SELECT,
} from '@/lib/app/questionnaire/chat/surface-config';

/** The `findUnique` argument, narrowed to what these assertions read. */
function findUniqueArg(): {
  where: { id: string };
  select: {
    questionnaire: { select: Record<string, boolean> };
    config: { select: Record<string, boolean> };
  } & Record<string, unknown>;
} {
  return vi.mocked(prisma.appQuestionnaireVersion.findUnique).mock.calls[0]?.[0] as never;
}

describe('loadVersionSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);
  });

  it('queries the requested version', async () => {
    await loadVersionSurface('ver-1');
    expect(findUniqueArg().where).toEqual({ id: 'ver-1' });
  });

  it('selects the version-level fields the brand band and preview banner read', async () => {
    await loadVersionSurface('ver-1');
    const { select } = findUniqueArg();
    // The preview banner names the version; the band titles itself. Both ride this row for free.
    expect(select).toMatchObject({ questionnaireId: true, versionNumber: true, status: true });
    expect(select.questionnaire.select).toEqual({ title: true, demoClientId: true });
  });

  it('selects every switch the respondent projections read', async () => {
    await loadVersionSurface('ver-1');
    // The regression this guards: a `resolve*ForVersion` helper reading a column nobody selected
    // would silently return its default forever.
    expect(findUniqueArg().select.config.select).toEqual({
      anonymousMode: true,
      accessMode: true,
      voiceEnabled: true,
      attachmentsEnabled: true,
      chatTextSize: true,
      presentationMode: true,
      respondentLayout: true,
      sections: true,
      respondentDesign: true,
      respondentChrome: true,
      answerSlotPanelScope: true,
      inlineCorrectionEnabled: true,
      sessionResumeEnabled: true,
      showProgressPercentText: true,
      reasoningStreamEnabled: true,
      reasoningStreamPlacement: true,
      reasoningStreamDwellMs: true,
      reasoningStreamPerItemMs: true,
    });
  });

  it('selects scalars only — the config JSON columns cost every respondent page load', async () => {
    // The surface reads behaviour switches, never authored content. `CONFIG_SELECT` in the admin
    // read view is the one that carries tone/personas/intro and friends; this one must not.
    const heavy = [
      'tone',
      'personas',
      'personaSelection',
      'interviewerStrategy',
      'respondentReport',
      'cohortReport',
      'intro',
      'profileFields',
      'inviteeFields',
      'milestoneBannerThresholds',
    ];
    for (const column of heavy) {
      expect(SURFACE_CONFIG_SELECT).not.toHaveProperty(column);
    }
  });

  it('returns null when the version does not resolve', async () => {
    expect(await loadVersionSurface('nope')).toBeNull();
  });

  it('passes the row through unchanged for the projections to interpret', async () => {
    const row = {
      questionnaireId: 'qn-1',
      versionNumber: 3,
      status: 'launched',
      questionnaire: { title: 'Onboarding', demoClientId: 'client-1' },
      config: { anonymousMode: true },
    };
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(row as never);

    // No normalisation happens here on purpose: the defaults are NOT uniform across switches, so
    // each projection applies its own.
    expect(await loadVersionSurface('ver-1')).toEqual(row);
  });
});
