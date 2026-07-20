'use client';

/**
 * The handoff card — what a respondent sees after finishing a leg under `linked` continuity.
 *
 * Waits on {@link useRunHandoff} until the fork resolves, then offers either the next questionnaire
 * or the end of the journey. The wait is real (the selector is an LLM call), so the card is
 * explicit about what is happening rather than showing a bare spinner: someone who has just spent
 * ten minutes answering questions deserves to know the pause is deliberate.
 *
 * **Continuing is the respondent's choice.** The card never auto-navigates. Being moved into a
 * second questionnaire without agreeing to it is exactly the experience `linked` mode exists to
 * avoid — and it is precisely the difference between this and `StitchedContinuation`, which does
 * continue on its own because the author chose one continuous conversation.
 */

import { ArrowRight, FileText, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useRunHandoff } from '@/lib/hooks/use-run-handoff';

export interface HandoffCardProps {
  runId: string;
  /** The leg just completed — so a newly-minted later leg is recognised as the fork resolving. */
  sessionId: string;
  /** Signed token for the no-login surface; omitted on the authenticated one. */
  sessionToken?: string;
  /**
   * Move the respondent into the next leg.
   *
   * A callback rather than an href because the two surfaces continue in fundamentally different
   * ways: the authenticated one NAVIGATES to the new session's URL, while `/x/<publicRef>` is
   * already the right address and must REFRESH in place. Pushing the URL you are on is a no-op,
   * so an href-shaped API would silently do nothing on the stable-address surface.
   */
  onContinue: (sessionId: string, sessionToken?: string) => void;
  /** Show the respondent their summary — the journey is over. */
  onConclude: () => void;
}

export function HandoffCard({
  runId,
  sessionId,
  sessionToken,
  onContinue,
  onConclude,
}: HandoffCardProps) {
  const state = useRunHandoff({ runId, sessionId, sessionToken });

  if (state.state === 'pending') {
    return (
      <div className="bg-card rounded-xl border p-6 text-center">
        <Loader2 className="text-muted-foreground mx-auto h-5 w-5 animate-spin" />
        <p className="mt-3 font-medium">Thanks — one moment</p>
        <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">
          We&apos;re reading back through what you said to work out what would be most useful next.
        </p>
      </div>
    );
  }

  if (state.state === 'failed') {
    return (
      <div className="bg-card rounded-xl border p-6 text-center">
        <p className="font-medium">Thanks — you&apos;re all done</p>
        <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">{state.message}</p>
      </div>
    );
  }

  if (state.state === 'conclude') {
    return (
      <div className="bg-card rounded-xl border p-6 text-center">
        <p className="font-medium">That&apos;s everything</p>
        <p className="text-muted-foreground mx-auto mt-1 mb-4 max-w-sm text-sm">{state.message}</p>
        <Button onClick={onConclude}>
          <FileText className="mr-2 h-4 w-4" />
          See your summary
        </Button>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl border p-6 text-center">
      <p className="font-medium">{state.stepTitle}</p>
      <p className="text-muted-foreground mx-auto mt-1 mb-4 max-w-sm text-sm">{state.message}</p>
      <Button onClick={() => onContinue(state.sessionId, state.sessionToken)}>
        Continue
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
    </div>
  );
}
