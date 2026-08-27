/**
 * Per-version respondent-surface switches — the narrow projections the surfaces actually ask for.
 *
 * Each helper answers ONE question about a launched version ("may this surface promise anonymity?",
 * "is the mic on?"), and each is independently callable. They all project off the single
 * `cache()`d {@link loadVersionSurface} row rather than issuing a query apiece, so a page that
 * needs ten of them costs one round trip, not ten. Keep them as pure projections: any new switch
 * belongs in `SURFACE_CONFIG_SELECT` plus a function here, never a fresh `findUnique`.
 *
 * Config is 1:1 and LAZY throughout: an absent config row means the DEFAULT, not "off". Each
 * helper's default is stated on it, because they are NOT uniform.
 *
 * The authenticated surface reads these flags straight off its session-ownership query and does not
 * need these helpers; the no-login (`/q/[versionId]`) and run (`/x/[publicRef]`) surfaces have only
 * a versionId, so they call here. A fork that strips the demo respondent surfaces drops the call
 * sites and this file.
 *
 * Server-only.
 *
 * @see lib/app/questionnaire/chat/greeting.ts
 * @see lib/app/questionnaire/chat/surface-config.ts
 */

import { loadVersionSurface } from '@/lib/app/questionnaire/chat/surface-config';
import {
  ACCESS_MODES,
  ANSWER_SLOT_PANEL_SCOPES,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  narrowToEnum,
  PRESENTATION_MODES,
  RESPONDENT_CHROMES,
  RESPONDENT_LAYOUTS,
  DEFAULT_RESPONDENT_CHROME,
  DEFAULT_RESPONDENT_LAYOUT,
  REASONING_PLACEMENTS,
  type AccessMode,
  type AnswerSlotPanelScope,
  type PresentationMode,
  type RespondentChrome,
  type RespondentLayout,
  type ReasoningPlacement,
} from '@/lib/app/questionnaire/types';

/**
 * Resolve `anonymousMode` for a launched version — does the surface get to promise "your name and
 * details won't be passed on"? (See {@link buildWelcomeTurns}.) Absent config → not anonymous.
 */
export async function resolveAnonymousForVersion(versionId: string): Promise<boolean> {
  const version = await loadVersionSurface(versionId);
  return version?.config?.anonymousMode ?? false;
}

/**
 * Resolve `accessMode` (who may START) for a launched version — the access axis, orthogonal to
 * {@link resolveAnonymousForVersion}. An absent config row defaults to the safe `invitation_only`.
 * The public `/q/[versionId]` page calls this to decide whether a no-token walk-up may boot a
 * session (`public`/`both`) or must be turned away (`invitation_only`).
 */
export async function resolveAccessModeForVersion(versionId: string): Promise<AccessMode> {
  const version = await loadVersionSurface(versionId);
  return narrowToEnum(
    version?.config?.accessMode ?? 'invitation_only',
    ACCESS_MODES,
    'invitation_only'
  );
}

/**
 * Resolve `voiceEnabled` for a launched version. This is the per-questionnaire opt-in; the caller
 * ANDs it with the platform voice-input flag before deciding whether to show the mic and advise its
 * use. Absent config → off.
 */
export async function resolveVoiceEnabledForVersion(versionId: string): Promise<boolean> {
  const version = await loadVersionSurface(versionId);
  return version?.config?.voiceEnabled ?? false;
}

/**
 * Resolve `attachmentsEnabled` for a launched version. The per-questionnaire opt-in; the caller ANDs
 * it with the platform attachment-input flag before showing the paperclip. Absent config → off.
 */
export async function resolveAttachmentsEnabledForVersion(versionId: string): Promise<boolean> {
  const version = await loadVersionSurface(versionId);
  return version?.config?.attachmentsEnabled ?? false;
}

/**
 * Resolve `presentationMode` (chat | form | both) for a launched version. Absent config → `both`.
 * The authenticated surface reads it off its session-ownership query instead.
 */
export async function resolvePresentationModeForVersion(
  versionId: string
): Promise<PresentationMode> {
  const version = await loadVersionSurface(versionId);
  return narrowToEnum(version?.config?.presentationMode ?? 'both', PRESENTATION_MODES, 'both');
}

/**
 * Resolve `respondentLayout` for a launched version. Absent config, or a name this build does not
 * know, → `classic`: a rollback or a fork that dropped a layout must never blank the surface a
 * respondent is mid-session on. `resolveLayout` repeats the same fallback at the component
 * boundary, so neither layer alone is load-bearing.
 */
export async function resolveRespondentLayoutForVersion(
  versionId: string
): Promise<RespondentLayout> {
  const version = await loadVersionSurface(versionId);
  return narrowToEnum(
    version?.config?.respondentLayout ?? DEFAULT_RESPONDENT_LAYOUT,
    RESPONDENT_LAYOUTS,
    DEFAULT_RESPONDENT_LAYOUT
  );
}

/**
 * Resolve `respondentChrome` for a launched version — how much of ConQuest shows AROUND the
 * surface. Absent config, or a value this build does not know, → `full`: the chrome every
 * respondent page has always had. A rollback must not strip a live page of its header and footer,
 * for the same reason an unknown layout must not blank the surface inside them.
 */
export async function resolveRespondentChromeForVersion(
  versionId: string
): Promise<RespondentChrome> {
  const version = await loadVersionSurface(versionId);
  return narrowToEnum(
    version?.config?.respondentChrome ?? DEFAULT_RESPONDENT_CHROME,
    RESPONDENT_CHROMES,
    DEFAULT_RESPONDENT_CHROME
  );
}

/**
 * Resolve `answerSlotPanelScope` (full_progress | answered_only | hidden) for a launched version.
 * `hidden` is the chat-only surface — the workspace drops the answer panel and the mobile review
 * sheet. Resolved server-side so the layout is right on the first paint rather than reflowing when
 * the panel fetch lands. Absent config → `full_progress`. The authenticated surface reads it off
 * its session-ownership query instead.
 */
export async function resolveAnswerPanelScopeForVersion(
  versionId: string
): Promise<AnswerSlotPanelScope> {
  const version = await loadVersionSurface(versionId);
  return narrowToEnum(
    version?.config?.answerSlotPanelScope ?? DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope,
    ANSWER_SLOT_PANEL_SCOPES,
    DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope
  );
}

/**
 * Resolve `inlineCorrectionEnabled` (Variant B) for a launched version. Absent config → ON. The
 * authenticated surface reads it off its session-ownership query instead.
 */
export async function resolveInlineCorrectionForVersion(versionId: string): Promise<boolean> {
  const version = await loadVersionSurface(versionId);
  return (
    version?.config?.inlineCorrectionEnabled ?? DEFAULT_QUESTIONNAIRE_CONFIG.inlineCorrectionEnabled
  );
}

/**
 * Resolve `sessionResumeEnabled` for a launched version. The per-questionnaire opt-in that governs
 * whether the surface remembers an in-progress session on the device and offers the "Continue where
 * you left off / Start new" chooser (and whether the by-ref resume endpoint honours this version).
 * Absent config → ON.
 */
export async function resolveSessionResumeEnabledForVersion(versionId: string): Promise<boolean> {
  const version = await loadVersionSurface(versionId);
  return version?.config?.sessionResumeEnabled ?? DEFAULT_QUESTIONNAIRE_CONFIG.sessionResumeEnabled;
}

/**
 * Resolve `showProgressPercentText` for a launched version. Governs whether the "N% completed" text
 * renders beside the progress bar — the bar itself always renders. Absent config → ON. The
 * authenticated surface reads it off its session-ownership query instead.
 */
export async function resolveShowProgressPercentTextForVersion(
  versionId: string
): Promise<boolean> {
  const version = await loadVersionSurface(versionId);
  return (
    version?.config?.showProgressPercentText ?? DEFAULT_QUESTIONNAIRE_CONFIG.showProgressPercentText
  );
}

/**
 * Resolve the live "watch it think" reasoning placement (demo feature) for a launched version, or
 * `null` when the version has the feature turned off. The per-questionnaire opt-in; the caller ANDs
 * the platform reasoning-stream flag and passes the effective placement (or null) to the surface.
 *
 * NOTE the two-state default: NO config row means defaults (enabled, overlay), whereas a config row
 * with an explicit `reasoningStreamEnabled: false` disables it. That distinction is why this reads
 * `version.config` for presence rather than `?? true`.
 */
export async function resolveReasoningPlacementForVersion(
  versionId: string
): Promise<ReasoningPlacement | null> {
  const version = await loadVersionSurface(versionId);
  // No config row → defaults (enabled, overlay). An explicit `enabled: false` disables it.
  if (version?.config && !version.config.reasoningStreamEnabled) return null;
  return narrowToEnum(
    version?.config?.reasoningStreamPlacement ?? 'overlay',
    REASONING_PLACEMENTS,
    'overlay'
  );
}

/**
 * Resolve the "Animated" placement dwell timing for a launched version: the base dwell (ms) the
 * reasoning summary stays open for up to two steps, and the extra dwell (ms) per step beyond two.
 * Absent config → the {@link DEFAULT_QUESTIONNAIRE_CONFIG} values. The surface combines these with
 * the per-turn step count to size the open duration.
 */
export async function resolveReasoningDwellForVersion(
  versionId: string
): Promise<{ dwellMs: number; perItemMs: number }> {
  const version = await loadVersionSurface(versionId);
  return {
    dwellMs:
      version?.config?.reasoningStreamDwellMs ??
      DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamDwellMs,
    perItemMs:
      version?.config?.reasoningStreamPerItemMs ??
      DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamPerItemMs,
  };
}
