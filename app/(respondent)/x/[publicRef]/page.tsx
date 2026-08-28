import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { BrandThemeProvider } from '@/components/app/questionnaire/chat/brand-theme-provider';
import { canvasBackdropVars } from '@/lib/app/questionnaire/theming';
import { RunSessionBoot } from '@/components/app/questionnaire/experiences/run-session-boot';
import {
  resolveGlossaryAppendixForVersion,
  resolveGlossaryForHints,
} from '@/lib/app/questionnaire/glossary/resolve';
import { resolveRunSurface } from '@/app/api/v1/app/experiences/_lib/run-surface';
import { resolveThemeForVersion } from '@/lib/app/questionnaire/chat/theme';
import { resolveVersionHeader } from '@/lib/app/questionnaire/header/resolve';
import {
  resolveAnonymousForVersion,
  resolveAttachmentsEnabledForVersion,
  resolveInlineCorrectionForVersion,
  resolveAnswerPanelScopeForVersion,
  resolvePresentationModeForVersion,
  resolveRespondentChromeForVersion,
  resolveChatTextScaleIndexForVersion,
  resolveRespondentDesignForVersion,
  resolveRespondentLayoutForVersion,
  resolveReasoningDwellForVersion,
  resolveReasoningPlacementForVersion,
  resolveShowProgressPercentTextForVersion,
  resolveVoiceEnabledForVersion,
} from '@/lib/app/questionnaire/chat/anonymity';
import { RespondentChrome } from '@/components/app/questionnaire/chrome/respondent-chrome';

export const metadata: Metadata = {
  // ABSOLUTE, so the `(respondent)` layout's " - ConQuest" template does not apply. A run can be a
  // white-labelled journey, and this page honours that for everything the respondent sees on it —
  // a tab reading "Your conversation - ConQuest" would leak the one place the page cannot repaint.
  //
  // Unconditional rather than chrome-aware, unlike `/q`: resolving chrome here means resolving the
  // RUN first, and `resolveRunSurface` is a cookie-credential check plus a query that is not
  // memoised — so a chrome-aware title would run the whole credential path twice on every load of
  // the respondent hot path. "Your conversation" is a truthful title under all three modes, and the
  // two branded modes still show our name on the page itself, which is where branding belongs.
  title: { absolute: 'Your conversation' },
  description: 'Continue your conversation.',
  // A journey address must never be indexed: the ref is short and the page is respondent-private.
  robots: { index: false, follow: false },
};

/** Cookie-name prefix for run credentials; see `run-access-token.ts`. */
const RUN_COOKIE_PREFIX = 'cq_run_';

/**
 * The experience run surface — ONE address for a whole journey (P15.3).
 *
 * `/x/<publicRef>` resolves server-side to whichever leg the run is currently on, so a `stitched`
 * journey genuinely keeps one address across its legs rather than hopping between session URLs.
 * That is what lets the stitched continuation refresh in place instead of navigating.
 *
 * The ref addresses; the httpOnly run cookie (or an authenticated respondent's ownership of the
 * leg) authorises. See `run-surface.ts` for why the credential is deliberately NOT in the URL.
 */
export default async function ExperienceRunPage({
  params,
}: {
  params: Promise<{ publicRef: string }>;
}) {
  const { publicRef } = await params;

  const jar = await cookies();
  const runCookies = jar
    .getAll()
    .filter((c) => c.name.startsWith(RUN_COOKIE_PREFIX))
    .map((c) => c.value);

  const surface = await resolveRunSurface(publicRef, runCookies);

  if (!surface.ok) {
    // A dead address 404s outright — no page, no confirmation that the ref might be real.
    if (surface.reason === 'not_found') notFound();

    // A real run this browser cannot prove it owns. Overwhelmingly a genuine respondent on another
    // device or after clearing cookies, so this explains rather than accuses — and it says plainly
    // that their answers are safe, which is the thing they will actually be worried about.
    return (
      // No version resolved, so there is no questionnaire to ask what chrome it wanted: `full` is
      // the honest default. `shell={false}` because this card sets its own narrow width — the
      // reading measure belongs to a conversation, and there is not one here.
      <RespondentChrome mode="full" shell={false} className="flex items-center overflow-y-auto">
        <div className="bg-card mx-auto w-full max-w-md rounded-xl border p-6 text-center">
          <p className="font-medium">We can&apos;t open this conversation here</p>
          <p className="text-muted-foreground mt-2 text-sm">
            For your privacy, a conversation can only be reopened in the browser it was started in —
            the link on its own is never enough to unlock it.
          </p>
          <p className="text-muted-foreground mt-2 text-sm">
            Nothing has been lost. Everything you said is saved. Try the device you started on, or
            get in touch and quote <span className="font-mono">{publicRef}</span>.
          </p>
        </div>
      </RespondentChrome>
    );
  }

  const { versionId, sessionId, sessionToken } = surface;

  // Independent per-version reads, resolved in parallel rather than serialised. Each leg may run a
  // DIFFERENT questionnaire, so these are read for the CURRENT leg's version on every load — the
  // theme, voice affordance and presentation mode can all legitimately change at a handoff.
  const [
    theme,
    bandHeader,
    anonymous,
    presentationMode,
    respondentLayout,
    respondentDesign,
    chatTextScaleIndex,
    respondentChrome,
    answerPanelScope,
    voiceInputEnabled,
    attachmentInputEnabled,
    reasoningPlacement,
    reasoningDwell,
    inlineCorrectionEnabled,
    glossary,
    glossaryAppendix,
    showProgressPercentText,
  ] = await Promise.all([
    resolveThemeForVersion(versionId),
    resolveVersionHeader(versionId),
    resolveAnonymousForVersion(versionId),
    resolvePresentationModeForVersion(versionId),
    resolveRespondentLayoutForVersion(versionId),
    resolveRespondentDesignForVersion(versionId),
    resolveChatTextScaleIndexForVersion(versionId),
    resolveRespondentChromeForVersion(versionId),
    resolveAnswerPanelScopeForVersion(versionId),
    resolveVoiceEnabledForVersion(versionId),
    resolveAttachmentsEnabledForVersion(versionId),
    resolveReasoningPlacementForVersion(versionId),
    resolveReasoningDwellForVersion(versionId),
    resolveInlineCorrectionForVersion(versionId),
    resolveGlossaryForHints(versionId),
    resolveGlossaryAppendixForVersion(versionId),
    resolveShowProgressPercentTextForVersion(versionId),
  ]);

  // `px-4` matches the chrome's own container padding, so the conversation's left and right edges
  // line up with whatever chrome is above it rather than sitting inside it. The height comes from
  // the chrome too — this page used to guess `100vh-8rem`, one rem off the guess `/q` was making
  // about the same header and footer.
  return (
    // The client's ground travels to the shell as well as to the surface: the theme-switch
    // row and the gutters either side of the column sit OUTSIDE the surface root and cannot
    // inherit its brand — see `canvasBackdropVars`.
    <RespondentChrome mode={respondentChrome} canvasStyle={canvasBackdropVars(theme)}>
      <div className="h-full min-h-0 px-4">
        <BrandThemeProvider
          theme={theme}
          header={bandHeader}
          anonymous={anonymous}
          design={respondentDesign}
        >
          <RunSessionBoot
            sessionId={sessionId}
            glossary={glossary}
            glossaryAppendix={glossaryAppendix}
            accessToken={sessionToken ?? undefined}
            welcomeCopy={theme.welcomeCopy}
            voiceInputEnabled={voiceInputEnabled}
            attachmentInputEnabled={attachmentInputEnabled}
            anonymous={anonymous}
            presentationMode={presentationMode}
            respondentLayout={respondentLayout}
            chatTextScaleIndex={chatTextScaleIndex}
            answerPanelScope={answerPanelScope}
            reasoningPlacement={reasoningPlacement}
            reasoningDwellMs={reasoningDwell.dwellMs}
            reasoningPerItemMs={reasoningDwell.perItemMs}
            inlineCorrectionEnabled={inlineCorrectionEnabled}
            showProgressPercentText={showProgressPercentText}
          />
        </BrandThemeProvider>
      </div>
    </RespondentChrome>
  );
}
