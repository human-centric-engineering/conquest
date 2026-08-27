/**
 * resolveAnonymousForVersion — unit tests.
 *
 * The function queries Prisma for a version's config anonymousMode flag and returns
 * it, defaulting to false when the version or config row is absent.
 *
 * Test Coverage:
 * - Returns true when the version's config has anonymousMode: true
 * - Returns false when the version's config has anonymousMode: false
 * - Returns false (default) when the config row is absent (null)
 * - Returns false (default) when the version row is absent (null)
 * - Calls Prisma with the correct versionId and field selectors
 *
 * @see lib/app/questionnaire/chat/anonymity.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma before importing the module under test.
vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireVersion: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import {
  resolveAnonymousForVersion,
  resolveAccessModeForVersion,
  resolveVoiceEnabledForVersion,
  resolveAttachmentsEnabledForVersion,
  resolvePresentationModeForVersion,
  resolveRespondentLayoutForVersion,
  resolveRespondentChromeForVersion,
  resolveAnswerPanelScopeForVersion,
  resolveReasoningPlacementForVersion,
  resolveReasoningDwellForVersion,
  resolveInlineCorrectionForVersion,
  resolveSessionResumeEnabledForVersion,
  resolveShowProgressPercentTextForVersion,
} from '@/lib/app/questionnaire/chat/anonymity';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';

/**
 * The `findUnique` argument the resolvers passed, narrowed to what these assertions read.
 *
 * They all project off ONE shared surface row (`loadVersionSurface`), so the assertions check the
 * version queried and the presence of the column each resolver reads — not the exact select shape,
 * which is deliberately shared and grows as switches are added.
 */
function findUniqueArg(): {
  where: { id: string };
  select: { config: { select: Record<string, boolean> } };
} {
  return vi.mocked(prisma.appQuestionnaireVersion.findUnique).mock.calls[0]?.[0] as never;
}

describe('resolveRespondentLayoutForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored layout', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { respondentLayout: 'focus' },
    } as never);

    await expect(resolveRespondentLayoutForVersion('ver-abc')).resolves.toBe('focus');
  });

  it('falls back to classic when there is no config row', async () => {
    // A version that has never been saved renders exactly as it always did.
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);

    await expect(resolveRespondentLayoutForVersion('ver-abc')).resolves.toBe('classic');
  });

  it('falls back to classic for a layout this build does not know', async () => {
    // The rollback case, and the reason this boundary is forgiving where the PATCH validator is
    // strict: a row naming a layout that no longer exists must render Classic, not nothing.
    // The example name has to be one no build registers — it was 'broadsheet' until Broadsheet
    // shipped, at which point this quietly started asserting that a real layout resolves to Classic.
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { respondentLayout: 'kiosk' },
    } as never);

    await expect(resolveRespondentLayoutForVersion('ver-abc')).resolves.toBe('classic');
  });

  it('selects the column it reads', async () => {
    // Without this the resolver would silently return 'classic' forever, whatever the admin chose.
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);

    await resolveRespondentLayoutForVersion('ver-abc');

    expect(findUniqueArg().select.config.select).toHaveProperty('respondentLayout', true);
  });
});

describe('resolveRespondentChromeForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored chrome', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { respondentChrome: 'white_label' },
    } as never);

    await expect(resolveRespondentChromeForVersion('ver-abc')).resolves.toBe('white_label');
  });

  it('falls back to full when there is no config row', async () => {
    // A version saved before the column existed keeps the header and footer it has always had.
    // There is no backfill, so this fallback IS the reason nothing changed appearance.
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);

    await expect(resolveRespondentChromeForVersion('ver-abc')).resolves.toBe('full');
  });

  it('falls back to full for a chrome mode this build does not know', async () => {
    // The rollback case. A build that shipped a fourth mode and was rolled back leaves rows naming
    // it; a respondent mid-questionnaire must not find the page around them stripped bare. Same
    // asymmetry as the layout: forgiving here, strict at the PATCH validator.
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { respondentChrome: 'kiosk_mode' },
    } as never);

    await expect(resolveRespondentChromeForVersion('ver-abc')).resolves.toBe('full');
  });

  it('selects the column it reads', async () => {
    // Without this the resolver returns 'full' forever, whatever the admin chose — and a
    // white-labelled questionnaire would quietly keep showing our header to the client's
    // respondents, which is the one failure this feature exists to prevent.
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);

    await resolveRespondentChromeForVersion('ver-abc');

    expect(findUniqueArg().select.config.select).toHaveProperty('respondentChrome', true);
  });
});

describe('resolveAnonymousForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when the config row has anonymousMode: true', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { anonymousMode: true },
    } as never);

    // Act
    const result = await resolveAnonymousForVersion('ver-abc');

    // Assert: the function unwraps the nested flag, not just echoes the object
    expect(result).toBe(true);
  });

  it('returns false when the config row has anonymousMode: false', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { anonymousMode: false },
    } as never);

    // Act
    const result = await resolveAnonymousForVersion('ver-abc');

    // Assert
    expect(result).toBe(false);
  });

  it('returns false (default) when config is null', async () => {
    // Arrange: config row absent but version exists
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);

    // Act
    const result = await resolveAnonymousForVersion('ver-abc');

    // Assert: ?? false default applies when config is null
    expect(result).toBe(false);
  });

  it('returns false (default) when the version itself is null', async () => {
    // Arrange: version not found
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);

    // Act
    const result = await resolveAnonymousForVersion('ver-missing');

    // Assert: optional chaining on null returns undefined -> defaults to false
    expect(result).toBe(false);
  });

  it('queries Prisma with the correct versionId and selects only anonymousMode', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { anonymousMode: true },
    } as never);

    // Act
    await resolveAnonymousForVersion('ver-xyz');

    // Assert: verify the shape of the DB call — not just that it was called
    const call = findUniqueArg();
    expect(call.where).toEqual({ id: 'ver-xyz' });
    // The switch this resolver projects must actually be in the shared surface select —
    // the exact shape is `SURFACE_CONFIG_SELECT`'s business, the column is this one's.
    expect(call.select.config.select).toMatchObject({ anonymousMode: true });
  });

  it('calls findUnique exactly once per invocation', async () => {
    // Arrange
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);

    // Act
    await resolveAnonymousForVersion('ver-abc');

    // Assert: no redundant queries
    expect(prisma.appQuestionnaireVersion.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('resolvePresentationModeForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored presentation mode (form / both)', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { presentationMode: 'both' },
    } as never);
    expect(await resolvePresentationModeForVersion('ver-abc')).toBe('both');
  });

  it('defaults to both when the config row is absent', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);
    expect(await resolvePresentationModeForVersion('ver-abc')).toBe('both');
  });

  it('defaults to both when the version is absent', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);
    expect(await resolvePresentationModeForVersion('ver-missing')).toBe('both');
  });

  it('narrows an unrecognised stored value to both', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { presentationMode: 'telepathy' },
    } as never);
    expect(await resolvePresentationModeForVersion('ver-abc')).toBe('both');
  });

  it('selects only the presentationMode field for the given version', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { presentationMode: 'form' },
    } as never);
    await resolvePresentationModeForVersion('ver-xyz');
    const call = findUniqueArg();
    expect(call.where).toEqual({ id: 'ver-xyz' });
    // The switch this resolver projects must actually be in the shared surface select —
    // the exact shape is `SURFACE_CONFIG_SELECT`'s business, the column is this one's.
    expect(call.select.config.select).toMatchObject({ presentationMode: true });
  });
});

describe('resolveAnswerPanelScopeForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored scope (answered_only)', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { answerSlotPanelScope: 'answered_only' },
    } as never);
    expect(await resolveAnswerPanelScopeForVersion('ver-abc')).toBe('answered_only');
  });

  it('returns the stored scope when set to hidden', async () => {
    // Arrange: this branch's new value — must be explicitly exercised, not just narrowed-to
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { answerSlotPanelScope: 'hidden' },
    } as never);
    expect(await resolveAnswerPanelScopeForVersion('ver-abc')).toBe('hidden');
  });

  it('defaults to full_progress when the config row is absent', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);
    expect(await resolveAnswerPanelScopeForVersion('ver-abc')).toBe(
      DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope
    );
  });

  it('defaults to full_progress when the version is absent', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);
    expect(await resolveAnswerPanelScopeForVersion('ver-missing')).toBe(
      DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope
    );
  });

  it('narrows an unrecognised stored value to full_progress', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { answerSlotPanelScope: 'invisible-ink' },
    } as never);
    expect(await resolveAnswerPanelScopeForVersion('ver-abc')).toBe(
      DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope
    );
  });

  it('selects only the answerSlotPanelScope field for the given version', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { answerSlotPanelScope: 'hidden' },
    } as never);
    await resolveAnswerPanelScopeForVersion('ver-xyz');
    const call = findUniqueArg();
    expect(call.where).toEqual({ id: 'ver-xyz' });
    // The switch this resolver projects must actually be in the shared surface select —
    // the exact shape is `SURFACE_CONFIG_SELECT`'s business, the column is this one's.
    expect(call.select.config.select).toMatchObject({ answerSlotPanelScope: true });
  });
});

describe('resolveInlineCorrectionForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored toggle (off)', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { inlineCorrectionEnabled: false },
    } as never);
    expect(await resolveInlineCorrectionForVersion('ver-abc')).toBe(false);
  });

  it('defaults to OFF when the config row is absent', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);
    expect(await resolveInlineCorrectionForVersion('ver-abc')).toBe(
      DEFAULT_QUESTIONNAIRE_CONFIG.inlineCorrectionEnabled
    );
  });

  it('defaults to OFF when the version is absent', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);
    expect(await resolveInlineCorrectionForVersion('ver-missing')).toBe(
      DEFAULT_QUESTIONNAIRE_CONFIG.inlineCorrectionEnabled
    );
  });

  it('selects only the inlineCorrectionEnabled field for the given version', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { inlineCorrectionEnabled: true },
    } as never);
    await resolveInlineCorrectionForVersion('ver-xyz');
    const call = findUniqueArg();
    expect(call.where).toEqual({ id: 'ver-xyz' });
    // The switch this resolver projects must actually be in the shared surface select —
    // the exact shape is `SURFACE_CONFIG_SELECT`'s business, the column is this one's.
    expect(call.select.config.select).toMatchObject({ inlineCorrectionEnabled: true });
  });
});

describe('resolveSessionResumeEnabledForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored toggle (off)', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { sessionResumeEnabled: false },
    } as never);
    expect(await resolveSessionResumeEnabledForVersion('ver-abc')).toBe(false);
  });

  it('defaults to ON when the config row is absent', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);
    expect(await resolveSessionResumeEnabledForVersion('ver-abc')).toBe(
      DEFAULT_QUESTIONNAIRE_CONFIG.sessionResumeEnabled
    );
  });

  it('defaults to ON when the version is absent', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);
    expect(await resolveSessionResumeEnabledForVersion('ver-missing')).toBe(
      DEFAULT_QUESTIONNAIRE_CONFIG.sessionResumeEnabled
    );
  });
});

describe('resolveShowProgressPercentTextForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored toggle (off)', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { showProgressPercentText: false },
    } as never);
    expect(await resolveShowProgressPercentTextForVersion('ver-abc')).toBe(false);
  });

  it('defaults to ON when the config row is absent', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);
    expect(await resolveShowProgressPercentTextForVersion('ver-abc')).toBe(
      DEFAULT_QUESTIONNAIRE_CONFIG.showProgressPercentText
    );
  });

  it('defaults to ON when the version is absent', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);
    expect(await resolveShowProgressPercentTextForVersion('ver-missing')).toBe(
      DEFAULT_QUESTIONNAIRE_CONFIG.showProgressPercentText
    );
  });

  it('selects only the showProgressPercentText field for the given version', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { showProgressPercentText: true },
    } as never);
    await resolveShowProgressPercentTextForVersion('ver-xyz');
    const call = findUniqueArg();
    expect(call.where).toEqual({ id: 'ver-xyz' });
    // The switch this resolver projects must actually be in the shared surface select —
    // the exact shape is `SURFACE_CONFIG_SELECT`'s business, the column is this one's.
    expect(call.select.config.select).toMatchObject({ showProgressPercentText: true });
  });
});

describe('resolveAccessModeForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored access mode when set to public', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { accessMode: 'public' },
    } as never);
    expect(await resolveAccessModeForVersion('ver-abc')).toBe('public');
  });

  it('returns the stored access mode when set to both', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { accessMode: 'both' },
    } as never);
    expect(await resolveAccessModeForVersion('ver-abc')).toBe('both');
  });

  it('defaults to invitation_only when config is null', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);
    expect(await resolveAccessModeForVersion('ver-abc')).toBe('invitation_only');
  });

  it('defaults to invitation_only when the version row is null', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);
    expect(await resolveAccessModeForVersion('ver-missing')).toBe('invitation_only');
  });

  it('narrows an unrecognised stored value to invitation_only', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { accessMode: 'open_sesame' },
    } as never);
    expect(await resolveAccessModeForVersion('ver-abc')).toBe('invitation_only');
  });

  it('queries Prisma with the correct versionId and selects only accessMode', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { accessMode: 'public' },
    } as never);
    await resolveAccessModeForVersion('ver-xyz');
    const call = findUniqueArg();
    expect(call.where).toEqual({ id: 'ver-xyz' });
    // The switch this resolver projects must actually be in the shared surface select —
    // the exact shape is `SURFACE_CONFIG_SELECT`'s business, the column is this one's.
    expect(call.select.config.select).toMatchObject({ accessMode: true });
  });
});

describe('resolveVoiceEnabledForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when the config row has voiceEnabled: true', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { voiceEnabled: true },
    } as never);
    expect(await resolveVoiceEnabledForVersion('ver-abc')).toBe(true);
  });

  it('returns false when the config row has voiceEnabled: false', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { voiceEnabled: false },
    } as never);
    expect(await resolveVoiceEnabledForVersion('ver-abc')).toBe(false);
  });

  it('defaults to false when config is null', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);
    expect(await resolveVoiceEnabledForVersion('ver-abc')).toBe(false);
  });

  it('defaults to false when the version row is null', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);
    expect(await resolveVoiceEnabledForVersion('ver-missing')).toBe(false);
  });

  it('queries Prisma with the correct versionId and selects only voiceEnabled', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { voiceEnabled: true },
    } as never);
    await resolveVoiceEnabledForVersion('ver-xyz');
    const call = findUniqueArg();
    expect(call.where).toEqual({ id: 'ver-xyz' });
    // The switch this resolver projects must actually be in the shared surface select —
    // the exact shape is `SURFACE_CONFIG_SELECT`'s business, the column is this one's.
    expect(call.select.config.select).toMatchObject({ voiceEnabled: true });
  });
});

describe('resolveAttachmentsEnabledForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when the config row has attachmentsEnabled: true', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { attachmentsEnabled: true },
    } as never);
    expect(await resolveAttachmentsEnabledForVersion('ver-abc')).toBe(true);
  });

  it('returns false when the config row has attachmentsEnabled: false', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { attachmentsEnabled: false },
    } as never);
    expect(await resolveAttachmentsEnabledForVersion('ver-abc')).toBe(false);
  });

  it('defaults to false when config is null', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);
    expect(await resolveAttachmentsEnabledForVersion('ver-abc')).toBe(false);
  });

  it('defaults to false when the version row is null', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);
    expect(await resolveAttachmentsEnabledForVersion('ver-missing')).toBe(false);
  });

  it('queries Prisma with the correct versionId and selects only attachmentsEnabled', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { attachmentsEnabled: true },
    } as never);
    await resolveAttachmentsEnabledForVersion('ver-xyz');
    const call = findUniqueArg();
    expect(call.where).toEqual({ id: 'ver-xyz' });
    // The switch this resolver projects must actually be in the shared surface select —
    // the exact shape is `SURFACE_CONFIG_SELECT`'s business, the column is this one's.
    expect(call.select.config.select).toMatchObject({ attachmentsEnabled: true });
  });
});

describe('resolveReasoningPlacementForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns overlay when config is absent (no config row)', async () => {
    // No config row = defaults: enabled + overlay placement.
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);
    expect(await resolveReasoningPlacementForVersion('ver-abc')).toBe('overlay');
  });

  it('returns overlay when the version row is null', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);
    expect(await resolveReasoningPlacementForVersion('ver-missing')).toBe('overlay');
  });

  it('returns the stored placement when set to inline', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { reasoningStreamEnabled: true, reasoningStreamPlacement: 'inline' },
    } as never);
    expect(await resolveReasoningPlacementForVersion('ver-abc')).toBe('inline');
  });

  it('returns the stored placement when set to overlay', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { reasoningStreamEnabled: true, reasoningStreamPlacement: 'overlay' },
    } as never);
    expect(await resolveReasoningPlacementForVersion('ver-abc')).toBe('overlay');
  });

  it('returns null when reasoningStreamEnabled is explicitly false', async () => {
    // Explicit opt-out disables the feature regardless of placement value.
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { reasoningStreamEnabled: false, reasoningStreamPlacement: 'overlay' },
    } as never);
    expect(await resolveReasoningPlacementForVersion('ver-abc')).toBeNull();
  });

  it('narrows an unrecognised placement value to overlay', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { reasoningStreamEnabled: true, reasoningStreamPlacement: 'sidebar' },
    } as never);
    expect(await resolveReasoningPlacementForVersion('ver-abc')).toBe('overlay');
  });

  it('queries Prisma with the correct versionId and selects both reasoning fields', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { reasoningStreamEnabled: true, reasoningStreamPlacement: 'overlay' },
    } as never);
    await resolveReasoningPlacementForVersion('ver-xyz');
    const call = findUniqueArg();
    expect(call.where).toEqual({ id: 'ver-xyz' });
    // The switch this resolver projects must actually be in the shared surface select —
    // the exact shape is `SURFACE_CONFIG_SELECT`'s business, the column is this one's.
    expect(call.select.config.select).toMatchObject({
      reasoningStreamEnabled: true,
      reasoningStreamPlacement: true,
    });
  });
});

describe('resolveReasoningDwellForVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the config defaults when no config row exists', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: null,
    } as never);
    expect(await resolveReasoningDwellForVersion('ver-abc')).toEqual({
      dwellMs: DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamDwellMs,
      perItemMs: DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamPerItemMs,
    });
  });

  it('returns the config defaults when the version row is null', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue(null);
    expect(await resolveReasoningDwellForVersion('ver-missing')).toEqual({
      dwellMs: DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamDwellMs,
      perItemMs: DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamPerItemMs,
    });
  });

  it('returns the stored dwell timing when configured', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { reasoningStreamDwellMs: 1500, reasoningStreamPerItemMs: 250 },
    } as never);
    expect(await resolveReasoningDwellForVersion('ver-abc')).toEqual({
      dwellMs: 1500,
      perItemMs: 250,
    });
  });

  it('selects only the two dwell fields for the given version', async () => {
    vi.mocked(prisma.appQuestionnaireVersion.findUnique).mockResolvedValue({
      config: { reasoningStreamDwellMs: 2000, reasoningStreamPerItemMs: 330 },
    } as never);
    await resolveReasoningDwellForVersion('ver-xyz');
    const call = findUniqueArg();
    expect(call.where).toEqual({ id: 'ver-xyz' });
    // The switch this resolver projects must actually be in the shared surface select —
    // the exact shape is `SURFACE_CONFIG_SELECT`'s business, the column is this one's.
    expect(call.select.config.select).toMatchObject({
      reasoningStreamDwellMs: true,
      reasoningStreamPerItemMs: true,
    });
  });
});
