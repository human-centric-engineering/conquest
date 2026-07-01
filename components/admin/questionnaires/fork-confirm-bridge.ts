/**
 * Fork-confirmation bridge — connects the plain-function `authoringMutate` to the React
 * `ForkConfirmProvider` without a prop drill.
 *
 * Editing a launched version forks a new draft server-side; the server answers an unconfirmed edit
 * with a 409 (`VERSION_FORK_CONFIRMATION_REQUIRED`). `authoringMutate` — a module function, not a
 * component — can't render a dialog, so it calls {@link requestForkConfirm}, which defers to the
 * handler the mounted provider registered. This is the single choke point: every authoring mutation
 * (Structure, Settings, respondent report, reingest, data slots, …) flows through `authoringMutate`,
 * so all of them get the confirmation for free, including any added later.
 */

import type { AppQuestionnaireStatus } from '@/lib/app/questionnaire/types';

/** The lineage the confirm dialog names — supplied by the server's 409 details. */
export interface ForkConfirmDetails {
  /** The launched version being edited (the branch source). */
  sourceVersionNumber: number;
  /** The number the new draft will take. */
  nextVersionNumber: number;
  /** Every existing version, newest-first. */
  versions: { versionNumber: number; status: AppQuestionnaireStatus }[];
}

type Handler = (details: ForkConfirmDetails) => Promise<boolean>;

let activeHandler: Handler | null = null;

/** Register the provider's confirm handler; returns an unregister for cleanup on unmount. */
export function registerForkConfirmHandler(handler: Handler): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

/**
 * Ask the mounted provider to confirm a fork. Resolves `true` (proceed) / `false` (cancel). With no
 * provider mounted we can't prompt, so we resolve `false` — nothing forks silently, which is the
 * entire point of the confirmation.
 */
export async function requestForkConfirm(details: ForkConfirmDetails): Promise<boolean> {
  if (!activeHandler) return false;
  return activeHandler(details);
}
