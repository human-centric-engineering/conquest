import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import {
  isAttachmentInputEnabled,
  isIntroScreenEnabled,
  isPersonaSelectionEnabled,
  isLiveSessionsEnabled,
  isReasoningStreamEnabled,
  isVoiceInputEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { SessionEntry } from '@/components/app/questionnaire/intro/session-entry';
import { BrandThemeProvider } from '@/components/app/questionnaire/chat/brand-theme-provider';
import { buildWelcomeTurns } from '@/lib/app/questionnaire/chat/greeting';
import { resolveThemeForSession } from '@/lib/app/questionnaire/chat/theme';
import {
  resolveSessionHeader,
  resolveOwnedSessionTitle,
} from '@/lib/app/questionnaire/header/resolve';
import { resolveSessionIntro } from '@/lib/app/questionnaire/intro/resolve';
import { resolveSessionPersonas } from '@/lib/app/questionnaire/persona/resolve';
import { resolveSessionCapture } from '@/lib/app/questionnaire/profile/resolve-capture';
import { loadAnswerPanelState } from '@/app/api/v1/app/questionnaire-sessions/_lib/answer-panel';
import { loadSessionStatus } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-status';
import { loadSessionSurfaceConfig } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-surface-config';
import { loadTranscript } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript';
import {
  narrowToEnum,
  PRESENTATION_MODES,
  REASONING_PLACEMENTS,
} from '@/lib/app/questionnaire/types';
import type { QuestionnaireChatStatus } from '@/lib/app/questionnaire/chat/types';
import type { SessionStatusView } from '@/lib/app/questionnaire/session/status-view';

/**
 * Map the SSR-loaded session status to the surface's initial chat status. A budget-paused
 * session (hard cost tier) is terminal cost_capped, not a resumable pause; a respondent
 * pause is `not_active` (the lifecycle bar offers Resume); completed shows the
 * confirmation. Falls back to the row status when the status view didn't resolve.
 */
function initialChatStatus(
  view: SessionStatusView | undefined,
  fallbackActive: boolean
): QuestionnaireChatStatus {
  if (!view) return fallbackActive ? 'idle' : 'not_active';
  switch (view.status) {
    case 'active':
      return 'idle';
    case 'completed':
      return 'completed';
    case 'paused':
      return view.cost?.tier === 'hard' ? 'cost_capped' : 'not_active';
    default:
      return 'not_active'; // abandoned
  }
}

/**
 * Title the tab (and any browser-derived print/save filename) after the actual questionnaire, not a
 * generic "Questionnaire" — a respondent who prints or saves the completion report then gets a file
 * named for their questionnaire. Gated on ownership: the title resolves only for the session's own
 * respondent, so metadata never leaks another user's questionnaire title (mirroring the page body's
 * 404-without-confirming posture). Falls back to the generic title otherwise.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}): Promise<Metadata> {
  const description = 'Complete your questionnaire through a short conversation.';
  const session = await getServerSession();
  if (!session) return { title: 'Questionnaire', description };
  const { sessionId } = await params;
  const title = await resolveOwnedSessionTitle(sessionId, session.user.id);
  return { title: title ?? 'Questionnaire', description };
}

/**
 * Authenticated respondent chat surface (F7.1).
 *
 * The session is created upstream by `start`; this page renders the conversation. It verifies
 * ownership server-side (a session must belong to the signed-in user — anonymous, no-login
 * sessions are driven via `/q/[versionId]` instead) and seeds the surface with a welcome or
 * resume turn plus the session's blocking status, if any.
 *
 * The `/questionnaires` path is not in the proxy's protected list, so this page enforces auth
 * itself rather than relying on the route group alone.
 */
export default async function QuestionnaireSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  if (!(await isLiveSessionsEnabled())) notFound();

  const { sessionId } = await params;

  const session = await getServerSession();
  if (!session) clearInvalidSession(`/questionnaires/${sessionId}`);

  const row = await loadSessionSurfaceConfig(sessionId);

  // Not found, or not this user's session — 404 either way (don't confirm existence).
  if (!row || row.respondentUserId !== session.user.id) notFound();

  const anonymous = row.config?.anonymousMode ?? false;
  const presentationMode = narrowToEnum(
    row.config?.presentationMode ?? 'both',
    PRESENTATION_MODES,
    'both'
  );
  const wantsForm = presentationMode === 'form' || presentationMode === 'both';
  // Voice and attachments each need BOTH the platform flag (capability dark-launch) AND the
  // version's per-questionnaire opt-in, so the affordance shows only when the author turned it on.
  const voiceConfigured = row.config?.voiceEnabled ?? false;
  const attachmentsConfigured = row.config?.attachmentsEnabled ?? false;
  const reasoningConfigured = row.config?.reasoningStreamEnabled ?? false;
  // Independent reads — resolve in parallel rather than serialising the round-trips. The
  // panel + lifecycle status are SSR-seeded here (the user is already verified as owner),
  // so they paint with no fetch flash; the live updates after each turn come from the
  // client hooks.
  const [
    voicePlatform,
    attachmentPlatform,
    reasoningPlatform,
    theme,
    bandHeader,
    panel,
    status,
    formPanel,
    transcript,
  ] = await Promise.all([
    isVoiceInputEnabled(),
    isAttachmentInputEnabled(),
    isReasoningStreamEnabled(),
    resolveThemeForSession(sessionId),
    resolveSessionHeader(sessionId),
    loadAnswerPanelState(sessionId),
    loadSessionStatus(sessionId),
    // Seed the full form structure for form/both modes (forForm = full structure, no data-slot
    // swap); chat-only mode skips this round-trip.
    wantsForm ? loadAnswerPanelState(sessionId, false, true) : Promise.resolve(null),
    // Replay the prior conversation (incl. its persisted side-band notices) on resume.
    loadTranscript(sessionId),
  ]);
  const voiceInputEnabled = voicePlatform && voiceConfigured;
  const attachmentInputEnabled = attachmentPlatform && attachmentsConfigured;
  // Live "watch it think" reasoning (demo feature): the effective placement, or null when the
  // platform flag or version toggle is off (the chat then renders no trace).
  const reasoningPlacement =
    reasoningPlatform && reasoningConfigured
      ? narrowToEnum(
          row.config?.reasoningStreamPlacement ?? 'overlay',
          REASONING_PLACEMENTS,
          'overlay'
        )
      : null;
  const initialStatus = initialChatStatus(status?.view, row.status === 'active');

  // Respondent intro / splash (admin opt-in). Resolve only when the platform flag is on; the
  // per-version `intro.enabled` (and a fresh session) are the second gate, applied in SessionEntry.
  const intro = (await isIntroScreenEnabled()) ? await resolveSessionIntro(sessionId) : null;

  // Selectable interviewer personas (F-persona). Resolve only when the platform flag is on; the
  // per-version `personaSelection.enabled` (and ≥2 personas) are the second gate, applied in the
  // workspace via the resolved payload's `enabled`.
  const personas = (await isPersonaSelectionEnabled())
    ? await resolveSessionPersonas(sessionId)
    : null;

  // Respondent profile capture (F-capture). Resolves the blocking form gate for non-anonymous
  // versions collecting fields in `form` mode; `null` for anonymous (PII-free) and `satisfied` on a
  // resume with an existing snapshot. No platform flag — purely per-version config (like profileFields).
  const capture = await resolveSessionCapture(sessionId);

  // Resumed = the session already has turns. Replay them (transcript-only — the conversation is
  // its own context); a fresh session shows the branded welcome + guidance and auto-opens. Keyed
  // on turn count, not answers: a session can have turns with no captured answer yet (e.g. an
  // opening question the respondent hasn't answered), and re-asking on every reload would burn a turn.
  const resumed = transcript.length > 0;
  const initialTurns = resumed
    ? transcript
    : buildWelcomeTurns({
        resumed: false,
        welcomeCopy: theme.welcomeCopy,
        voiceInputEnabled,
        anonymous,
      });

  return (
    <div className="mx-auto h-[calc(100vh-12rem)] max-w-6xl">
      <BrandThemeProvider theme={theme} header={bandHeader}>
        <SessionEntry
          intro={intro}
          personas={personas}
          capture={capture}
          sessionId={sessionId}
          initialTurns={initialTurns}
          autoStart={!resumed}
          initialStatus={initialStatus}
          initialPanel={panel?.view}
          initialStatusView={status?.view}
          initialFormView={formPanel?.view}
          presentationMode={presentationMode}
          voiceInputEnabled={voiceInputEnabled}
          attachmentInputEnabled={attachmentInputEnabled}
          reasoningPlacement={reasoningPlacement}
          reasoningDwellMs={row.config?.reasoningStreamDwellMs}
          reasoningPerItemMs={row.config?.reasoningStreamPerItemMs}
          // Inline answer correction (Variant B): respondent-facing UX, default off; no platform flag.
          inlineCorrectionEnabled={row.config?.inlineCorrectionEnabled ?? false}
        />
      </BrandThemeProvider>
    </div>
  );
}
