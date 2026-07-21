'use client';

/**
 * SessionResumeGate — the "welcome back" chooser shown when a no-login respondent returns to a
 * questionnaire they already started on this device (session resume).
 *
 * The public surface remembers an in-progress session in `localStorage`. On a genuine return (a new
 * tab, or after the browser was closed — NOT a same-tab refresh, which resumes silently) the boot
 * confirms the session is still resumable and shows this gate instead of silently minting a fresh
 * one: it quotes the session's support reference and offers Continue (pick up where they left off)
 * or Start new (abandon the old session and begin again). A secondary control resumes a DIFFERENT
 * session by its code (the cross-device case).
 *
 * Inherits the client's brand via the page's `BrandThemeProvider` CSS vars, mirroring
 * {@link QuestionnaireSplash} / {@link ProfileCaptureGate}.
 *
 * @see components/app/questionnaire/chat/anonymous-session-boot.tsx
 */

import { useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { formatSessionRef } from '@/lib/app/questionnaire/session-ref';
import { ResumeByRefForm } from '@/components/app/questionnaire/chat/resume-by-ref-form';

const ACCENT = 'var(--app-accent-color, var(--color-primary))';
const CTA_FILL =
  'var(--app-cta-gradient, var(--app-cta-color, var(--cq-accent, var(--color-primary))))';

export interface SessionResumeGateProps {
  versionId: string;
  /** The raw `publicRef` of the in-progress session (displayed grouped). */
  refRaw: string | null;
  /** Distinct questions already answered — drives the reassuring "your progress is saved" line. */
  answeredCount: number;
  /** Continue the existing session (replay + carry on). */
  onContinue: () => void;
  /** Abandon the existing session and begin a fresh one. */
  onStartNew: () => void;
  /** An action (continue / start-new) is in flight. */
  busy: boolean;
}

export function SessionResumeGate({
  versionId,
  refRaw,
  answeredCount,
  onContinue,
  onStartNew,
  busy,
}: SessionResumeGateProps) {
  const [showRefForm, setShowRefForm] = useState(false);

  const progress =
    answeredCount > 0
      ? `You've answered ${answeredCount} ${answeredCount === 1 ? 'question' : 'questions'} so far — your progress is saved.`
      : 'Your progress is saved.';

  return (
    <div className="flex h-full min-h-0 items-center justify-center p-4">
      <div className="bg-card w-full max-w-md rounded-2xl border p-8 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_50px_-22px_rgba(0,0,0,0.2)]">
        <div
          className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl"
          style={{
            color: ACCENT,
            backgroundColor:
              'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 12%, transparent)',
          }}
        >
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
          <Button
            type="button"
            onClick={onContinue}
            disabled={busy}
            style={{ background: CTA_FILL }}
            className="h-11 w-full text-base text-[var(--app-on-cta,#fff)]"
          >
            {busy ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            ) : (
              'Continue where you left off'
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onStartNew}
            disabled={busy}
            className="h-11 w-full text-base"
          >
            Start a new questionnaire
          </Button>
        </div>

        <div className="mt-6 border-t pt-4">
          {showRefForm ? (
            <div className="flex flex-col gap-2">
              <ResumeByRefForm
                versionId={versionId}
                label="Continue a session you started on another device — enter its reference code:"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowRefForm(true)}
              className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
            >
              Started on another device?
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
