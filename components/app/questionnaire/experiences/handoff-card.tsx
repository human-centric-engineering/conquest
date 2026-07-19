'use client';

/**
 * The handoff card — what a respondent sees after finishing a leg of an experience.
 *
 * Polls the run-status endpoint until the fork resolves, then offers either the next questionnaire
 * or the end of the journey. The wait is real (the selector is an LLM call), so the card is
 * explicit about what is happening rather than showing a bare spinner: someone who has just spent
 * ten minutes answering questions deserves to know the pause is deliberate.
 *
 * Three behaviours worth keeping:
 *
 *  - **Polling stops.** After {@link RUN_POLL_TIMEOUT_MS} it gives up and tells the respondent
 *    their answers are safe, rather than spinning forever against a handoff that failed.
 *  - **It backs off when hidden.** A backgrounded tab stops polling, so a phone left on a desk is
 *    not quietly generating requests for an hour.
 *  - **Continuing is the respondent's choice.** The card never auto-navigates. Being moved into a
 *    second questionnaire without agreeing to it is exactly the experience `linked` mode exists to
 *    avoid.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, FileText, Loader2 } from 'lucide-react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import {
  RUN_POLL_INTERVAL_MS,
  RUN_POLL_TIMEOUT_MS,
} from '@/lib/app/questionnaire/experiences/constants';
import type { RunPollState } from '@/lib/app/questionnaire/experiences/run/types';

export interface HandoffCardProps {
  runId: string;
  /** The leg just completed — so a newly-minted later leg is recognised as the fork resolving. */
  sessionId: string;
  /** Signed token for the no-login surface; omitted on the authenticated one. */
  sessionToken?: string;
  /** Where to send the respondent when the journey ends. */
  reportHref: string;
  /** Builds the URL for the next leg's session. */
  legHref: (sessionId: string) => string;
}

export function HandoffCard({
  runId,
  sessionId,
  sessionToken,
  reportHref,
  legHref,
}: HandoffCardProps) {
  const router = useRouter();
  const [state, setState] = useState<RunPollState>({ state: 'pending' });
  // Stamped in the effect, not at render: reading the clock during render is impure (it would
  // differ between a server render and its hydration, and between Strict Mode's double render).
  const startedAt = useRef(0);
  const stopped = useRef(false);

  const poll = useCallback(async (): Promise<boolean> => {
    try {
      const next = await apiClient.get<RunPollState>(
        API.APP.EXPERIENCES.runStatus(runId, sessionId),
        sessionToken ? { options: { headers: { 'X-Session-Token': sessionToken } } } : undefined
      );
      setState(next);
      return next.state !== 'pending';
    } catch {
      // A transient failure mid-poll is not a failed handoff — keep waiting and let the timeout
      // be the thing that gives up.
      return false;
    }
  }, [runId, sessionId, sessionToken]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    startedAt.current = Date.now();
    stopped.current = false;

    const tick = async () => {
      if (stopped.current) return;

      // A backgrounded tab defers rather than polls — re-checked on the next tick, and the
      // visibilitychange listener below wakes it immediately when the respondent returns.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(() => void tick(), RUN_POLL_INTERVAL_MS);
        return;
      }

      if (Date.now() - startedAt.current > RUN_POLL_TIMEOUT_MS) {
        stopped.current = true;
        setState({
          state: 'failed',
          message:
            "This is taking longer than expected. Your answers are saved — you can close this and we'll be in touch.",
        });
        return;
      }

      const done = await poll();
      if (done) {
        stopped.current = true;
        return;
      }
      timer = setTimeout(() => void tick(), RUN_POLL_INTERVAL_MS);
    };

    void tick();

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !stopped.current) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped.current = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll]);

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
        <Button onClick={() => router.push(reportHref)}>
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
      <Button onClick={() => router.push(legHref(state.sessionId))}>
        Continue
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
    </div>
  );
}
