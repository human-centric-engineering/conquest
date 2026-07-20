import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';

import { BrandThemeProvider } from '@/components/app/questionnaire/chat/brand-theme-provider';
import { RunSessionBoot } from '@/components/app/questionnaire/experiences/run-session-boot';
import { resolveRunSurface } from '@/app/api/v1/app/experiences/_lib/run-surface';
import { resolveThemeForVersion } from '@/lib/app/questionnaire/chat/theme';
import { resolveVersionHeader } from '@/lib/app/questionnaire/header/resolve';
import {
  resolveAnonymousForVersion,
  resolveAttachmentsEnabledForVersion,
  resolveInlineCorrectionForVersion,
  resolvePresentationModeForVersion,
  resolveReasoningDwellForVersion,
  resolveReasoningPlacementForVersion,
  resolveVoiceEnabledForVersion,
} from '@/lib/app/questionnaire/chat/anonymity';

export const metadata: Metadata = {
  title: 'Your conversation',
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
      <main className="mx-auto flex min-h-[60vh] max-w-md items-center px-4">
        <div className="bg-card w-full rounded-xl border p-6 text-center">
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
      </main>
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
    voiceInputEnabled,
    attachmentInputEnabled,
    reasoningPlacement,
    reasoningDwell,
    inlineCorrectionEnabled,
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
  ]);

  return (
    <div className="mx-auto h-[calc(100vh-8rem)] max-w-6xl">
      <BrandThemeProvider theme={theme} header={bandHeader}>
        <RunSessionBoot
          sessionId={sessionId}
          accessToken={sessionToken ?? undefined}
          welcomeCopy={theme.welcomeCopy}
          voiceInputEnabled={voiceInputEnabled}
          attachmentInputEnabled={attachmentInputEnabled}
          anonymous={anonymous}
          presentationMode={presentationMode}
          reasoningPlacement={reasoningPlacement}
          reasoningDwellMs={reasoningDwell.dwellMs}
          reasoningPerItemMs={reasoningDwell.perItemMs}
          inlineCorrectionEnabled={inlineCorrectionEnabled}
        />
      </BrandThemeProvider>
    </div>
  );
}
