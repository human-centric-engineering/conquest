'use client';

/**
 * ForkConfirmProvider — mounts once in the questionnaire workspace layout and renders the single
 * `LaunchedEditConfirmDialog` for the whole workspace.
 *
 * It registers a handler on the {@link registerForkConfirmHandler} bridge, so when any authoring
 * mutation hits the server's fork-confirmation 409 (see `fork-confirm-bridge.ts`), `authoringMutate`
 * calls through to this provider, which opens the dialog and resolves the awaiting mutation with the
 * admin's choice. One dialog, every tab (Structure, Settings, respondent report, reingest, …) — no
 * per-surface wiring.
 */

import { useEffect, useRef, useState } from 'react';

import {
  registerForkConfirmHandler,
  type ForkConfirmDetails,
} from '@/components/admin/questionnaires/fork-confirm-bridge';
import { LaunchedEditConfirmDialog } from '@/components/admin/questionnaires/launched-edit-confirm-dialog';

export function ForkConfirmProvider({ children }: { children: React.ReactNode }) {
  const [details, setDetails] = useState<ForkConfirmDetails | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  useEffect(() => {
    const unregister = registerForkConfirmHandler(
      (next) =>
        new Promise<boolean>((resolve) => {
          // Only one dialog can be shown at a time. If a second forking edit lands while a
          // confirmation is already open (co-mounted runners saving near-simultaneously), decline
          // the newcomer rather than overwrite the pending resolver — otherwise the first mutation's
          // promise never settles and its runner's busy lock sticks forever.
          if (resolveRef.current) {
            resolve(false);
            return;
          }
          resolveRef.current = resolve;
          setDetails(next);
        })
    );
    return () => {
      unregister();
      // Provider unmounting (e.g. navigation) with a dialog still open → settle the awaiting
      // mutation as cancelled so it unwinds instead of hanging with busy locked.
      resolveRef.current?.(false);
      resolveRef.current = null;
    };
  }, []);

  const settle = (confirmed: boolean) => {
    setDetails(null);
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(confirmed);
  };

  return (
    <>
      {children}
      {details && (
        <LaunchedEditConfirmDialog
          open
          currentVersionNumber={details.sourceVersionNumber}
          nextVersionNumber={details.nextVersionNumber}
          versions={details.versions}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </>
  );
}
