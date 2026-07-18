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

import { z } from 'zod';

import {
  APP_QUESTIONNAIRE_STATUSES,
  type AppQuestionnaireStatus,
} from '@/lib/app/questionnaire/types';

/** The lineage the confirm dialog names — supplied by the server's 409 details. */
export interface ForkConfirmDetails {
  /** The launched version being edited (the branch source). */
  sourceVersionNumber: number;
  /** The number the new draft will take. */
  nextVersionNumber: number;
  /** Every existing version, newest-first. */
  versions: { versionNumber: number; status: AppQuestionnaireStatus }[];
}

/**
 * Validate the server's 409 `details` before trusting it — it's an API response body, so it goes
 * through Zod rather than a cast (a deploy-skewed server that renamed a field would otherwise feed
 * the dialog `undefined` version numbers silently). Returns null on any mismatch; the caller then
 * surfaces the raw error instead of prompting with a broken dialog.
 */
const forkConfirmDetailsSchema = z.object({
  sourceVersionNumber: z.number(),
  nextVersionNumber: z.number(),
  versions: z.array(
    z.object({ versionNumber: z.number(), status: z.enum(APP_QUESTIONNAIRE_STATUSES) })
  ),
});

export function parseForkConfirmDetails(raw: unknown): ForkConfirmDetails | null {
  const result = forkConfirmDetailsSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * The admin's answer to the fork-confirm dialog. `confirmed` gates the retry; `archiveSource` is the
 * "archive the previous version" checkbox — honoured only when `confirmed` (a cancel archives nothing).
 */
export interface ForkConfirmChoice {
  confirmed: boolean;
  archiveSource: boolean;
}

type Handler = (details: ForkConfirmDetails) => Promise<ForkConfirmChoice>;

let activeHandler: Handler | null = null;

/** Register the provider's confirm handler; returns an unregister for cleanup on unmount. */
export function registerForkConfirmHandler(handler: Handler): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

/**
 * Ask the mounted provider to confirm a fork. Resolves the admin's {@link ForkConfirmChoice}. With no
 * provider mounted we can't prompt, so we resolve `confirmed: false` — nothing forks silently, which
 * is the entire point of the confirmation.
 */
export async function requestForkConfirm(details: ForkConfirmDetails): Promise<ForkConfirmChoice> {
  if (!activeHandler) return { confirmed: false, archiveSource: false };
  return activeHandler(details);
}
