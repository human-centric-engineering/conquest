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
export type MutationSpec = ['POST' | 'PATCH' | 'DELETE', string, unknown];

/** Run a mutation described by the thunk. Fire-and-forget from the caller's view. */
export type RunMutation = (spec: () => MutationSpec) => void;
