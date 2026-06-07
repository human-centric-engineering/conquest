import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  isAttachmentInputEnabled,
  isLiveSessionsEnabled,
  isVoiceInputEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { AnonymousSessionBoot } from '@/components/app/questionnaire/chat/anonymous-session-boot';
import { BrandThemeProvider } from '@/components/app/questionnaire/chat/brand-theme-provider';
import { resolveThemeForVersion } from '@/lib/app/questionnaire/chat/theme';

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
}: {
  params: Promise<{ versionId: string }>;
}) {
  if (!(await isLiveSessionsEnabled())) notFound();

  const { versionId } = await params;
  // Independent reads — resolve in parallel rather than serialising two DB round-trips.
  const [voiceInputEnabled, attachmentInputEnabled, theme] = await Promise.all([
    isVoiceInputEnabled(),
    isAttachmentInputEnabled(),
    resolveThemeForVersion(versionId),
  ]);

  return (
    <div className="container mx-auto h-[calc(100dvh-9rem)] max-w-6xl px-4 py-6">
      <BrandThemeProvider theme={theme}>
        <AnonymousSessionBoot
          versionId={versionId}
          voiceInputEnabled={voiceInputEnabled}
          attachmentInputEnabled={attachmentInputEnabled}
          welcomeCopy={theme.welcomeCopy}
        />
      </BrandThemeProvider>
    </div>
  );
}
