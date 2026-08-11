/**
 * Side-band completeness-milestone notice (mirrors {@link SupportNotice} / seriousness/contradiction
 * notices in this directory).
 *
 * When the respondent crosses one of the version's configured completeness thresholds, the
 * orchestrator surfaces a `warning` with `code: 'milestone'` carrying a quiet "you're N% through"
 * message (see `lib/app/questionnaire/orchestrator/orchestrator.ts`). Renders as a calm, celebratory
 * inline banner using the brand accent colour — the same `--app-accent-color` the CTA and progress
 * bar use — so it reads as part of the questionnaire's own identity rather than a system alert,
 * unlike the amber/teal safety notices it sits alongside. Admin-configurable via
 * `config.milestoneBannerEnabled` + `config.milestoneBannerThresholds` (Settings → Progress
 * milestones); on by default.
 */

import { Flag } from 'lucide-react';

import { cn } from '@/lib/utils';

interface MilestoneNoticeProps {
  message: string;
  className?: string;
}

export function MilestoneNotice({ message, className }: MilestoneNoticeProps) {
  return (
    <div
      role="status"
      className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-sm', className)}
      style={{
        borderColor:
          'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 30%, transparent)',
        backgroundColor:
          'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 8%, transparent)',
      }}
    >
      <Flag
        className="h-4 w-4 shrink-0"
        style={{ color: 'var(--app-accent-color, var(--color-primary))' }}
        aria-hidden="true"
      />
      <p className="text-foreground font-medium">{message}</p>
    </div>
  );
}
