'use client';

/**
 * ResumeByRefForm — cross-device "continue with your reference code" entry (session resume).
 *
 * A no-login respondent who started on another device (or after their client-held token expired)
 * types their support reference (`publicRef`, e.g. `7F3K-9M2P`) to continue. On a match the public
 * `/resume-by-ref` route re-mints a fresh session token; we persist it as this device's durable
 * anonymous credential, mark the tab entered (so the reload drops straight back into the
 * conversation rather than re-prompting), and reload — the boot then replays the transcript.
 *
 * The code is entered in a {@link SessionRefInput} — eight cells in the code's own 4+4 shape — and
 * submits ITSELF on the eighth character: someone copying a code off another screen looks at that
 * screen, not at this one, so making them find a button afterwards is the step that gets missed.
 * The button stays for keyboard/retry, and the panel holds a "found it" beat before the reload so
 * the screen going blank reads as success rather than a fault.
 *
 * Deliberately self-contained: it POSTs a public endpoint, so it needs no session context and can
 * sit on the public page footer AND inside the welcome-back gate. Every non-match collapses to one
 * friendly message (the endpoint never says which guard failed).
 *
 * @see app/api/v1/app/questionnaire-sessions/resume-by-ref/route.ts
 */

import { useId, useRef, useState } from 'react';
import { z } from 'zod';
import { Check, Loader2 } from 'lucide-react';

import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SessionRefInput } from '@/components/app/questionnaire/chat/session-ref-input';
import { SESSION_REF_LENGTH } from '@/lib/app/questionnaire/session-ref';
import {
  anonCredsKey,
  setTabMarker,
  writeAnonSession,
} from '@/lib/app/questionnaire/chat/anon-session-storage';

const CTA_FILL =
  'var(--app-cta-gradient, var(--app-cta-color, var(--cq-accent, var(--color-primary))))';

/** Success payload shape — validated at the fetch boundary (no `as` on the wire). */
const resumeResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    session: z.object({ id: z.string(), versionId: z.string() }),
    accessToken: z.string(),
    expiresAt: z.string(),
  }),
});

export interface ResumeByRefFormProps {
  versionId: string;
  /** Optional line of copy above the field (each host sets its own context). */
  label?: string;
  /** Focus the field on mount — for hosts that exist (or open) only to take this code. */
  focusOnMount?: boolean;
  className?: string;
}

export function ResumeByRefForm({
  versionId,
  label,
  focusOnMount = false,
  className,
}: ResumeByRefFormProps) {
  const errorId = useId();
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drives the one-shot nudge on the cells. Cleared on `animationend` rather than by a timer, so a
  // second failure re-adds the class and the animation replays — a bumped key would work too, but
  // remounting the field would steal focus from the code the respondent is about to correct.
  const [shaking, setShaking] = useState(false);
  const inFlight = useRef(false);

  function fail(message: string) {
    setError(message);
    setShaking(true);
  }

  async function submit(code: string) {
    const trimmed = code.trim();
    // `inFlight` (not `busy`) guards the double-fire: auto-submit and a button press can land in the
    // same tick, before a state update has been committed.
    if (trimmed.length !== SESSION_REF_LENGTH || inFlight.current || done) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.RESUME_BY_REF, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: trimmed }),
      });
      if (res.status === 429) {
        fail('Too many attempts. Please wait a moment and try again.');
        return;
      }
      const parsed = resumeResponseSchema.safeParse(await res.json());
      if (!res.ok || !parsed.success) {
        fail("We couldn't find an in-progress session for that code. Check it and try again.");
        return;
      }
      // Persist under the RESOLVED session's version, not this page's — `publicRef` is globally
      // unique, so a respondent could enter a code for a session belonging to a DIFFERENT
      // questionnaire. Keying on the resolved version keeps the credential findable on the right
      // page and avoids loading another version's session inside this one's chrome. Drop straight
      // back into the conversation (the tab marker suppresses the welcome-back re-prompt — they just
      // asked to continue): reload if it's this page's version, else navigate to the right one.
      const resolvedVersionId = parsed.data.data.session.versionId;
      writeAnonSession(anonCredsKey(resolvedVersionId, false), true, {
        sessionId: parsed.data.data.session.id,
        accessToken: parsed.data.data.accessToken,
        expiresAt: parsed.data.data.expiresAt,
      });
      setTabMarker(resolvedVersionId);
      // Latch the success state BEFORE navigating: the reload is not instant, and a panel that
      // simply freezes mid-spinner reads as a hang.
      setDone(true);
      if (resolvedVersionId === versionId) window.location.reload();
      else window.location.assign(`/q/${resolvedVersionId}`);
    } catch {
      fail('Something went wrong. Please check your connection and try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div
        role="status"
        className={cn(
          'text-muted-foreground flex flex-col items-center gap-2 py-2 text-sm',
          className
        )}
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-500">
          <Check className="h-5 w-5" aria-hidden="true" />
        </span>
        Found it — bringing your conversation across…
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit(ref);
      }}
      className={cn('flex flex-col items-center gap-4', className)}
    >
      {label && <p className="text-muted-foreground text-center text-sm">{label}</p>}

      <div onAnimationEnd={() => setShaking(false)} className={cn(shaking && 'cq-shake')}>
        <SessionRefInput
          value={ref}
          onChange={(next) => {
            setRef(next);
            if (error) setError(null);
          }}
          onComplete={(code) => void submit(code)}
          disabled={busy}
          invalid={Boolean(error)}
          focusOnMount={focusOnMount}
          describedBy={error ? errorId : undefined}
        />
      </div>

      <Button
        type="submit"
        disabled={busy || ref.length !== SESSION_REF_LENGTH}
        style={{ background: CTA_FILL }}
        className="h-11 w-full max-w-[20rem] text-base text-[var(--app-on-cta,#fff)]"
      >
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Looking it up…
          </>
        ) : (
          'Continue'
        )}
      </Button>

      {error && (
        <p id={errorId} role="alert" className="text-destructive text-center text-xs">
          {error}
        </p>
      )}
    </form>
  );
}
