'use client';

/**
 * LaunchedEditConfirmDialog — the pre-save confirmation shown on the Settings tab when the version
 * being edited is **launched**.
 *
 * Editing a launched version never mutates it in place: the server forks a new `draft` and writes
 * the change there (see `_lib/fork.ts`), so the live version — and any in-progress respondent
 * sessions pinned to it — is untouched until the new draft is launched. That fork used to happen
 * silently, surprising admins who expected their setting change to take effect on the running
 * session. This dialog makes the version increment explicit and lets the admin decline before any
 * write is initiated.
 *
 * A draft edit doesn't fork, so this dialog is not shown for drafts — the admin keeps working on the
 * same draft until it's ready to launch.
 */

import type { AppQuestionnaireStatus } from '@/lib/app/questionnaire/types';

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
import { cn } from '@/lib/utils';

/** A version row for the "existing versions" list — the subset the dialog needs. */
export interface ConfirmDialogVersion {
  versionNumber: number;
  status: AppQuestionnaireStatus;
}

export interface LaunchedEditConfirmDialogProps {
  open: boolean;
  /** The launched version being edited — the one the new draft branches from. */
  currentVersionNumber: number;
  /** The number the new draft will take (max existing + 1). */
  nextVersionNumber: number;
  /** Every existing version, newest-first, for the "which versions exist" list. */
  versions: ConfirmDialogVersion[];
  /** Confirm → the save proceeds (the fork happens server-side). */
  onConfirm: () => void;
  /** Cancel (button, Esc, or overlay) → nothing is saved. */
  onCancel: () => void;
}

const STATUS_LABEL: Record<AppQuestionnaireStatus, string> = {
  draft: 'Draft',
  launched: 'Launched',
  archived: 'Archived',
};

export function LaunchedEditConfirmDialog({
  open,
  currentVersionNumber,
  nextVersionNumber,
  versions,
  onConfirm,
  onCancel,
}: LaunchedEditConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Create a new draft version?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Version <strong>v{currentVersionNumber}</strong> is launched, so saving won&rsquo;t
                change the live version. Your changes are saved to a{' '}
                <strong>new draft (v{nextVersionNumber})</strong> that branches from v
                {currentVersionNumber}.
              </p>
              <p>
                In-progress respondent sessions keep running on v{currentVersionNumber}; the new
                settings take effect only after you launch v{nextVersionNumber}.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Existing versions — so the admin can see the lineage and which one they're branching from. */}
        <div className="rounded-md border text-sm">
          <p className="text-muted-foreground border-b px-3 py-2 text-xs font-medium">
            Existing versions
          </p>
          <ul className="divide-y">
            {versions.map((v) => {
              const isSource = v.versionNumber === currentVersionNumber;
              return (
                <li
                  key={v.versionNumber}
                  className={cn(
                    'flex items-center justify-between px-3 py-1.5',
                    isSource && 'bg-amber-50 dark:bg-amber-500/10'
                  )}
                >
                  <span className="font-medium">
                    v{v.versionNumber}
                    {isSource && (
                      <span className="text-muted-foreground ml-1.5 font-normal">
                        · branching from this
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground">{STATUS_LABEL[v.status]}</span>
                </li>
              );
            })}
          </ul>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            Create draft v{nextVersionNumber} &amp; save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
