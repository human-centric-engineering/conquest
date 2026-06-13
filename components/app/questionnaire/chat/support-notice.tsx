/**
 * Side-band support signpost for sensitivity awareness / safeguarding (mirrors
 * {@link SeriousnessNotice}).
 *
 * When a serious disclosure is detected for the first time, the orchestrator surfaces a `warning`
 * with `code: 'support'` carrying the version's verbatim support message (with an optional resource
 * URL appended). This renders it as a calm, supportive callout — a lifebuoy icon and a soft teal
 * accent, deliberately gentler than the cautionary seriousness notice. The copy is author-written
 * and never paraphrased by the agent. A fork that strips sensitivity awareness drops this component.
 */

import { LifeBuoy } from 'lucide-react';

import { cn } from '@/lib/utils';

interface SupportNoticeProps {
  message: string;
  className?: string;
}

/** Split a trailing `http(s)://…` token off the message so it can render as a real link. */
function splitTrailingUrl(message: string): { text: string; url: string | null } {
  const match = message.match(/\s(https?:\/\/\S+)\s*$/);
  if (!match) return { text: message.trim(), url: null };
  return { text: message.slice(0, match.index).trim(), url: match[1] };
}

export function SupportNotice({ message, className }: SupportNoticeProps) {
  const { text, url } = splitTrailingUrl(message);
  return (
    <div
      role="status"
      className={cn(
        'flex gap-2.5 rounded-lg border border-teal-300/60 bg-teal-50/60 px-3 py-2.5 text-sm leading-relaxed dark:border-teal-500/30 dark:bg-teal-500/10',
        className
      )}
    >
      <LifeBuoy
        className="mt-0.5 h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-foreground text-xs font-medium">Support is available</p>
        <p className="text-muted-foreground mt-0.5">
          {text}
          {url && (
            <>
              {' '}
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal-700 underline underline-offset-2 dark:text-teal-300"
              >
                {url}
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
