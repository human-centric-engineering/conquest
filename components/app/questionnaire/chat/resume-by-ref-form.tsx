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
 * Deliberately understated and self-contained: it POSTs a public endpoint, so it needs no session
 * context and can sit on the public page footer AND inside the welcome-back gate. Every non-match
 * collapses to one friendly message (the endpoint never says which guard failed).
 *
 * @see app/api/v1/app/questionnaire-sessions/resume-by-ref/route.ts
 */

import { useState } from 'react';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';

import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  /** Optional label above the input (the page footer sets its own context). */
  label?: string;
  className?: string;
}

export function ResumeByRefForm({ versionId, label, className }: ResumeByRefFormProps) {
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = ref.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(API.APP.QUESTIONNAIRE_SESSIONS.RESUME_BY_REF, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: trimmed }),
      });
      if (res.status === 429) {
        setError('Too many attempts. Please wait a moment and try again.');
        return;
      }
      const parsed = resumeResponseSchema.safeParse(await res.json());
      if (!res.ok || !parsed.success) {
        setError("We couldn't find an in-progress session for that code. Check it and try again.");
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
      if (resolvedVersionId === versionId) window.location.reload();
      else window.location.assign(`/q/${resolvedVersionId}`);
    } catch {
      setError('Something went wrong. Please check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className={cn('flex flex-col gap-2', className)}>
      {label && (
        <label htmlFor={`resume-ref-${versionId}`} className="text-muted-foreground text-sm">
          {label}
        </label>
      )}
      <div className="flex items-center gap-2">
        <Input
          id={`resume-ref-${versionId}`}
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="e.g. 7F3K-9M2P"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          aria-label="Session reference code"
          className="max-w-[12rem] font-mono tracking-wide uppercase"
        />
        <Button
          type="submit"
          size="sm"
          disabled={busy || ref.trim().length === 0}
          style={{ background: CTA_FILL }}
          className="text-white"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : 'Continue'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </form>
  );
}
