import type { Metadata } from 'next';
import { Fraunces } from 'next/font/google';
import Link from 'next/link';

import { AnonymousSessionBoot } from '@/components/app/questionnaire/chat/anonymous-session-boot';
import {
  resolveGlossaryAppendixForVersion,
  resolveGlossaryForHints,
} from '@/lib/app/questionnaire/glossary/resolve';
import { BrandThemeProvider } from '@/components/app/questionnaire/chat/brand-theme-provider';
import { ConquestWordmark } from '@/components/app/questionnaire/conquest-wordmark';
import { resolveThemeForVersion } from '@/lib/app/questionnaire/chat/theme';
import { canvasBackdropVars, themeToCssVariables } from '@/lib/app/questionnaire/theming';
import { resolveVersionHeader } from '@/lib/app/questionnaire/header/resolve';
import {
  resolveAnonymousForVersion,
  resolveAnswerPanelScopeForVersion,
  resolveAttachmentsEnabledForVersion,
  resolveChatTextScaleIndexForVersion,
  resolveInlineCorrectionForVersion,
  resolvePresentationModeForVersion,
  resolveReasoningDwellForVersion,
  resolveReasoningPlacementForVersion,
  resolveRespondentChromeForVersion,
  resolveRespondentDesignForVersion,
  resolveRespondentLayoutForVersion,
  resolveSectionedForVersion,
  resolveSessionResumeEnabledForVersion,
  resolveShowProgressPercentTextForVersion,
  resolveVoiceEnabledForVersion,
} from '@/lib/app/questionnaire/chat/anonymity';
import { ResumeByRefEntry } from '@/components/app/questionnaire/chat/resume-by-ref-entry';
import { RespondentChrome } from '@/components/app/questionnaire/chrome/respondent-chrome';
import { resolveAdminPreviewMeta } from '@/lib/app/questionnaire/chat/preview-nav';

// Display serif for the ConQuest wordmark, shown only in the admin "Preview as
// respondent" header. Exposed as a CSS variable so it mirrors the admin surface
// (and marketing Pricing / About-ConQuest pages) without touching the body font.
const display = Fraunces({
  subsets: ['latin'],
  variable: '--font-display-cq',
  display: 'swap',
});

/**
 * Title the tab (and any browser-derived print/save filename) after the actual questionnaire, not a
 * generic "Questionnaire". Gated by the same live-sessions flag as the page so a dark-launched
 * surface never leaks a title; falls back to the generic title otherwise.
 *
 * Also the one place chrome reaches metadata: a `white_label` questionnaire drops the layout's
 * " - ConQuest" title template, because a tab is part of what a respondent sees.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ versionId: string }>;
}): Promise<Metadata> {
  const description = 'Complete a short conversational questionnaire — no account needed.';
  const { versionId } = await params;
  const [header, chrome] = await Promise.all([
    resolveVersionHeader(versionId),
    resolveRespondentChromeForVersion(versionId),
  ]);
  const title = header?.title ?? 'Questionnaire';
  // A white-labelled questionnaire is one a client is presenting as their own, and the layout's
  // title template would otherwise append " - ConQuest" to the one string the respondent's browser
  // shows in the tab, the history and any saved-page filename. `absolute` opts out of the template.
  // The other two modes keep it: they are already showing our name on the page itself.
  return chrome === 'white_label'
    ? { title: { absolute: title }, description }
    : { title, description };
}

/**
 * No-login respondent chat surface (F7.1).
 *
 * Deliberately public (outside the `(protected)` group): a true no-account surface. The flag
 * gate runs first and 404s when off, so a dark-launched surface — and the very existence of
 * anonymous mode — never leaks. Session creation happens client-side in
 * {@link AnonymousSessionBoot} so the signed access token never touches server-rendered HTML.
 */
export default async function PublicQuestionnairePage({
  params,
  searchParams,
}: {
  params: Promise<{ versionId: string }>;
  searchParams: Promise<{ preview?: string; i?: string }>;
}) {
  const { versionId } = await params;
  // Admin "Preview as respondent" (`?preview=1`): boot via the admin-gated `/preview` route,
  // which works on any launched version (anonymous or invitation-gated) and marks the run
  // `isPreview`. The route enforces admin auth — a non-admin who forges the param just gets
  // the boot's "couldn't start" error, no leak.
  const sp = await searchParams;
  const preview = sp.preview === '1';
  // Frictionless invite link: `?i=<token>` boots a no-login session bound to that invitation
  // (the boot POSTs `/from-invite`). Ignored in preview mode (admins use the preview boot).
  const inviteToken = !preview && typeof sp.i === 'string' && sp.i.length > 0 ? sp.i : undefined;
  // Independent reads — resolve in parallel rather than serialising the DB round-trips. The
  // exit-href lookup runs only in preview mode (a real respondent never needs it). Voice and
  // attachments each need BOTH the platform flag (capability dark-launch) AND the version's
  // per-questionnaire opt-in, so the affordance shows only when the author turned it on.
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
    voiceConfigured,
    attachmentsConfigured,
    reasoningPlacementConfigured,
    reasoningDwell,
    inlineCorrectionEnabled,
    previewMeta,
    resumeEnabled,
    glossary,
    glossaryAppendix,
    showProgressPercentText,
    sectioned,
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
    preview ? resolveAdminPreviewMeta(versionId) : Promise.resolve(null),
    resolveSessionResumeEnabledForVersion(versionId),
    resolveGlossaryForHints(versionId),
    resolveGlossaryAppendixForVersion(versionId),
    resolveShowProgressPercentTextForVersion(versionId),
    // P21: resolved here so the tab strip is present from the first paint, and so an
    // unsectioned questionnaire never calls the strip endpoint at all.
    resolveSectionedForVersion(versionId),
  ]);
  // The cross-device "continue with your code" footer is for the public anonymous path only — admin
  // preview and frictionless-invite links resume by other means, so it would only confuse there.
  const showResumeByRef = resumeEnabled && !preview && !inviteToken;
  const voiceInputEnabled = voiceConfigured;
  const attachmentInputEnabled = attachmentsConfigured;
  // Live "watch it think" reasoning (demo feature): the effective placement, or null when the
  // version turned it off.
  const reasoningPlacement = reasoningPlacementConfigured;

  return (
    // The chrome owns the viewport height and the shared reading width; this page contributes only
    // its display font and the padding that lines the conversation up with the chrome's own
    // container. Before, it carried `h-[calc(100dvh-9rem)]` — a guess at the height of a header and
    // footer it could not see, and simply wrong the moment either becomes a setting.
    // The client's ground travels to the shell as well as to the surface: the theme-switch
    // row and the gutters either side of the column sit OUTSIDE the surface root and cannot
    // inherit its brand — see `canvasBackdropVars`.
    <RespondentChrome mode={respondentChrome} canvasStyle={canvasBackdropVars(theme)}>
      <div className={`${display.variable} flex h-full min-h-0 flex-col px-4 py-6`}>
        {/* Admin "Preview as respondent" chrome — the ConQuest signature (mirroring the admin
          surface) plus a slim meta strip above the brand surface. It's admin meta, not the
          respondent experience, so it shows only in preview: a real respondent sees just the
          questionnaire's own (white-labelled) brand. The Exit link persists across every session
          state so the admin always has a way back. */}
        {preview && (
          <header className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1">
            <ConquestWordmark size="page" showSubtitle />
            {previewMeta && (
              <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--cq-accent)]" />
                <span className="text-foreground font-medium">
                  Preview · v{previewMeta.versionNumber} ({previewMeta.status})
                </span>
                <span className="truncate">· not recorded in analytics</span>
                <Link
                  href={previewMeta.exitHref}
                  className="hover:text-foreground shrink-0 underline underline-offset-2"
                >
                  Exit
                </Link>
              </div>
            )}
          </header>
        )}
        <div className="min-h-0 flex-1">
          <BrandThemeProvider
            theme={theme}
            header={bandHeader}
            anonymous={anonymous}
            design={respondentDesign}
          >
            <AnonymousSessionBoot
              glossary={glossary}
              glossaryAppendix={glossaryAppendix}
              versionId={versionId}
              preview={preview}
              inviteToken={inviteToken}
              voiceInputEnabled={voiceInputEnabled}
              attachmentInputEnabled={attachmentInputEnabled}
              anonymous={anonymous}
              presentationMode={presentationMode}
              respondentLayout={respondentLayout}
              chatTextScaleIndex={chatTextScaleIndex}
              answerPanelScope={answerPanelScope}
              sectioned={sectioned}
              reasoningPlacement={reasoningPlacement}
              reasoningDwellMs={reasoningDwell.dwellMs}
              reasoningPerItemMs={reasoningDwell.perItemMs}
              inlineCorrectionEnabled={inlineCorrectionEnabled}
              showProgressPercentText={showProgressPercentText}
              welcomeCopy={theme.welcomeCopy}
              resumeEnabled={resumeEnabled}
              // Handed down as a NODE rather than a flag: it needs the resolved theme (the dialog
              // portals to `document.body`, outside this provider's wrapper, so it would otherwise
              // open platform-coloured on a white-labelled questionnaire), and the workspace — not
              // the page — knows which existing row can carry it without costing a line of its own.
              resumeByRef={
                showResumeByRef ? (
                  <ResumeByRefEntry versionId={versionId} brandStyle={themeToCssVariables(theme)} />
                ) : undefined
              }
            />
          </BrandThemeProvider>
        </div>
      </div>
    </RespondentChrome>
  );
}
