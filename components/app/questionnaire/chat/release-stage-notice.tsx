/**
 * Pre-release transparency notice for the respondent chat surface.
 *
 * While ConQuest is in `alpha`/`beta` (see {@link RELEASE_STAGE}), respondents
 * are told up-front that their conversation is being recorded for analysis and
 * tuning. Persistent (not dismissible) and pinned above the transcript so it
 * stays visible as the conversation scrolls — it's a transparency notice, not a
 * transient banner. Renders nothing once the product is `stable`, so it drops
 * out cleanly when the stage env var is cleared.
 *
 * Mirrors the calm side-band notice treatment used elsewhere in the chat
 * ({@link SupportNotice}, {@link SeriousnessNotice}).
 */

import { Info } from 'lucide-react';

import { cn } from '@/lib/utils';
import { IS_PRERELEASE, RELEASE_STAGE } from '@/lib/app/release-stage';

export function ReleaseStageNotice({ className }: { className?: string }) {
  if (!IS_PRERELEASE) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex gap-2.5 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-500/10',
        className
      )}
    >
      <Info
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <p className="text-muted-foreground text-xs leading-relaxed">
        While ConQuest is in {RELEASE_STAGE} your chats are being recorded for analysis and tuning
        purposes for our team.
      </p>
    </div>
  );
}
