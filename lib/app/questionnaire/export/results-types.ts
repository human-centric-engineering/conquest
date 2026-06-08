/**
 * Record-level result export — model types (F8.2).
 *
 * The shape the multi-session export loader produces and the CSV / JSON serialisers
 * consume. Pure and client-safe (no Prisma, no Next) — dates cross as ISO strings, the
 * answer `value` stays the raw stored Json. Sibling to the F8.1 aggregate `views`: that
 * surface is counts-only by design; this one is the record-level companion, so it must
 * honour the anonymous-mode contract itself.
 *
 * Anonymous-mode contract (resolved in the loader, not here):
 *   - `respondentName` is null on every session.
 *   - `turns` is `[]` on every session — raw respondent prose never reaches the export.
 * Answer *values* are always present in both formats: anonymity is about not linking
 * data to a person, not redacting the survey data itself (mirrors the PDF export).
 */

import type { AnalyticsRange } from '@/lib/app/questionnaire/analytics';
import type { AnswerProvenance, QuestionType, SessionStatus } from '@/lib/app/questionnaire/types';
import type { PanelRefinementEntry } from '@/lib/app/questionnaire/panel/types';

/** One question column in the export, in display order (section ordinal → slot ordinal). */
export interface ExportQuestion {
  questionId: string;
  key: string;
  prompt: string;
  type: QuestionType;
  sectionTitle: string;
  required: boolean;
}

/** One captured answer within a session, keyed back to its question slot. */
export interface ExportAnswer {
  questionKey: string;
  /** Raw stored value — string | number | boolean | string[] | object. */
  value: unknown;
  confidence: number | null;
  provenanceLabel: AnswerProvenance;
  /** Sunrise `ProvenanceItem[]` (reserved; not populated by the current write path). */
  provenanceItems: unknown;
  rationale: string | null;
  refinementHistory: PanelRefinementEntry[];
  /** 1-based ordinal of the turn that last captured this slot, or null when unmapped. */
  lastUpdatedTurnOrdinal: number | null;
}

/** One persisted respondent turn. Omitted entirely (empty array) in anonymous mode. */
export interface ExportTurn {
  ordinal: number;
  userMessage: string;
  agentResponse: string;
  targetedQuestionId: string | null;
  /** Ordered capability outcomes — `[{ slug, success, code?, latencyMs? }]`. */
  toolCalls: unknown;
  /** `AppAnswerSlot.id[]` this turn created/updated. */
  sideEffectAnswerIds: unknown;
  costUsd: number | null;
  createdAt: string;
}

/** One completed session's full record. */
export interface ExportSession {
  id: string;
  status: SessionStatus;
  createdAt: string;
  completedAt: string | null;
  /** Null when the version is anonymous or the respondent is unknown. */
  respondentName: string | null;
  answers: ExportAnswer[];
  /** Empty in anonymous mode. */
  turns: ExportTurn[];
}

/** The full export payload — questions (columns) + completed sessions (rows). */
export interface ResultsExportModel {
  versionId: string;
  versionNumber: number;
  questionnaireTitle: string;
  range: AnalyticsRange;
  /** The version's `anonymousMode` flag, echoed so consumers can label the export. */
  anonymous: boolean;
  /** True when more completed sessions matched than the export cap returned. */
  capped: boolean;
  questions: ExportQuestion[];
  sessions: ExportSession[];
}
