'use client';

/**
 * The cohort detail header's actions: edit (name / description via `<CohortForm>` in a
 * dialog) and delete (behind a confirm; DELETE removes the cohort and its rounds).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, Trash2 } from 'lucide-react';

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
import { CohortForm } from '@/components/admin/cohorts/cohort-form';
import { cohortsTabHref, type CohortDetail } from '@/lib/app/questionnaire/rounds';

export interface CohortHeaderActionsProps {
  demoClientId: string;
  cohort: CohortDetail;
  /** Platform intro-screen sub-flag — threaded to the edit form's intro override. */
  introScreenEnabled?: boolean;
}

export function CohortHeaderActions({
  demoClientId,
  cohort,
  introScreenEnabled = false,
}: CohortHeaderActionsProps) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deleteCohort = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      await apiClient.delete(API.APP.COHORTS.byId(cohort.id));
      router.push(cohortsTabHref(demoClientId));
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not delete the cohort.');
      setIsDeleting(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              <Pencil className="mr-2 h-4 w-4" />
              Edit
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit cohort</DialogTitle>
              <DialogDescription>Update the cohort name and internal note.</DialogDescription>
            </DialogHeader>
            <CohortForm
              demoClientId={demoClientId}
              cohort={cohort}
              introScreenEnabled={introScreenEnabled}
              onSuccess={() => setEditOpen(false)}
              onCancel={() => setEditOpen(false)}
            />
          </DialogContent>
        </Dialog>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={isDeleting}
            >
              {isDeleting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{cohort.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes the cohort and its rounds. Members&rsquo; existing sessions
                are unaffected. This can&rsquo;t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void deleteCohort()}>
                Delete cohort
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
