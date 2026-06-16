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

import { Fragment } from 'react';
import { ShieldAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import { NoticeWhy } from '@/components/app/questionnaire/chat/notice-why';

interface SeriousnessNoticeProps {
  message: string;
  /** The judge's reason — surfaced behind a "Why?" disclosure. */
  detail?: string;
  className?: string;
}

/**
 * Render a system-authored notice string with minimal `**bold**` support — the only markup the
 * gate's copy uses (e.g. the bold last-chance warning on the penultimate strike). Splitting on `**`
 * yields alternating plain / bold segments; odd indices are the emphasised runs. Safe because the
 * text is authored in `seriousness-logic.ts`, never respondent input.
 */
function renderWithBold(text: string) {
  return text.split('**').map((segment, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="text-foreground font-semibold">
        {segment}
      </strong>
    ) : (
      <Fragment key={i}>{segment}</Fragment>
    )
  );
}

export function SeriousnessNotice({ message, detail, className }: SeriousnessNoticeProps) {
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
        <p className="text-muted-foreground mt-0.5">{renderWithBold(message)}</p>
        <NoticeWhy detail={detail} />
      </div>
    </div>
  );
}
