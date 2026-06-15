/**
 * Progress events for the streaming (two-phase) questionnaire composer.
 *
 * Pure types only (no runtime deps) so BOTH the server orchestrator
 * (`stream-compose.ts`) and the admin client can import them — the client must not
 * pull the orchestrator's LLM/provider imports into its bundle. Mirrors the
 * data-slot generator's `generation-events.ts`.
 *
 * Lifecycle: `outline` → (`section_done` | `section_error`)* → (`done` | `error`).
 * `done` is emitted by the route after it persists the new questionnaire+version
 * (so it carries the new ids); the orchestrator itself emits everything up to that
 * point and emits `error` on a fatal failure (no provider, outline failed).
 */

import type {
  ExtractedQuestion,
  ExtractedSection,
} from '@/lib/app/questionnaire/ingestion/extraction-schema';
import type { AudienceShape } from '@/lib/app/questionnaire/types';

/** A section advertised in the `outline` event (before its questions are written). */
export type ComposeGenSectionInfo = ExtractedSection;

export type ComposeGenEvent =
  | {
      type: 'outline';
      sections: ComposeGenSectionInfo[];
      goal?: string;
      audience?: Partial<AudienceShape>;
    }
  | { type: 'section_done'; ordinal: number; title: string; questions: ExtractedQuestion[] }
  | { type: 'section_error'; ordinal: number; title: string; message: string }
  | {
      type: 'done';
      questionnaireId: string;
      versionId: string;
      sectionCount: number;
      questionCount: number;
    }
  | { type: 'error'; code: string; message: string };

/** Narrowing helper used by the SSE-frame parser on the client. */
export const COMPOSE_GEN_EVENT_TYPES = [
  'outline',
  'section_done',
  'section_error',
  'done',
  'error',
] as const;
