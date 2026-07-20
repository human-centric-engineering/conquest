'use client';

/**
 * The journey editor — add, edit, reorder and remove an experience's steps.
 *
 * Reorder is up/down buttons rather than drag-and-drop: the list is short by nature (a journey
 * with twenty steps is a design problem, not a UI one), and buttons are keyboard-accessible for
 * free. Each move sends the COMPLETE ordered id list, which is what lets the server reject a
 * stale page rather than silently applying an order derived from a set that has since changed.
 *
 * Optimistic on reorder only. Create, edit and delete round-trip before updating, because each can
 * fail in a way the author must see (a key collision, a step someone else deleted).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Route, Trash2 } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ExperienceEmptyState, StepKindBadge } from '@/components/admin/experiences/experience-ui';
import { ExperienceStepForm } from '@/components/admin/experiences/experience-step-form';
import { BreakoutRoomsEditor } from '@/components/admin/experiences/breakout-rooms-editor';
import type { ExperienceStepView } from '@/lib/app/questionnaire/experiences/views';
import type { ExperienceKind } from '@/lib/app/questionnaire/experiences/types';

/** The questionnaire options a step can point at — resolved once by the page, not per row. */
export interface QuestionnaireOption {
  id: string;
  title: string;
  status: string;
}

export interface ExperienceStepsPanelProps {
  experienceId: string;
  experienceKind: ExperienceKind;
  steps: readonly ExperienceStepView[];
  questionnaireOptions: QuestionnaireOption[];
}

export function ExperienceStepsPanel({
  experienceId,
  experienceKind,
  steps,
  questionnaireOptions,
}: ExperienceStepsPanelProps) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ExperienceStepView | null>(null);
  const [deleting, setDeleting] = useState<ExperienceStepView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Move a step one place up or down, then persist the whole resulting order. */
  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;

    const ordered = steps.map((s) => s.id);
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];

    setBusy(true);
    setError(null);
    try {
      await apiClient.patch(API.APP.EXPERIENCES.reorderSteps(experienceId), {
        body: { stepIds: ordered },
      });
      router.refresh();
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Could not reorder the steps. Reload the page and try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.delete(API.APP.EXPERIENCES.step(experienceId, deleting.id));
      setDeleting(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not delete that step.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {experienceKind === 'agentic_switcher'
            ? 'One entry step begins every run. Branch steps are the follow-ups the selector can route into.'
            : 'Each breakout step is a short questionnaire the room runs at the same time.'}
        </p>
        <Button onClick={() => setCreateOpen(true)} disabled={busy}>
          <Plus className="mr-2 h-4 w-4" />
          Add step
        </Button>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      {steps.length === 0 ? (
        <div className="rounded-xl border">
          <ExperienceEmptyState
            icon={<Route className="h-5 w-5" />}
            title="No steps yet"
            body="Start with the entry step — the questionnaire every respondent begins with. Then add the follow-ups this journey can lead to."
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add the first step
              </Button>
            }
          />
        </div>
      ) : (
        <ol className="space-y-2">
          {steps.map((step, index) => (
            <li key={step.id} className="bg-card flex items-start gap-3 rounded-xl border p-3">
              <div className="flex flex-col gap-0.5 pt-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={busy || index === 0}
                  onClick={() => void move(index, -1)}
                  aria-label={`Move ${step.title} up`}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={busy || index === steps.length - 1}
                  onClick={() => void move(index, 1)}
                  aria-label={`Move ${step.title} down`}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{step.title}</span>
                  <StepKindBadge kind={step.kind} />
                  <code className="text-muted-foreground text-xs">{step.key}</code>
                </div>
                <p className="text-muted-foreground text-sm">
                  {step.questionnaireTitle ??
                    (step.questionnaireId ? (
                      <span className="text-destructive">
                        Questionnaire missing — it may have been deleted
                      </span>
                    ) : (
                      'No questionnaire attached'
                    ))}
                  {step.versionNumber !== null && ` · pinned to v${step.versionNumber}`}
                </p>
                {step.selectionCriteria && (
                  <p className="text-muted-foreground text-sm">
                    <span className="font-medium">Choose when:</span> {step.selectionCriteria}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  disabled={busy}
                  onClick={() => setEditing(step)}
                  aria-label={`Edit ${step.title}`}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive h-8 w-8"
                  disabled={busy}
                  onClick={() => setDeleting(step)}
                  aria-label={`Delete ${step.title}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {busy && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Saving…
        </p>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add step</DialogTitle>
            <DialogDescription>
              Attach a questionnaire and say when this step should be used.
            </DialogDescription>
          </DialogHeader>
          <ExperienceStepForm
            experienceId={experienceId}
            experienceKind={experienceKind}
            questionnaireOptions={questionnaireOptions}
            hasEntry={steps.some((s) => s.kind === 'entry')}
            onSuccess={() => setCreateOpen(false)}
            onCancel={() => setCreateOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit step</DialogTitle>
            <DialogDescription>
              Change what this step points at, or when it applies.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <ExperienceStepForm
              experienceId={experienceId}
              experienceKind={experienceKind}
              questionnaireOptions={questionnaireOptions}
              step={editing}
              hasEntry={steps.some((s) => s.kind === 'entry' && s.id !== editing.id)}
              onSuccess={() => setEditing(null)}
              onCancel={() => setEditing(null)}
            />
          )}
          {/* Rooms are edited beside the step rather than inside the form: they are their own
              rows with their own endpoints, and folding them into the step's single submit would
              mean an author loses a half-typed room by cancelling the step edit. */}
          {editing?.kind === 'breakout' && (
            <div className="border-t pt-4">
              <BreakoutRoomsEditor
                experienceId={experienceId}
                stepId={editing.id}
                rooms={editing.rooms ?? []}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The step is removed from this journey. The questionnaire it points at is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                // Keep the dialog mounted while the request is in flight so a failure can be
                // reported in place instead of vanishing with the dialog.
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete step
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
