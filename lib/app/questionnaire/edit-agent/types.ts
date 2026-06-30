/**
 * Shared shapes for the Structure Edit Agent (precise, instruction-driven editing).
 *
 * `EditableStructure` is the in-memory representation the deterministic executor manipulates: it
 * carries the entity **ids** (so apply can issue granular updates), the current `required`/`weight`
 * (so the preview can show before→after and apply preserves untouched fields), and the ordinals
 * (so renumber/reorder/move are expressible). It is intentionally richer than the refine flow's
 * `ComposeStructure`, which is id-less and drops `required`/`weight`.
 *
 * Pure types — no Prisma, no IO. Safe to import anywhere (incl. the client preview renderer).
 */

import type { QuestionType } from '@/lib/app/questionnaire/types';

export interface EditableQuestion {
  id: string;
  /** Stable per-version slug — how an op targets a single question. */
  key: string;
  /** 0-based position within its section. */
  ordinal: number;
  prompt: string;
  type: QuestionType;
  required: boolean;
  weight: number;
}

export interface EditableSection {
  id: string;
  /** 0-based position within the version. */
  ordinal: number;
  title: string;
  description: string | null;
  questions: EditableQuestion[];
}

export interface EditableStructure {
  versionId: string;
  sections: EditableSection[];
}

/** Which field a single resolved change touches. */
export type ChangeField =
  | 'section.title'
  | 'section.ordinal'
  | 'question.prompt'
  | 'question.required'
  | 'question.weight'
  | 'question.ordinal'
  | 'question.section';

/**
 * One concrete, apply-executable change. Produced by diffing the desired structure against the
 * current one; drives both the preview (via `label` + `before`/`after`) and the apply transaction
 * (via `entityId` + `field` + the typed values). `before`/`after` are display strings; the typed
 * value needed to write is carried in `value` (and `toSectionId` for a move).
 */
export interface ResolvedChange {
  entity: 'section' | 'question';
  entityId: string;
  /** Present for question changes — the slug shown in the preview. */
  key?: string;
  /** Human label for the affected entity (section title / question prompt, truncated). */
  label: string;
  field: ChangeField;
  before: string;
  after: string;
  /** The typed value apply writes (string for title/prompt, number for ordinal/weight, boolean for required). */
  value: string | number | boolean;
  /** For a `question.section` move only — the destination section id. */
  toSectionId?: string;
}
