'use client';

/**
 * ChatErrorPanel — renders the respondent chat surface's blocking / error states (F7.1).
 *
 * Three terminal states get a distinct, calm panel (cost cap reached, session no longer
 * active, anonymous token expired); transient errors (network, rate-limit, defensive
 * stream error) render as a dismissible inline banner with a "Try again" action that
 * resends the failed attempt (the message stays in the transcript — no retyping).
 */

import { AlertTriangle, CheckCircle2, Clock, RefreshCw, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { ChatErrorState, QuestionnaireChatStatus } from '@/lib/app/questionnaire/chat/types';

interface ChatErrorPanelProps {
  status: QuestionnaireChatStatus;
  error: ChatErrorState;
  /** Shown only for transient (`error`) states. */
  onDismiss?: () => void;
  /**
   * Resend the failed attempt — renders a "Try again" button on the transient banner. Provided only
   * for transient (`error`) states; terminal states never retry (a re-send would just re-fail).
   */
  onRetry?: () => void;
  className?: string;
}

const TERMINAL_ICON: Record<string, typeof CheckCircle2> = {
  cost_capped: CheckCircle2,
  not_active: Clock,
  expired: RefreshCw,
};

export function ChatErrorPanel({
  status,
  error,
  onDismiss,
  onRetry,
  className,
}: ChatErrorPanelProps) {
  const isTerminal = status === 'cost_capped' || status === 'not_active' || status === 'expired';

  if (isTerminal) {
    const Icon = TERMINAL_ICON[status] ?? CheckCircle2;
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'bg-muted/40 mx-auto flex max-w-md flex-col items-center gap-3 rounded-2xl border px-6 py-8 text-center',
          className
        )}
      >
        <span
          className="flex h-11 w-11 items-center justify-center rounded-full"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 14%, transparent)',
            color: 'var(--app-accent-color, var(--color-primary))',
          }}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="space-y-1">
          <p className="text-foreground text-base font-semibold text-balance">{error.title}</p>
          <p className="text-muted-foreground text-sm text-balance">{error.message}</p>
        </div>
        {status === 'expired' && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
            className="mt-1"
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Reload
          </Button>
        )}
      </div>
    );
  }

  // Transient error — dismissible inline banner.
  return (
    <div
      role="alert"
      className={cn(
        'border-destructive/30 bg-destructive/5 text-foreground flex items-start gap-3 rounded-lg border px-4 py-3 text-sm',
        className
      )}
    >
      <AlertTriangle className="text-destructive mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{error.title}</p>
        <p className="text-muted-foreground">{error.message}</p>
        {onRetry && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry} className="mt-2">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </Button>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
