'use client';

/**
 * DEMO-ONLY (F2.5.1): delete action for a demo client.
 *
 * The server refuses (409 `DEMO_CLIENT_IN_USE`) while any questionnaire is still
 * attributed. The UI mirrors that: the button is disabled with an explanation when
 * the attributed count is non-zero, and a confirm dialog guards the destructive
 * action when it's zero. The 409 is still handled defensively (a race could attach
 * a questionnaire between render and click).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Trash2 } from 'lucide-react';

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

export interface DemoClientActionsProps {
  id: string;
  name: string;
  questionnaireCount: number;
}

export function DemoClientActions({ id, name, questionnaireCount }: DemoClientActionsProps) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inUse = questionnaireCount > 0;

  const handleDelete = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      await apiClient.delete(API.APP.DEMO_CLIENTS.byId(id));
      router.push('/admin/demo-clients');
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not delete the demo client.');
      setIsDeleting(false);
    }
  };

  if (inUse) {
    return (
      <div className="space-y-1">
        <Button variant="outline" disabled className="text-destructive">
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </Button>
        <p className="text-muted-foreground max-w-[15rem] text-right text-xs">
          Detach or reassign the {questionnaireCount} attributed{' '}
          {questionnaireCount === 1 ? 'questionnaire' : 'questionnaires'} listed below before
          deleting.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="outline" className="text-destructive" disabled={isDeleting}>
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
            <AlertDialogTitle>Delete “{name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the demo client. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()} disabled={isDeleting}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
