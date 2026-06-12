'use client';

/**
 * DEMO-ONLY (F6.4): "Reset sessions" — the between-demos clean slate.
 *
 * Surfaces the existing `POST …/demo-clients/:id/reset-sessions` endpoint, which
 * hard-deletes the session graph (sessions, answers, turns, events) for every
 * version of every questionnaire attributed to this client. Destructive, so it is
 * gated behind a typed-slug confirmation (the input must equal the client slug,
 * mirroring the server's 400 guard) and surfaces the server's 409 anonymous-mode
 * refusal inline. On success it shows the deleted counts and refreshes.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCcw } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

interface ResetDeletedCounts {
  sessions: number;
  answerSlots: number;
  turns: number;
  events: number;
  invitations: number;
}

interface ResetResponse {
  id: string;
  deletedCounts: ResetDeletedCounts;
  resetInvitations: boolean;
}

export interface ResetSessionsDialogProps {
  id: string;
  name: string;
  slug: string;
}

export function ResetSessionsDialog({ id, name, slug }: ResetSessionsDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState('');
  const [resetInvitations, setResetInvitations] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResetResponse | null>(null);

  const matches = confirmSlug.trim() === slug;

  const reset = () => {
    setConfirmSlug('');
    setResetInvitations(false);
    setError(null);
    setResult(null);
    setIsResetting(false);
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // Refresh on close so freshly-cleared counts (sessions, analytics) re-read.
      if (result) router.refresh();
      reset();
    }
  };

  const handleReset = async () => {
    if (!matches) return;
    setIsResetting(true);
    setError(null);
    try {
      const path = resetInvitations
        ? `${API.APP.DEMO_CLIENTS.resetSessions(id)}?resetInvitations=true`
        : API.APP.DEMO_CLIENTS.resetSessions(id);
      const data = await apiClient.post<ResetResponse>(path, { body: { confirmSlug } });
      setResult(data);
    } catch (err) {
      if (err instanceof APIClientError && err.code === 'ANONYMOUS_MODE_PROTECTED') {
        setError(
          'A questionnaire for this client uses anonymous mode — its research data is protected, so sessions can’t be reset.'
        );
      } else if (err instanceof APIClientError && err.code === 'CONFIRM_SLUG_MISMATCH') {
        setError('The confirmation didn’t match the client slug.');
      } else {
        setError(err instanceof APIClientError ? err.message : 'Could not reset sessions.');
      }
      setIsResetting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="text-destructive">
          <RotateCcw className="mr-2 h-4 w-4" />
          Reset sessions
        </Button>
      </DialogTrigger>
      <DialogContent>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>Sessions reset</DialogTitle>
              <DialogDescription>
                Cleared the session data for “{name}”. The next demo starts fresh.
              </DialogDescription>
            </DialogHeader>
            <ul className="text-muted-foreground space-y-1 text-sm">
              <li>{result.deletedCounts.sessions} sessions</li>
              <li>{result.deletedCounts.answerSlots} answers</li>
              <li>{result.deletedCounts.turns} turns</li>
              <li>{result.deletedCounts.events} events</li>
              {result.resetInvitations && <li>{result.deletedCounts.invitations} invitations</li>}
            </ul>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Reset sessions for “{name}”?</DialogTitle>
              <DialogDescription>
                This permanently deletes every respondent session, answer, turn, and event for all
                questionnaires attributed to this client — the between-demos clean slate. It cannot
                be undone.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="reset-confirm-slug">
                  Type the client slug{' '}
                  <code className="bg-muted rounded px-1 py-0.5 text-xs">{slug}</code> to confirm
                </Label>
                <Input
                  id="reset-confirm-slug"
                  value={confirmSlug}
                  onChange={(e) => setConfirmSlug(e.target.value)}
                  placeholder={slug}
                  autoComplete="off"
                  aria-invalid={confirmSlug.length > 0 && !matches}
                />
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="reset-invitations"
                  checked={resetInvitations}
                  onCheckedChange={(checked) => setResetInvitations(checked === true)}
                />
                <Label htmlFor="reset-invitations" className="text-sm font-normal">
                  Also clear stale invitations (keeps started, completed, and revoked)
                </Label>
              </div>

              {error && <p className="text-destructive text-sm">{error}</p>}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isResetting}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleReset()}
                disabled={!matches || isResetting}
              >
                {isResetting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Reset sessions
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
