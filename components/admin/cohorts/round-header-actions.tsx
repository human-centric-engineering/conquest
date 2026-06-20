'use client';

/**
 * The round detail header's action cluster: edit (name / description / window via the
 * `<RoundForm>` in a dialog), Close (when `open`, behind a confirm), and Reopen (when
 * `closed`, PATCH `{ status: 'open' }`). A `draft` round can be opened the same way.
 *
 * Closing is the dedicated POST …/close (it stamps closedAt); status PATCH only moves
 * between draft ⇄ open per the domain `updateRoundSchema`.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, Play, XCircle } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { RoundForm } from '@/components/admin/cohorts/round-form';
import type { RoundDetail } from '@/lib/app/questionnaire/rounds';

export interface RoundHeaderActionsProps {
  demoClientId: string;
  round: RoundDetail;
}

export function RoundHeaderActions({ demoClientId, round }: RoundHeaderActionsProps) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setStatus = async (status: 'draft' | 'open') => {
    setIsLoading(true);
    setError(null);
    try {
      await apiClient.patch<RoundDetail>(API.APP.ROUNDS.byId(round.id), { body: { status } });
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not update the round status.');
    } finally {
      setIsLoading(false);
    }
  };

  const closeRound = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await apiClient.post<RoundDetail>(API.APP.ROUNDS.close(round.id));
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not close the round.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              <Pencil className="mr-2 h-4 w-4" />
              Edit
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit round</DialogTitle>
              <DialogDescription>
                Adjust the name, internal note, and the open/close window.
              </DialogDescription>
            </DialogHeader>
            <RoundForm
              demoClientId={demoClientId}
              round={round}
              onSuccess={() => setEditOpen(false)}
              onCancel={() => setEditOpen(false)}
            />
          </DialogContent>
        </Dialog>

        {round.status === 'draft' && (
          <Button size="sm" disabled={isLoading} onClick={() => void setStatus('open')}>
            {isLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Open round
          </Button>
        )}

        {round.status === 'open' && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="mr-2 h-4 w-4" />
                )}
                Close round
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Close “{round.name}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  Closing ends the round — respondents can no longer start or continue it. You can
                  reopen it afterwards.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void closeRound()}>Close round</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {round.status === 'closed' && (
          <Button size="sm" disabled={isLoading} onClick={() => void setStatus('open')}>
            {isLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Reopen round
          </Button>
        )}
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
