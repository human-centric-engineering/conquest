import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  isAttachmentInputEnabled,
  isLiveSessionsEnabled,
  isVoiceInputEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { AnonymousSessionBoot } from '@/components/app/questionnaire/chat/anonymous-session-boot';
import { BrandThemeProvider } from '@/components/app/questionnaire/chat/brand-theme-provider';
import { resolveThemeForVersion } from '@/lib/app/questionnaire/chat/theme';
import {
  resolveAnonymousForVersion,
  resolveAttachmentsEnabledForVersion,
  resolvePresentationModeForVersion,
  resolveVoiceEnabledForVersion,
} from '@/lib/app/questionnaire/chat/anonymity';
import { resolveAdminPreviewMeta } from '@/lib/app/questionnaire/chat/preview-nav';

export const metadata: Metadata = {
  title: 'Questionnaire',
  description: 'Complete a short conversational questionnaire — no account needed.',
};

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
  searchParams: Promise<{ preview?: string }>;
}) {
  if (!(await isLiveSessionsEnabled())) notFound();

  const { versionId } = await params;
  // Admin "Preview as respondent" (`?preview=1`): boot via the admin-gated `/preview` route,
  // which works on any launched version (anonymous or invitation-gated) and marks the run
  // `isPreview`. The route enforces admin auth — a non-admin who forges the param just gets
  // the boot's "couldn't start" error, no leak.
  const preview = (await searchParams).preview === '1';
  // Independent reads — resolve in parallel rather than serialising the DB round-trips. The
  // exit-href lookup runs only in preview mode (a real respondent never needs it). Voice and
  // attachments each need BOTH the platform flag (capability dark-launch) AND the version's
  // per-questionnaire opt-in, so the affordance shows only when the author turned it on.
  const [
    voicePlatform,
    attachmentPlatform,
    theme,
    anonymous,
    presentationMode,
    voiceConfigured,
    attachmentsConfigured,
    previewMeta,
  ] = await Promise.all([
    isVoiceInputEnabled(),
    isAttachmentInputEnabled(),
    resolveThemeForVersion(versionId),
    resolveAnonymousForVersion(versionId),
    resolvePresentationModeForVersion(versionId),
    resolveVoiceEnabledForVersion(versionId),
    resolveAttachmentsEnabledForVersion(versionId),
    preview ? resolveAdminPreviewMeta(versionId) : Promise.resolve(null),
  ]);
  const voiceInputEnabled = voicePlatform && voiceConfigured;
  const attachmentInputEnabled = attachmentPlatform && attachmentsConfigured;

  return (
    <div className="container mx-auto flex h-[calc(100dvh-9rem)] max-w-6xl flex-col px-4 py-6">
      {/* Admin preview chrome — a slim strip above the brand surface (it's admin meta, not the
          respondent experience), persisting across every session state so the admin always has a
          way back. Kept deliberately low-profile so it barely costs vertical space. */}
      {preview && previewMeta && (
        <div className="text-muted-foreground mb-2 flex shrink-0 items-center gap-2 px-1 text-[11px]">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--cq-accent)]" />
          <span className="text-foreground font-medium">
            Preview · v{previewMeta.versionNumber} ({previewMeta.status})
          </span>
          <span className="truncate">· not recorded in analytics</span>
          <Link
            href={previewMeta.exitHref}
            className="hover:text-foreground ml-auto shrink-0 underline underline-offset-2"
          >
            Exit
          </Link>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <BrandThemeProvider theme={theme}>
          <AnonymousSessionBoot
            versionId={versionId}
            preview={preview}
            voiceInputEnabled={voiceInputEnabled}
            attachmentInputEnabled={attachmentInputEnabled}
            anonymous={anonymous}
            presentationMode={presentationMode}
            welcomeCopy={theme.welcomeCopy}
          />
        </BrandThemeProvider>
      </div>
    </div>
  );
}
