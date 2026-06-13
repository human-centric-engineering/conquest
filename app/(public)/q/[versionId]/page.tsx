import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  isAttachmentInputEnabled,
  isLiveSessionsEnabled,
  isVoiceInputEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { Button } from '@/components/ui/button';
import { AnonymousSessionBoot } from '@/components/app/questionnaire/chat/anonymous-session-boot';
import { BrandThemeProvider } from '@/components/app/questionnaire/chat/brand-theme-provider';
import { resolveThemeForVersion } from '@/lib/app/questionnaire/chat/theme';
import { resolveAnonymousForVersion } from '@/lib/app/questionnaire/chat/anonymity';
import { resolveAdminPreviewExitHref } from '@/lib/app/questionnaire/chat/preview-nav';

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
  // exit-href lookup runs only in preview mode (a real respondent never needs it).
  const [voiceInputEnabled, attachmentInputEnabled, theme, anonymous, exitHref] = await Promise.all(
    [
      isVoiceInputEnabled(),
      isAttachmentInputEnabled(),
      resolveThemeForVersion(versionId),
      resolveAnonymousForVersion(versionId),
      preview ? resolveAdminPreviewExitHref(versionId) : Promise.resolve(null),
    ]
  );

  return (
    <div className="container mx-auto flex h-[calc(100dvh-9rem)] max-w-6xl flex-col px-4 py-6">
      {/* Admin preview chrome — sits above the brand surface (it's admin meta, not the
          respondent experience) and persists across every session state, including the
          completion screen, so the admin always has a way back. */}
      {preview && exitHref && (
        <div className="bg-muted/40 mb-3 flex shrink-0 items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-2">
          <p className="text-muted-foreground text-xs">
            <span className="text-foreground font-medium">Preview mode</span> — viewing as a
            respondent. This run isn&apos;t recorded in analytics.
          </p>
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link href={exitHref}>Exit preview</Link>
          </Button>
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
            welcomeCopy={theme.welcomeCopy}
          />
        </BrandThemeProvider>
      </div>
    </div>
  );
}
