/**
 * Resolve a session's {@link RespondentSurfaceConfig} — the DB seam.
 *
 * Projects off the shared `cache()`d {@link loadVersionSurface} row, exactly as the per-field
 * `resolve*ForVersion` helpers in `chat/anonymity.ts` do, so this bundle costs the same single
 * version read they share rather than a query per switch. One extra hop is unavoidable: those
 * helpers start from a versionId and this starts from a SESSION, so the session→version lookup
 * comes first (and brings `roundId` along for the band's schedule cluster).
 *
 * The projections are written out rather than delegated to the nine per-field helpers, which would
 * be DRYer but would depend on `cache()` being active to stay at one query — and this runs in a
 * route handler, not only in a page render. The cost of writing them out is a second copy of nine
 * fallbacks, which `resolve-respondent-surface.test.ts` pins field-for-field against the originals.
 * Config is 1:1 and LAZY throughout: an absent row means the DEFAULT, and the defaults are not
 * uniform — `reasoningPlacement` in particular is asymmetric (see below).
 *
 * Server-only. The pure contract is `./respondent-surface`.
 */

import { prisma } from '@/lib/db/client';
import { loadVersionSurface } from '@/lib/app/questionnaire/chat/surface-config';
import {
  resolveGlossaryAppendixForVersion,
  resolveGlossaryForHints,
} from '@/lib/app/questionnaire/glossary/resolve';
import type { BandHeader } from '@/lib/app/questionnaire/header/types';
import { resolveTheme } from '@/lib/app/questionnaire/theming';
import {
  ANSWER_SLOT_PANEL_SCOPES,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  narrowToEnum,
  PRESENTATION_MODES,
  RESPONDENT_LAYOUTS,
  REASONING_PLACEMENTS,
} from '@/lib/app/questionnaire/types';
import type { RespondentSurfaceConfig } from '@/lib/app/questionnaire/session/respondent-surface';

/**
 * Resolve the full surface bundle for an existing session, or null when the session (or its
 * version) does not resolve — the caller 404s, and the client falls back to its prop defaults.
 */
export async function resolveRespondentSurfaceConfig(
  sessionId: string
): Promise<RespondentSurfaceConfig | null> {
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: { versionId: true, roundId: true },
  });
  if (!session) return null;

  const version = await loadVersionSurface(session.versionId);
  if (!version) return null;

  const config = version.config;
  const { title, demoClientId } = version.questionnaire;

  const [client, round, glossary, glossaryAppendix] = await Promise.all([
    demoClientId
      ? prisma.appDemoClient.findUnique({
          where: { id: demoClientId },
          select: {
            ctaColor: true,
            accentColor: true,
            logoUrl: true,
            bannerUrl: true,
            welcomeCopy: true,
            surfaceColor: true,
            ctaColorEnd: true,
            logoBackgroundColor: true,
            logoBackgroundEnabled: true,
          },
        })
      : Promise.resolve(null),
    // `roundId` is a plain String (no Prisma relation — UG-1 identity-firewall posture), so the
    // round cannot be joined above and needs its own read. Open-ended sessions skip it.
    session.roundId
      ? prisma.appQuestionnaireRound.findUnique({
          where: { id: session.roundId },
          select: { name: true, status: true, opensAt: true, closesAt: true, closedAt: true },
        })
      : Promise.resolve(null),
    // Deliberately NOT folded into the shared surface row — the glossary has its own fail-soft
    // contract that row must not inherit. See `glossary/resolve.ts`.
    resolveGlossaryForHints(session.versionId),
    resolveGlossaryAppendixForVersion(session.versionId),
  ]);

  const header: BandHeader = {
    title,
    round: round
      ? {
          name: round.name,
          status: round.status,
          opensAt: round.opensAt,
          closesAt: round.closesAt,
          closedAt: round.closedAt,
        }
      : null,
  };

  return {
    // `?? false`, NOT `?? DEFAULT_QUESTIONNAIRE_CONFIG.voiceEnabled` (which is `true`). The
    // platform's declared default and its no-config-row resolver genuinely disagree here, and
    // `resolveVoiceEnabledForVersion` — what `/q` and `/x` actually run on — is the one that
    // decides what a respondent sees. Mirroring it keeps a breakout consistent with the same
    // questionnaire's standalone run; "fixing" it here would make a version with no config row
    // show a mic in a meeting and not outside one. The disagreement is worth resolving, but
    // platform-wide and on its own, not as a side effect of this bundle.
    voiceInputEnabled: config?.voiceEnabled ?? false,
    attachmentInputEnabled:
      config?.attachmentsEnabled ?? DEFAULT_QUESTIONNAIRE_CONFIG.attachmentsEnabled,
    presentationMode: narrowToEnum(
      config?.presentationMode ?? DEFAULT_QUESTIONNAIRE_CONFIG.presentationMode,
      PRESENTATION_MODES,
      DEFAULT_QUESTIONNAIRE_CONFIG.presentationMode
    ),
    respondentLayout: narrowToEnum(
      config?.respondentLayout ?? DEFAULT_QUESTIONNAIRE_CONFIG.respondentLayout,
      RESPONDENT_LAYOUTS,
      DEFAULT_QUESTIONNAIRE_CONFIG.respondentLayout
    ),
    answerPanelScope: narrowToEnum(
      config?.answerSlotPanelScope ?? DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope,
      ANSWER_SLOT_PANEL_SCOPES,
      DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope
    ),
    // The asymmetry is deliberate and matches `resolveReasoningPlacementForVersion`: only an
    // EXPLICIT `enabled: false` on an existing config row turns the stream off. A version with no
    // config row at all gets the default placement, not null.
    reasoningPlacement:
      config && !config.reasoningStreamEnabled
        ? null
        : narrowToEnum(
            config?.reasoningStreamPlacement ?? 'overlay',
            REASONING_PLACEMENTS,
            'overlay'
          ),
    reasoningDwellMs:
      config?.reasoningStreamDwellMs ?? DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamDwellMs,
    reasoningPerItemMs:
      config?.reasoningStreamPerItemMs ?? DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamPerItemMs,
    inlineCorrectionEnabled:
      config?.inlineCorrectionEnabled ?? DEFAULT_QUESTIONNAIRE_CONFIG.inlineCorrectionEnabled,
    showProgressPercentText:
      config?.showProgressPercentText ?? DEFAULT_QUESTIONNAIRE_CONFIG.showProgressPercentText,
    anonymous: config?.anonymousMode ?? false,
    theme: resolveTheme(client),
    header,
    glossary,
    glossaryAppendix,
  };
}
