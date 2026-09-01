'use client';

/**
 * Sectioned interviews (P21) — "finish this section and move on".
 *
 * The respondent's parallel right to the interviewer's offer, and the same shape as
 * `EarlyFinishControl`: a persistent control that unlocks the moment the deterministic gate says
 * the section is covered.
 *
 * It renders in three states, and the third is the one that matters. A section holding an unanswered
 * REQUIRED question can never satisfy its bars, so a respondent under sequential navigation would
 * otherwise sit in front of a control that will never unlock, with nothing telling them why. The
 * blocked state names it.
 */

import { ArrowRight, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SectionStripView } from '@/lib/app/questionnaire/sections/view';

export interface SectionCloseControlProps {
  view: SectionStripView;
  onClose: () => void;
  /** False while a turn is in flight. */
  canClose: boolean;
  busy?: boolean;
  className?: string;
}

export function SectionCloseControl({
  view,
  onClose,
  canClose,
  busy = false,
  className,
}: SectionCloseControlProps) {
  // Nothing to finish: not sectioned, or every section already closed (at which point the whole
  // session's completion offer is the affordance that matters, not this one).
  if (!view.active || view.allClosed || !view.activeKey) return null;

  const activePosition = view.sections.find((tab) => tab.isActive)?.position ?? 0;
  const next = view.sections.find((tab) => tab.position === activePosition + 1);

  if (!view.canClose) {
    // Silent unless something is actually stuck. A running "not yet" would nag every turn of every
    // section, which is noise; a required question the respondent cannot see is a dead end.
    if (!view.blockedOnRequired) return null;
    return (
      <p className={cn('text-muted-foreground text-xs', className)}>
        There is still one thing needed in this section before you can move on.
      </p>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClose}
      disabled={!canClose || busy}
      className={cn('gap-1.5', className)}
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <ArrowRight className="size-3.5" aria-hidden />
      )}
      {next ? `Move on to ${next.label}` : 'Finish this section'}
    </Button>
  );
}
