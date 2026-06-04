'use client';

/**
 * InviteForm (F3.2) — invite one or many respondents. The admin pastes one or more
 * email addresses (newline / comma / space separated); a one-address paste is the
 * "single" case. Posts the batch to the collection endpoint and renders the
 * per-recipient result (sent / skipped / failed), then `router.refresh()`es so the
 * table below reflects the new rows.
 *
 * When the questionnaire has no launched version the form is disabled with a note —
 * the server would 409 (`INVITE_NO_LAUNCHED_VERSION`), so we don't offer it.
 */

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import {
  MAX_INVITE_RECIPIENTS,
  type InvitationSendResult,
} from '@/lib/app/questionnaire/invitations';

/** Split a paste into candidate emails on commas / whitespace / newlines. */
function parseEmails(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0)
    )
  );
}

export interface InviteFormProps {
  questionnaireId: string;
  /** False when the questionnaire has no launched version — invites are disabled. */
  hasLaunchedVersion: boolean;
}

export function InviteForm({ questionnaireId, hasLaunchedVersion }: InviteFormProps) {
  const router = useRouter();
  const emailsId = useId();

  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<InvitationSendResult[] | null>(null);

  const emails = parseEmails(raw);
  const tooMany = emails.length > MAX_INVITE_RECIPIENTS;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (emails.length === 0) {
      setError('Enter at least one email address.');
      return;
    }
    if (tooMany) {
      setError(`At most ${MAX_INVITE_RECIPIENTS} recipients per send.`);
      return;
    }

    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch(API.APP.QUESTIONNAIRES.invitations(questionnaireId), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: emails.map((email) => ({ email })) }),
      });
      const parsed = await parseApiResponse<{ results: InvitationSendResult[] }>(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      setResults(parsed.data.results);
      setRaw('');
      router.refresh();
    } catch {
      setError('Could not send invitations. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!hasLaunchedVersion) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm">
        <p className="text-muted-foreground">
          Launch a version of this questionnaire before inviting respondents.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3 rounded-md border p-4">
      <div className="space-y-1.5">
        <Label htmlFor={emailsId}>
          Invite respondents{' '}
          <FieldHelp title="Invite respondents">
            Paste one or more email addresses, separated by commas, spaces, or new lines. Each gets
            a unique tokenised link to register and complete the questionnaire. Up to{' '}
            {MAX_INVITE_RECIPIENTS} per send. An address that already has a live invitation is
            skipped.
          </FieldHelp>
        </Label>
        <Textarea
          id={emailsId}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          disabled={busy}
          rows={3}
          placeholder="alice@example.com, bob@example.com"
        />
        <p className="text-muted-foreground text-xs">
          {emails.length} recipient{emails.length === 1 ? '' : 's'}
          {tooMany && (
            <span className="text-destructive"> · over the {MAX_INVITE_RECIPIENTS} limit</span>
          )}
        </p>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {results && (
        <ul className="space-y-1 text-sm">
          {results.map((r) => (
            <li key={r.email} className="flex items-center gap-2">
              <span className="font-medium">{r.email}</span>
              <span
                className={
                  r.outcome === 'sent'
                    ? 'text-green-600'
                    : r.outcome === 'skipped'
                      ? 'text-muted-foreground'
                      : 'text-destructive'
                }
              >
                {r.outcome}
              </span>
              {r.reason && <span className="text-muted-foreground text-xs">— {r.reason}</span>}
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={busy || emails.length === 0 || tooMany}>
          {busy ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Send className="mr-1.5 h-4 w-4" />
          )}
          Send {emails.length > 1 ? `${emails.length} invitations` : 'invitation'}
        </Button>
      </div>
    </form>
  );
}
