/**
 * Progress events for the streaming (map-reduce) data-slot generator.
 *
 * Pure types only (no runtime deps) so BOTH the server orchestrator
 * (`generate-stream.ts`) and the admin client can import them — the client must
 * not pull the orchestrator's LLM/provider imports into its bundle.
 *
 * Lifecycle: `start` → (`group_done` | `group_error`)* → [`merge_start`,
 * `merge_warning`?] → (`done` | `error`). `done` is emitted by the route after it
 * persists the draft; the orchestrator itself emits everything up to that point and
 * emits `error` on a fatal pre-flight failure (e.g. no provider).
 */

import type { GeneratedDataSlot } from '@/lib/app/questionnaire/data-slots/views';

/** A section/chunk the generator fans out over, as advertised in the `start` event. */
export interface DataSlotGenGroupInfo {
  index: number;
  title: string;
  questionCount: number;
}

export type DataSlotGenEvent =
  | { type: 'start'; totalQuestions: number; groups: DataSlotGenGroupInfo[] }
  | { type: 'group_done'; index: number; title: string; slots: GeneratedDataSlot[] }
  | { type: 'group_error'; index: number; title: string; message: string }
  | { type: 'merge_start'; rawSlotCount: number }
  | { type: 'merge_warning'; message: string }
  | { type: 'done'; slots: GeneratedDataSlot[]; persisted: boolean }
  | { type: 'error'; code: string; message: string };

/** Narrowing helper used by the SSE-frame parser on the client. */
export const DATA_SLOT_GEN_EVENT_TYPES = [
  'start',
  'group_done',
  'group_error',
  'merge_start',
  'merge_warning',
  'done',
  'error',
] as const;
