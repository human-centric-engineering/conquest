/**
 * Shared types for the questionnaire editor components (F2.1 / PR2).
 *
 * `RunMutation` is the single mutation entry point threaded from the orchestrator
 * (`version-editor.tsx`) down to section/question rows. A caller hands it a thunk
 * returning `[method, path, body]`; the orchestrator runs it through
 * `authoringMutate`, surfaces errors, applies the fork notice + redirect, and
 * refetches. Kept in its own module so leaf components don't import the
 * orchestrator (avoids a client component cycle).
 */

/** A pending mutation described as `[method, path, body]`. */
export type MutationSpec = ['POST' | 'PUT' | 'PATCH' | 'DELETE', string, unknown];

/**
 * Re-exported from the shared view types so editor components can keep importing it from here (the
 * composer fills it into a highlighted new-question form). See {@link EvaluationSeed} for the shape.
 */
export type { EvaluationSeed } from '@/lib/app/questionnaire/views';

/**
 * Run a mutation described by the thunk. Resolves `true` on success and `false` on
 * failure (the runner surfaces the error itself). Fire-and-forget callers can ignore
 * the result; save buttons await it to flash a "Saved" confirmation only on success.
 */
export type RunMutation = (spec: () => MutationSpec) => Promise<boolean>;
