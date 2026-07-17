import type { Metadata } from 'next';
import { Fraunces } from 'next/font/google';
import Link from 'next/link';

import { AnonymousSessionBoot } from '@/components/app/questionnaire/chat/anonymous-session-boot';
import { BrandThemeProvider } from '@/components/app/questionnaire/chat/brand-theme-provider';
import { ConquestWordmark } from '@/components/app/questionnaire/conquest-wordmark';
import { resolveThemeForVersion } from '@/lib/app/questionnaire/chat/theme';
import { resolveVersionHeader } from '@/lib/app/questionnaire/header/resolve';
import {
  resolveAnonymousForVersion,
  resolveAttachmentsEnabledForVersion,
  resolveInlineCorrectionForVersion,
  resolvePresentationModeForVersion,
  resolveReasoningPlacementForVersion,
  resolveReasoningDwellForVersion,
  resolveSessionResumeEnabledForVersion,
  resolveVoiceEnabledForVersion,
} from '@/lib/app/questionnaire/chat/anonymity';
import { ResumeByRefEntry } from '@/components/app/questionnaire/chat/resume-by-ref-entry';
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
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ versionId: string }>;
}): Promise<Metadata> {
  const description = 'Complete a short conversational questionnaire — no account needed.';
  const { versionId } = await params;
  const header = await resolveVersionHeader(versionId);
  return { title: header?.title ?? 'Questionnaire', description };
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
    voiceConfigured,
    attachmentsConfigured,
    reasoningPlacementConfigured,
    reasoningDwell,
    inlineCorrectionEnabled,
    previewMeta,
    resumeEnabled,
  ] = await Promise.all([
    resolveThemeForVersion(versionId),
    resolveVersionHeader(versionId),
    resolveAnonymousForVersion(versionId),
    resolvePresentationModeForVersion(versionId),
    resolveVoiceEnabledForVersion(versionId),
    resolveAttachmentsEnabledForVersion(versionId),
    resolveReasoningPlacementForVersion(versionId),
    resolveReasoningDwellForVersion(versionId),
    resolveInlineCorrectionForVersion(versionId),
    preview ? resolveAdminPreviewMeta(versionId) : Promise.resolve(null),
    resolveSessionResumeEnabledForVersion(versionId),
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
    <div
      className={`${display.variable} container mx-auto flex h-[calc(100dvh-9rem)] max-w-6xl flex-col px-4 py-6`}
    >
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
        <BrandThemeProvider theme={theme} header={bandHeader}>
          <AnonymousSessionBoot
            versionId={versionId}
            preview={preview}
            inviteToken={inviteToken}
            voiceInputEnabled={voiceInputEnabled}
            attachmentInputEnabled={attachmentInputEnabled}
            anonymous={anonymous}
            presentationMode={presentationMode}
            reasoningPlacement={reasoningPlacement}
            reasoningDwellMs={reasoningDwell.dwellMs}
            reasoningPerItemMs={reasoningDwell.perItemMs}
            inlineCorrectionEnabled={inlineCorrectionEnabled}
            welcomeCopy={theme.welcomeCopy}
            resumeEnabled={resumeEnabled}
          />
          {showResumeByRef && (
            <div className="mt-3 flex shrink-0 justify-center">
              <ResumeByRefEntry versionId={versionId} />
            </div>
          )}
        </BrandThemeProvider>
      </div>
    </div>
  );
}
