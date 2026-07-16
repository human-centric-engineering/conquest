'use client';

/**
 * AuthedResumeChooser — the "Continue where you left off / Start new" screen for the authenticated
 * respondent start flow (session resume).
 *
 * The authenticated `/questionnaires/start` page already resumes a respondent's in-progress session
 * silently. When resume is enabled and such a session exists WITH real progress, this chooser gives
 * the respondent the choice the silent path never offered: pick it back up, or abandon it and begin
 * again. Continue navigates straight to the existing session; Start new runs the
 * {@link startFreshAuthedSession} server action (abandon old + mint fresh + redirect).
 */

import { useTransition } from 'react';
import Link from 'next/link';
import { Loader2, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { formatSessionRef } from '@/lib/app/questionnaire/session-ref';
import { startFreshAuthedSession } from '@/app/(protected)/questionnaires/start/actions';

export interface AuthedResumeChooserProps {
  versionId: string;
  sessionId: string;
  refRaw: string | null;
  answeredCount: number;
}

export function AuthedResumeChooser({
  versionId,
  sessionId,
  refRaw,
  answeredCount,
}: AuthedResumeChooserProps) {
  const [pending, startTransition] = useTransition();

  const progress =
    answeredCount > 0
      ? `You've answered ${answeredCount} ${answeredCount === 1 ? 'question' : 'questions'} so far — your progress is saved.`
      : 'Your progress is saved.';

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 py-16">
      <div className="bg-card w-full rounded-2xl border p-8 shadow-sm">
        <div className="bg-primary/10 text-primary mb-5 flex h-11 w-11 items-center justify-center rounded-2xl">
          <RotateCcw className="h-5 w-5" aria-hidden="true" />
        </div>

        <h1 className="text-foreground text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          You have a questionnaire in progress. {progress}
        </p>

        {refRaw && (
          <p className="text-muted-foreground mt-3 font-mono text-xs tracking-wide">
            <span className="opacity-70">Ref:</span>{' '}
            <span className="text-foreground font-semibold">{formatSessionRef(refRaw)}</span>
          </p>
        )}

        <div className="mt-7 flex flex-col gap-3">
          <Button asChild disabled={pending} className="h-11 w-full text-base">
            <Link href={`/questionnaires/${sessionId}`}>Continue where you left off</Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() =>
              startTransition(() => {
                void startFreshAuthedSession(versionId, sessionId);
              })
            }
            className="h-11 w-full text-base"
          >
            {pending ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            ) : (
              'Start a new questionnaire'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
