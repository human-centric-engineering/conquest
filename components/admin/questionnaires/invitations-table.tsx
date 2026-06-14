'use client';

/**
 * InvitationsTable (F3.2) — the admin list of a questionnaire's invitations with
 * per-row resend + revoke actions. Read-only data comes from the server page (the
 * GET list endpoint); the actions `fetch` the admin routes and `router.refresh()`
 * on success so the list re-renders from the source of truth (no client cache).
 *
 * Resend / revoke availability is decided by the same pure lifecycle helpers the
 * API enforces — the buttons can't offer an action the server would 409.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Link2, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { InvitationStatusBadge } from '@/components/admin/questionnaires/invitation-status-badge';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import {
  isInvitationResendable,
  isInvitationTransitionAllowed,
  type InvitationView,
} from '@/lib/app/questionnaire/invitations';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export interface InvitationsTableProps {
  questionnaireId: string;
  invitations: InvitationView[];
}

/** The roster stage tally shown above the table (derived from invitation statuses). */
function stageCounts(invitations: InvitationView[]) {
  let invited = 0;
  let started = 0;
  let completed = 0;
  for (const inv of invitations) {
    if (inv.status === 'revoked') continue;
    invited += 1;
    if (inv.status === 'started') started += 1;
    if (inv.status === 'completed') completed += 1;
  }
  return { invited, started, completed };
}

export function InvitationsTable({ questionnaireId, invitations }: InvitationsTableProps) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function copyLink(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(API.APP.QUESTIONNAIRES.invitationLink(questionnaireId, id), {
        method: 'POST',
        credentials: 'same-origin',
      });
      const parsed = await parseApiResponse<{ url: string }>(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      await navigator.clipboard.writeText(parsed.data.url);
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 2500);
      // Token rotated server-side — refresh so any stale expiry shows correctly.
      router.refresh();
    } catch {
      setError('Could not generate a link. Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  async function resend(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(API.APP.QUESTIONNAIRES.invitationResend(questionnaireId, id), {
        method: 'POST',
        credentials: 'same-origin',
      });
      const parsed = await parseApiResponse(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      router.refresh();
    } catch {
      setError('Resend failed. Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(API.APP.QUESTIONNAIRES.invitationById(questionnaireId, id), {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke' }),
      });
      const parsed = await parseApiResponse(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      router.refresh();
    } catch {
      setError('Revoke failed. Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  if (invitations.length === 0) {
    return (
      <p className="text-muted-foreground text-sm italic">
        No invitations yet. Invite respondents above.
      </p>
    );
  }

  const tally = stageCounts(invitations);

  return (
    <div className="space-y-3">
      {error && <p className="text-destructive text-sm">{error}</p>}
      {/* Roster funnel: who was invited → started → completed (across this questionnaire's versions). */}
      <div className="text-muted-foreground flex flex-wrap gap-4 text-sm">
        <span>
          <span className="text-foreground font-semibold tabular-nums">{tally.invited}</span>{' '}
          invited
        </span>
        <span aria-hidden>→</span>
        <span>
          <span className="text-foreground font-semibold tabular-nums">{tally.started}</span>{' '}
          started
        </span>
        <span aria-hidden>→</span>
        <span>
          <span className="text-foreground font-semibold tabular-nums">{tally.completed}</span>{' '}
          completed
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Recipient</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Sent</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invitations.map((inv) => {
            const busy = busyId === inv.id;
            const canResend = isInvitationResendable(inv.status);
            const canRevoke = isInvitationTransitionAllowed(inv.status, 'revoked');
            return (
              <TableRow key={inv.id}>
                <TableCell>
                  <div className="font-medium">{inv.email}</div>
                  {inv.name && <div className="text-muted-foreground text-xs">{inv.name}</div>}
                </TableCell>
                <TableCell>
                  <InvitationStatusBadge status={inv.status} />
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  v{inv.versionNumber}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDate(inv.sentAt)}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDate(inv.expiresAt)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    {inv.status !== 'revoked' && inv.status !== 'completed' && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        title="Generate a no-login link to share manually (rotates the token — the previous link stops working)"
                        onClick={() => void copyLink(inv.id)}
                      >
                        {copiedId === inv.id ? (
                          <Check className="mr-1.5 h-3 w-3 text-emerald-600" />
                        ) : (
                          <Link2 className="mr-1.5 h-3 w-3" />
                        )}
                        {copiedId === inv.id ? 'Copied' : 'Copy link'}
                      </Button>
                    )}
                    {canResend && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void resend(inv.id)}
                      >
                        {busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                        Resend
                      </Button>
                    )}
                    {canRevoke && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm" disabled={busy}>
                            Revoke
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Revoke this invitation?</AlertDialogTitle>
                            <AlertDialogDescription>
                              The link emailed to <strong>{inv.email}</strong> will stop working.
                              You can invite them again afterwards.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void revoke(inv.id)}>
                              Revoke
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
