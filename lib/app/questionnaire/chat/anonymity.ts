/**
 * Resolve a version's `anonymousMode` for the respondent opening turn — does the surface get
 * to promise "your name and details won't be passed on"? (See {@link buildWelcomeTurns}.)
 *
 * Config is 1:1 and lazy: an absent config row means the default, not anonymous. The
 * authenticated surface reads the flag straight off its session-ownership query and does not
 * need this helper; the no-login (`/q/[versionId]`) surface has only a versionId, so it calls
 * here. A fork that strips the demo respondent surfaces drops both call sites and this file.
 *
 * Server-only.
 *
 * @see lib/app/questionnaire/chat/greeting.ts
 */

import { prisma } from '@/lib/db/client';
import {
  ACCESS_MODES,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  narrowToEnum,
  PRESENTATION_MODES,
  REASONING_PLACEMENTS,
  type AccessMode,
  type PresentationMode,
  type ReasoningPlacement,
} from '@/lib/app/questionnaire/types';

/** Resolve `anonymousMode` for a launched version (no-login / preview respondent surface). */
export async function resolveAnonymousForVersion(versionId: string): Promise<boolean> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { config: { select: { anonymousMode: true } } },
  });
  return version?.config?.anonymousMode ?? false;
}

/**
 * Resolve `accessMode` (who may START) for a launched version — the access axis, orthogonal to
 * {@link resolveAnonymousForVersion}. Config is 1:1 and lazy; an absent row defaults to the safe
 * `invitation_only`. The public `/q/[versionId]` page calls this to decide whether a no-token
 * walk-up may boot a session (`public`/`both`) or must be turned away (`invitation_only`).
 */
export async function resolveAccessModeForVersion(versionId: string): Promise<AccessMode> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { config: { select: { accessMode: true } } },
  });
  return narrowToEnum(
    version?.config?.accessMode ?? 'invitation_only',
    ACCESS_MODES,
    'invitation_only'
  );
}

/**
 * Resolve `voiceEnabled` for a launched version (no-login / preview respondent surface). This is
 * the per-questionnaire opt-in; the caller ANDs it with the platform voice-input flag before
 * deciding whether to show the mic and advise its use. Config is 1:1 and lazy — absent = off.
 */
export async function resolveVoiceEnabledForVersion(versionId: string): Promise<boolean> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { config: { select: { voiceEnabled: true } } },
  });
  return version?.config?.voiceEnabled ?? false;
}

/**
 * Resolve `attachmentsEnabled` for a launched version (no-login / preview respondent surface). The
 * per-questionnaire opt-in; the caller ANDs it with the platform attachment-input flag before
 * showing the paperclip. Config is 1:1 and lazy — absent = off.
 */
export async function resolveAttachmentsEnabledForVersion(versionId: string): Promise<boolean> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { config: { select: { attachmentsEnabled: true } } },
  });
  return version?.config?.attachmentsEnabled ?? false;
}

/**
 * Resolve `presentationMode` (chat | form | both) for a launched version (no-login / preview
 * respondent surface). Config is 1:1 and lazy — an absent row defaults to `chat`. The
 * authenticated surface reads it off its session-ownership query instead.
 */
export async function resolvePresentationModeForVersion(
  versionId: string
): Promise<PresentationMode> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { config: { select: { presentationMode: true } } },
  });
  return narrowToEnum(version?.config?.presentationMode ?? 'both', PRESENTATION_MODES, 'both');
}

/**
 * Resolve `inlineCorrectionEnabled` (Variant B) for a launched version (no-login / preview
 * respondent surface). Config is 1:1 and lazy — an absent row defaults to ON (respondent-facing UX,
 * no platform flag). The authenticated surface reads it off its session-ownership query instead.
 */
export async function resolveInlineCorrectionForVersion(versionId: string): Promise<boolean> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { config: { select: { inlineCorrectionEnabled: true } } },
  });
  return (
    version?.config?.inlineCorrectionEnabled ?? DEFAULT_QUESTIONNAIRE_CONFIG.inlineCorrectionEnabled
  );
}

/**
 * Resolve `sessionResumeEnabled` for a launched version (no-login / preview respondent surface). The
 * per-questionnaire opt-in that governs whether the surface remembers an in-progress session on the
 * device and offers the "Continue where you left off / Start new" chooser (and whether the by-ref
 * resume endpoint honours this version). Config is 1:1 and lazy — an absent row defaults to ON.
 */
export async function resolveSessionResumeEnabledForVersion(versionId: string): Promise<boolean> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { config: { select: { sessionResumeEnabled: true } } },
  });
  return version?.config?.sessionResumeEnabled ?? DEFAULT_QUESTIONNAIRE_CONFIG.sessionResumeEnabled;
}

/**
 * Resolve the live "watch it think" reasoning placement (demo feature) for a launched version
 * (no-login / preview respondent surface), or `null` when the version has the feature turned off.
 * The per-questionnaire opt-in; the caller ANDs the platform reasoning-stream flag and passes the
 * effective placement (or null) to the surface. Config is 1:1 and lazy — absent = enabled/overlay.
 */
export async function resolveReasoningPlacementForVersion(
  versionId: string
): Promise<ReasoningPlacement | null> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: {
      config: { select: { reasoningStreamEnabled: true, reasoningStreamPlacement: true } },
    },
  });
  // No config row → defaults (enabled, overlay). An explicit `enabled: false` disables it.
  if (version?.config && !version.config.reasoningStreamEnabled) return null;
  return narrowToEnum(
    version?.config?.reasoningStreamPlacement ?? 'overlay',
    REASONING_PLACEMENTS,
    'overlay'
  );
}

/**
 * Resolve the "Animated" placement dwell timing for a launched version (no-login / preview surface):
 * the base dwell (ms) the reasoning summary stays open for up to two steps, and the extra dwell (ms)
 * per step beyond two. Config is 1:1 and lazy — absent = the {@link DEFAULT_QUESTIONNAIRE_CONFIG}
 * values. The surface combines these with the per-turn step count to size the open duration.
 */
export async function resolveReasoningDwellForVersion(
  versionId: string
): Promise<{ dwellMs: number; perItemMs: number }> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: {
      config: { select: { reasoningStreamDwellMs: true, reasoningStreamPerItemMs: true } },
    },
  });
  return {
    dwellMs:
      version?.config?.reasoningStreamDwellMs ??
      DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamDwellMs,
    perItemMs:
      version?.config?.reasoningStreamPerItemMs ??
      DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamPerItemMs,
  };
}
