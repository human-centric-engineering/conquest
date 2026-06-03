/**
 * Read-side view types for the questionnaire admin surface (P2 / F2.1a).
 *
 * The shapes the list/detail GET endpoints return and the admin UI consumes. Kept
 * **pure types, client-safe** (no Prisma, no Next, no server-only imports) so both
 * the route serializers and the `'use client'` table/detail components import the
 * same contract. Dates are serialised as ISO strings — these cross the HTTP
 * boundary, so there are no `Date` objects here.
 *
 * Distinct from `AppQuestionnaire*` Prisma rows: those carry storage detail (FKs,
 * raw JSON, `bytes`); these are the trimmed, enriched projections the UI needs.
 */

import type {
  AppQuestionnaireStatus,
  AudienceProvenance,
  AudienceShape,
  FieldProvenance,
  QuestionType,
  TagColor,
} from '@/lib/app/questionnaire/types';
// DEMO-ONLY (F2.5.1): attribution summary embedded in list/detail rows.
import type { AttributedDemoClient } from '@/lib/app/questionnaire/demo-clients';

/** A vocabulary tag (F2.2) — client-safe projection of `AppQuestionTag`. */
export interface TagView {
  id: string;
  label: string;
  /** Swatch from the `TAG_COLORS` allowlist, or `null` when uncoloured. */
  color: TagColor | null;
}

/** One row in the admin questionnaires list — enriched with latest-version counts. */
export interface QuestionnaireListItem {
  id: string;
  title: string;
  status: AppQuestionnaireStatus;
  /** Total versions on this questionnaire. */
  versionCount: number;
  /** The highest-numbered version (the one the list summarises), or null if none. */
  latestVersion: {
    id: string;
    versionNumber: number;
    status: AppQuestionnaireStatus;
  } | null;
  /** Section / question counts for the latest version (0 when no version yet). */
  sectionCount: number;
  questionCount: number;
  /** DEMO-ONLY (F2.5.1): the attributed demo client, or null for a generic Sunrise demo. */
  demoClient: AttributedDemoClient | null;
  createdAt: string;
  /** Last activity — the questionnaire row's `updatedAt`. */
  updatedAt: string;
}

/** A version summary in the questionnaire detail view (no full graph). */
export interface QuestionnaireVersionSummary {
  id: string;
  versionNumber: number;
  status: AppQuestionnaireStatus;
  goal: string | null;
  audience: AudienceShape | null;
  sectionCount: number;
  questionCount: number;
  /** Applied (not-yet-reverted) extraction-change records on this version. */
  changeCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The questionnaire detail payload — the questionnaire plus its version list. */
export interface QuestionnaireDetail {
  id: string;
  title: string;
  status: AppQuestionnaireStatus;
  /** DEMO-ONLY (F2.5.1): the attributed demo client, or null for a generic Sunrise demo. */
  demoClient: AttributedDemoClient | null;
  createdAt: string;
  updatedAt: string;
  /** Versions newest-first (highest `versionNumber` first). */
  versions: QuestionnaireVersionSummary[];
}

/** A single question in the version graph. */
export interface QuestionSlotView {
  id: string;
  ordinal: number;
  key: string;
  prompt: string;
  guidelines: string | null;
  rationale: string | null;
  type: QuestionType;
  typeConfig: unknown;
  required: boolean;
  weight: number;
  extractionConfidence: number | null;
  /** Tags assigned to this question, ordered by normalised label. */
  tags: TagView[];
}

/** A section (with its questions) in the version graph. */
export interface SectionView {
  id: string;
  ordinal: number;
  title: string;
  description: string | null;
  questions: QuestionSlotView[];
}

/** The full structural graph of one version — sections → questions + goal/audience. */
export interface VersionGraphView {
  id: string;
  questionnaireId: string;
  versionNumber: number;
  status: AppQuestionnaireStatus;
  goal: string | null;
  audience: AudienceShape | null;
  /**
   * Stored per-field provenance from the ingest merge. `goalProvenance` is the
   * goal's source (`null` when no goal); `audienceProvenance` has one entry per
   * resolved audience field. The UI marks a value "inferred" when its provenance
   * is `'inferred'`. Read straight from the version columns — no derivation.
   */
  goalProvenance: FieldProvenance | null;
  audienceProvenance: AudienceProvenance | null;
  sections: SectionView[];
  /** The version's tag vocabulary (F2.2), ordered by normalised label. */
  tags: TagView[];
}
