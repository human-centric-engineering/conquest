/**
 * Side-band notice for the seriousness / abuse gate (mirrors {@link ContradictionNotice}).
 *
 * When an answer is judged non-genuine but the session isn't yet abandoned, the orchestrator
 * surfaces a `warning` with `code: 'seriousness'`; this renders it above the agent's re-asked
 * question — politely telling the respondent the answer was set aside, with escalating firmness
 * carried in the message text. Uses a cautionary tone (a shield icon, a warm amber accent) so it
 * reads as a gentle nudge, distinct from the brand-accented "I noticed something" contradiction
 * notice. A fork that strips the gate drops this component.
 */

import { ShieldAlert } from 'lucide-react';

import { cn } from '@/lib/utils';

interface SeriousnessNoticeProps {
  message: string;
  className?: string;
}

export function SeriousnessNotice({ message, className }: SeriousnessNoticeProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex gap-2.5 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2.5 text-sm leading-relaxed dark:border-amber-500/30 dark:bg-amber-500/10',
        className
      )}
    >
      <ShieldAlert
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-foreground text-xs font-medium">Let&apos;s keep it genuine</p>
        <p className="text-muted-foreground mt-0.5">{message}</p>
      </div>
    </div>
  );
}
