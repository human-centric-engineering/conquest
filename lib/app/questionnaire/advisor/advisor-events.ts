/**
 * Progress events for the streaming Config Advisor.
 *
 * Pure types only (no runtime deps) so BOTH the server orchestrator (`stream-advisor.ts`) and the
 * admin client can import them — the client must not pull the orchestrator's LLM/provider imports
 * into its bundle. Mirrors the composer's `compose-events.ts`.
 *
 * Lifecycle: (`narrative_delta`)* → `narrative_done` → `analysis` → `done`, OR a terminal `error`
 * at any point. The narrative streams token-by-token; the structured analysis (conflicts +
 * suggestions) arrives in one `analysis` event after the narrative settles. `done` is emitted by
 * the route once the run finishes (nothing is persisted — the advisor is ephemeral).
 */

import type {
  AdvisorConflict,
  AdvisorSuggestion,
} from '@/lib/app/questionnaire/advisor/advisor-schema';

export type AdvisorGenEvent =
  | { type: 'narrative_delta'; text: string }
  | { type: 'narrative_done' }
  | { type: 'analysis'; conflicts: AdvisorConflict[]; suggestions: AdvisorSuggestion[] }
  | { type: 'done' }
  | { type: 'error'; code: string; message: string };

/** Narrowing helper for the SSE-frame parser on the client. */
export const ADVISOR_GEN_EVENT_TYPES = [
  'narrative_delta',
  'narrative_done',
  'analysis',
  'done',
  'error',
] as const;
